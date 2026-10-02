// Loading an admitted build (PT15, PF8.1, S126). The runtime reads only public keys. It reads each certified
// artefact once, checks the bytes against the certificate and the certificate against a trusted signature, writes
// the verified bytes to a directory named by the build id, and registers polyrun's machines from that copy, so
// the bytes polyrun loads are the bytes checked. Any difference refuses the load, naming the artefact and both
// digests. A manifest entry without its retry bound is refused too (S120).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { actionTypes, type TypeNode } from './types.js';
import { CERTIFIED_ARTEFACTS, certificateProblems, sha256OfBytes, parseManifest, keyringsOf, sameKeyrings, EMPTY_KEYRINGS, type Certificate, type CertificateProblem } from '@poly/core';

export class LoadError extends Error {
  constructor(message: string, readonly problems: CertificateProblem[] = []) { super(message); this.name = 'LoadError'; }
}

export interface VerifiedBuild {
  certificate: Certificate;
  /** The project root the certificate's paths are relative to. */
  root: string;
  /** Where the verified copy lives: one directory per machine, as in the build. */
  runDir: string;
  machines: { id: string; module: string; contract?: string; effects?: { mapper: string; manifest: string }; manifest: { effects?: Record<string, any> } | null; types: Map<string, [string, TypeNode][]> }[];
  /** S142: each certified handler file (poly.json's), by its certified path, at its verified copy. */
  handlers: Map<string, string>;
  /** PT8, PT9: each trust scope's certified policy document, from the verified bytes, and the machines it reads. */
  policies: { scope: string; policies: string[]; doc: Record<string, unknown>; reads: string[] }[];
}

/** `load('./.poly/build', …)` (PT15) names the build; the certificate's paths are relative to the project above it. */
export function projectRootOf(buildDir: string): string {
  const abs = resolve(buildDir);
  return basename(abs) === 'build' && basename(dirname(abs)) === '.poly' ? dirname(dirname(abs)) : abs;
}

export function verifyBuild(buildDir: string, certificatePath: string, trust: Record<string, string>, opts: { allowWitness?: boolean } = {}): VerifiedBuild {
  const root = projectRootOf(buildDir);
  if (!existsSync(certificatePath)) throw new LoadError(`no certificate at ${certificatePath}: the runtime loads only admitted programs (PF8.1)`);
  let certificate: Certificate;
  try { certificate = JSON.parse(readFileSync(certificatePath, 'utf8')) as Certificate; } catch (e) { throw new LoadError(`the certificate at ${certificatePath} is not JSON: ${(e as Error).message}`); }
  if (!certificate?.subject?.machines || !Array.isArray(certificate.subject.machines)) throw new LoadError('the certificate names no machines');
  // S139: a witness certificate admits a program with findings, for its exported tests only.
  if (opts.allowWitness && process.env.NODE_ENV === 'production') throw new LoadError('allowWitness is refused in production: a witness certificate admits a program with findings (S139)');
  if (certificate.purpose === 'witness' && !opts.allowWitness) throw new LoadError(`refused at load: ${certificatePath} is a witness certificate, for a program with ${certificate.findings?.length ?? 0} finding(s); only an exported witness test loads it, with allowWitness (S139)`);
  if (certificate.purpose !== undefined && certificate.purpose !== 'witness') throw new LoadError(`refused at load: unknown certificate purpose ${JSON.stringify(certificate.purpose)}`);

  // Read once: these bytes are hashed, compared, and copied; nothing is read from the build again.
  const bytes = new Map<string, Buffer>();
  for (const m of certificate.subject.machines) {
    for (const name of CERTIFIED_ARTEFACTS) {
      const p = join(root, m.dir, name);
      if (existsSync(p)) bytes.set(`${m.dir}/${name}`, readFileSync(p));
    }
  }
  // PT8: each scope's lowered policy, read once like any artefact.
  for (const p of certificate.poly?.policies ?? []) {
    const f = join(root, p.path);
    if (existsSync(f)) bytes.set(p.path, readFileSync(f));
  }
  const actual = Object.fromEntries([...bytes].map(([k, b]) => [k, sha256OfBytes(b)]));
  const problems = certificateProblems(certificate, actual, trust);
  if (problems.length) {
    throw new LoadError(`refused at load: ${problems.map((p) => `${p.name}: ${p.problem}${p.want || p.have ? ` (certified ${p.want ?? 'nothing'}, found ${p.have ?? 'nothing'})` : ''}`).join('; ')}`, problems);
  }

  // S142: the handlers, hash first. Each certified file is read once; a missing or changed file, or a changed
  // lockfile, refuses the load. The verified bytes are copied beside the artefacts, and the runtime imports the copy.
  const h = certificate.poly?.handlers;
  if (!h || h.files === null || typeof h.files !== 'object' || Array.isArray(h.files) || !Array.isArray(h.roots)) throw new LoadError('refused at load: PL6403 HANDLER_CHANGED: the certificate binds no handlers; it predates S142, so admit the program again');
  const handlerBytes = new Map<string, Buffer>();
  const changed: string[] = [];
  for (const [p, want] of Object.entries(h.files)) {
    const f = join(root, p);
    const b = existsSync(f) ? readFileSync(f) : null;
    if (!b) { changed.push(`${p} is missing (certified ${want})`); continue; }
    const have = sha256OfBytes(b);
    if (have !== want) { changed.push(`${p} is not the certified handler (certified ${want}, found ${have})`); continue; }
    handlerBytes.set(p, b);
  }
  // S154: and every certified file of an installed package.
  const packageBytes = new Map<string, Buffer>();
  for (const [p, want] of Object.entries(h.packageFiles ?? {})) {
    const f = join(root, p);
    const b = existsSync(f) ? readFileSync(f) : null;
    const have = b ? sha256OfBytes(b) : null;
    if (have !== want) changed.push(`${p} is not the certified package file (certified ${want}, found ${have ?? 'nothing'})`);
    else if (!p.startsWith('../')) packageBytes.set(p, b!);
  }
  if (h.lockfile) {
    const f = join(root, h.lockfile.path);
    const have = existsSync(f) ? sha256OfBytes(readFileSync(f)) : null;
    if (have !== h.lockfile.digest) changed.push(`the lockfile ${h.lockfile.path} is not the certified one (certified ${h.lockfile.digest}, found ${have ?? 'nothing'})`);
  }
  if (changed.length) throw new LoadError(`refused at load: PL6403 HANDLER_CHANGED: ${changed.join('; ')} (S142)`);

  // S150: the keyrings that sign approvals and acceptances are the certified ones; a change needs re-admission.
  const ring = certificate.poly?.keyrings;
  if (!ring || !Array.isArray(ring.people) || !Array.isArray(ring.agents)) throw new LoadError('refused at load: PL6405 KEYRING_CHANGED: the certificate binds no keyrings; it predates S150, so admit the program again');
  const manifestPath = join(root, 'poly.json');
  let current;
  try { current = existsSync(manifestPath) ? keyringsOf(root, parseManifest(readFileSync(manifestPath, 'utf8'), manifestPath)) : EMPTY_KEYRINGS; } catch (e) { throw new LoadError(`refused at load: PL6405 KEYRING_CHANGED: the keyrings cannot be read: ${(e as Error).message}`); }
  if (!sameKeyrings(ring, current)) throw new LoadError('refused at load: PL6405 KEYRING_CHANGED: the people or agents keyring in poly.json differs from the certified one; a keyring change needs re-admission (S150)');

  const runDir = join(root, '.poly', 'run', certificate.buildId);
  const handlers = new Map<string, string>();
  for (const [p, b] of handlerBytes) {
    const copy = join(runDir, 'handlers', ...p.split('/'));
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, b);
    if (h.roots.includes(p)) handlers.set(p, copy);
  }
  // Review D-F4: the runtime imports the copy, so a bare import resolves from there. The certified package files inside
  // the project are copied beside it as they sit beside the handlers, so the package that runs is the certified one.
  for (const [p, b] of packageBytes) {
    const copy = join(runDir, 'handlers', ...p.split('/'));
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, b);
  }
  const machines: VerifiedBuild['machines'] = [];
  for (const m of certificate.subject.machines) {
    const dir = join(runDir, m.id);
    mkdirSync(dir, { recursive: true });
    for (const name of CERTIFIED_ARTEFACTS) {
      const b = bytes.get(`${m.dir}/${name}`);
      if (b) writeFileSync(join(dir, name), b);
    }
    const manifestBytes = bytes.get(`${m.dir}/effects.manifest.json`);
    const manifest = manifestBytes ? JSON.parse(manifestBytes.toString('utf8')) as { effects?: Record<string, any> } : null;
    for (const [kind, entry] of Object.entries(manifest?.effects ?? {})) {
      if (!Number.isInteger(entry?.retry?.maxAttempts)) throw new LoadError(`${m.id} ${kind}: the manifest declares no retry.maxAttempts; the outbox machine is checked at a declared bound (S120)`);
    }
    // S140: each action's type, as the certified contract states it; a type the runtime cannot read refuses the load.
    let types: Map<string, [string, TypeNode][]>;
    try { types = actionTypes(JSON.parse((bytes.get(`${m.dir}/contract.json`) ?? Buffer.from('{}')).toString('utf8'))); } catch (e) { throw new LoadError(`${m.id}: the contract states a type the runtime cannot read: ${(e as Error).message}`); }
    machines.push({
      id: m.id,
      types,
      module: join(dir, 'next.cjs'),
      ...(bytes.has(`${m.dir}/contract.json`) ? { contract: join(dir, 'contract.json') } : {}),
      ...(bytes.has(`${m.dir}/effects.cjs`) && manifestBytes ? { effects: { mapper: join(dir, 'effects.cjs'), manifest: join(dir, 'effects.manifest.json') } } : {}),
      manifest,
    });
  }
  const policies = (certificate.poly?.policies ?? []).map((p) => ({ scope: p.scope, policies: p.policies, reads: p.reads, doc: JSON.parse(bytes.get(p.path)!.toString('utf8')) as Record<string, unknown> }));
  return { certificate, root, runDir, machines, handlers, policies };
}

/** After registration: the copy polyrun read is still the certified bytes (a check of the copy, not of the build). */
export function recheckCopy(v: VerifiedBuild): void {
  for (const m of v.certificate.subject.machines) {
    for (const name of CERTIFIED_ARTEFACTS) {
      const want = v.certificate.artefacts[`${m.dir}/${name}`];
      if (!want) continue;
      const have = sha256OfBytes(readFileSync(join(v.runDir, m.id, name)));
      if (have !== want) throw new LoadError(`refused at load: the verified copy of ${m.dir}/${name} changed before it was registered (certified ${want}, found ${have})`);
    }
  }
  // S154: and the package copies.
  for (const [p, want] of Object.entries(v.certificate.poly.handlers.packageFiles ?? {})) {
    if (p.startsWith('../')) continue;
    const have = sha256OfBytes(readFileSync(join(v.runDir, 'handlers', ...p.split('/'))));
    if (have !== want) throw new LoadError(`refused at load: PL6403 HANDLER_CHANGED: the verified copy of ${p} changed before it was imported (certified ${want}, found ${have})`);
  }
  // S142: the handler copies too, before the runtime imports them.
  for (const [p, want] of Object.entries(v.certificate.poly.handlers.files)) {
    const have = sha256OfBytes(readFileSync(join(v.runDir, 'handlers', ...p.split('/'))));
    if (have !== want) throw new LoadError(`refused at load: PL6403 HANDLER_CHANGED: the verified copy of ${p} changed before it was imported (certified ${want}, found ${have})`);
  }
}
