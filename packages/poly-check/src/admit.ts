// `poly admit` (PT14, PT15, S126): check a project, and when it is CLEAN, write and sign its certificate.
//
// In M4 only a CLEAN program is admitted: accepting a finding needs a person's signature (PT12.5), which is M5's.
// The admission key is found by location (`env:NAME` or `file:PATH`), never committed, and a key file inside a
// version-controlled tree is refused. The certificate is written to a temporary name, read back against the
// files it describes and the signature it carries, and only then renamed into place: a certificate that does not
// read back is a toolchain fault, and nothing is left behind (the standing rule on artefacts the runtime reads).
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import {
  CERTIFIED_ARTEFACTS, sha256OfBytes, certificateDigest, buildIdOf, signDigest, publicKeyOf, certificateProblems,
  loadProject, type Certificate, type CertifiedMachine,
} from '@poly/core';
import type * as A from '@poly/core';
import { parse } from '@poly/lang';
import { readEmbedded } from '@poly/embed';
import { checkProject, type ProjectReport } from './pipeline.js';

export class AdmitError extends Error {
  constructor(message: string) { super(message); this.name = 'AdmitError'; }
}

/** Deliberately broken certificate writers, for the read-back's test only (test/toolchain-faults.mjs). */
export const CERTIFICATE_FAULTS = ['omit-artefact', 'stale-artefact-digest', 'digest-before-limits', 'sign-wrong-message'] as const;
export type CertificateFault = (typeof CERTIFICATE_FAULTS)[number];

/** PT19, S120, S137: the most attempts a manifest entry may declare. */
export const MAX_ATTEMPTS = 10;

/** The limits every M4 build states with its verdicts (S118, S134, S135). */
export const M4_LIMITS = [
  'escalation approvals are recorded API calls without a person-key signature until PT12.5 (M5, S118)',
  'handlers receive no capabilities; capabilities are not bound until M5 (S134)',
  'the store is SQLite only; Postgres is not built (S135)',
];

export interface AdmitOptions {
  /** The admission key, when it is not named in poly.json. */
  key?: { id: string; privateKeyPem: string };
  now?: () => Date;
  fault?: CertificateFault;
}

export interface AdmitResult {
  verdict: 'CLEAN';
  certificatePath: string;
  certificate: Certificate;
  /** Every certified path's digest, as read from disk. */
  artefacts: Record<string, string>;
  report: ProjectReport;
}

const rel = (root: string, p: string) => relative(root, p).split(sep).join('/');

/** A key file inside a version-controlled tree could be committed; it is refused whatever it holds (S126). */
function insideVersionControl(file: string): boolean {
  for (let d = dirname(resolve(file)); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

function admissionKey(dir: string, named: { id: string; location: string } | undefined, given: AdmitOptions['key']): { id: string; privateKeyPem: string } {
  if (given) return given;
  if (!named) throw new AdmitError('no admission key: poly.json names none under keys.admission (S126)');
  const [scheme, ...rest] = named.location.split(':');
  const where = rest.join(':');
  if (scheme === 'env') {
    const pem = process.env[where];
    if (!pem) throw new AdmitError(`the admission key ${named.id} is at env:${where}, which is not set`);
    return { id: named.id, privateKeyPem: pem };
  }
  const file = isAbsolute(where) ? where : join(dir, where);
  if (insideVersionControl(file)) throw new AdmitError(`the admission key ${named.id} is at ${file}, inside a tree under version control; a private key is never committed (S126)`);
  if (!existsSync(file)) throw new AdmitError(`the admission key ${named.id} is at ${file}, which does not exist`);
  return { id: named.id, privateKeyPem: readFileSync(file, 'utf8') };
}

/** The certified files of each machine's build directory, by path relative to the project root. */
function artefactsOf(root: string, machines: CertifiedMachine[], fault?: CertificateFault): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of machines) {
    for (const name of CERTIFIED_ARTEFACTS) {
      const p = join(root, m.dir, name);
      if (existsSync(p)) out[`${m.dir}/${name}`] = sha256OfBytes(readFileSync(p));
    }
  }
  if (fault === 'omit-artefact') delete out[Object.keys(out)[0]];
  if (fault === 'stale-artefact-digest') { const k = Object.keys(out)[0]; out[k] = sha256OfBytes(k); }
  return out;
}

/** What the runtime reads, re-read from disk: every certified name in every machine directory. */
export function artefactsOnDisk(root: string, machines: CertifiedMachine[]): Record<string, string> {
  return artefactsOf(root, machines);
}

function moduleOf(file: string): A.Module | null {
  const text = readFileSync(file, 'utf8');
  return (file.endsWith('.ts') ? readEmbedded(text, file) : parse(text)).module;
}

export async function admit(target: string, opts: AdmitOptions = {}): Promise<AdmitResult> {
  const dir = resolve(target);
  const { manifest, files } = loadProject(dir);
  const key = admissionKey(dir, manifest.keys?.admission, opts.key);
  // A failed admission leaves no certificate: an old one would describe a build this check is about to replace.
  rmSync(join(dir, '.poly', 'certificate.json'), { force: true });
  const report = await checkProject(dir, { root: dir });
  if (report.verdict !== 'CLEAN') {
    throw new AdmitError(`not admitted: the verdict is ${report.verdict}; in M4 only a CLEAN program is admitted, since accepting a finding needs a person's signature (PT12.5, S126)`);
  }

  // PT6.5, S72: the lint over handler modules is part of admission; a project with effects whose lint did not run is not admitted.
  if (report.handlers?.status === 'not-run') throw new AdmitError(`not admitted: the handler lint did not run (${report.handlers.reason})`);

  const machines: CertifiedMachine[] = [];
  const instances: Record<string, unknown> = {};
  const domains: Record<string, string[]> = {};
  const checks: Certificate['checks'] = [];
  const guarantees: string[] = [];
  const kernel = new Set<string>();
  const decisions: Certificate['poly']['decisions'] = [];
  const moduleDigests: Record<string, string> = {};
  for (const r of report.files) {
    if (!r.module || !r.moduleDigest) throw new AdmitError(`${r.file}: no module digest`);
    moduleDigests[r.module] = r.moduleDigest;
    const ast = moduleOf(r.file);
    for (const m of r.machines) {
      if (!m.buildDir || !m.instance) throw new AdmitError(`${r.module}.${m.machine}: checked without a build`);
      const id = `${r.module}.${m.machine}`;
      machines.push({ id, module: r.module, machine: m.machine, dir: rel(dir, m.buildDir) });
      instances[id] = m.instance;
      domains[id] = m.instance.domains;
      for (const k of m.instance.kernelAssumptions) kernel.add(k);
      for (const s of m.stages) if (s.status === 'ran') checks.push({ name: `${id}:${s.stage}`, ok: true, engine: s.engine, verdict: 'CLEAN' });
      const decl = ast?.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === m.machine);
      for (const it of decl?.items ?? []) if (it.kind === 'Property' || it.kind === 'Liveness') guarantees.push(`${id}:${it.name}`);
      if (decl && !decl.service) guarantees.push(`${id}:deadlock-free`);
      // PT19, S120: every entry declares its bound, and none above the limit.
      const manifestPath = join(m.buildDir, 'effects.manifest.json');
      if (existsSync(manifestPath)) {
        const effects = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { effects: Record<string, Record<string, any>> }).effects ?? {};
        for (const [kind, entry] of Object.entries(effects)) {
          const n = entry.retry?.maxAttempts;
          if (!Number.isInteger(n)) throw new AdmitError(`${id} ${kind}: no retry.maxAttempts; every entry declares its bound (S120)`);
          if (n > MAX_ATTEMPTS) throw new AdmitError(`${id} ${kind}: retry.maxAttempts ${n} is above the limit; at most ${MAX_ATTEMPTS} (S120, PT19)`);
          if (entry.decision) decisions.push({ machine: id, kind, provider: entry.decision.provider, result: entry.decision.result, labels: entry.labels ?? [], modelBound: false, calibration: 'runtime configuration' });
        }
      }
    }
    for (const c of r.configurations) {
      instances[`${r.module}.${c.configuration}`] = c.instance;
      for (const k of c.instance?.kernelAssumptions ?? []) kernel.add(k);
    }
  }
  if (decisions.length) kernel.add('K10');

  const sources = Object.fromEntries(files.map((f) => [rel(dir, f), sha256OfBytes(readFileSync(f))]));
  const artefacts = artefactsOf(dir, machines, opts.fault);
  const toolchain = { ...(report.files[0]?.engines ?? {}) };
  const body: Omit<Certificate, 'digest' | 'signatures'> = {
    v: 1,
    subject: { kind: 'poly.program', project: manifest.name, machines },
    artefacts,
    guarantees: guarantees.sort(),
    checks,
    domains,
    boundAccepted: null,
    toolchain,
    issuedAt: (opts.now ?? (() => new Date()))().toISOString(),
    buildId: buildIdOf(artefacts, sources, toolchain),
    poly: { sources, moduleDigests, instances, kernelAssumptions: [...kernel].sort(), decisions, limits: [...M4_LIMITS] },
  };
  const digest = opts.fault === 'digest-before-limits' ? certificateDigest({ ...body, poly: { ...body.poly, limits: [] } }) : certificateDigest(body);
  const signature = signDigest(opts.fault === 'sign-wrong-message' ? digest.slice(7) : digest, key.id, key.privateKeyPem);
  const certificate: Certificate = { ...body, signatures: [signature], digest };

  // Write, read back, then rename: what is renamed into place is what was read back.
  const out = join(dir, '.poly', 'certificate.json');
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, JSON.stringify(certificate, null, 2) + '\n');
  const back = JSON.parse(readFileSync(tmp, 'utf8')) as Certificate;
  const problems = certificateProblems(back, artefactsOnDisk(dir, machines), { [key.id]: publicKeyOf(key.privateKeyPem) });
  const sourcesNow = Object.fromEntries(files.map((f) => [rel(dir, f), sha256OfBytes(readFileSync(f))]));
  if (JSON.stringify(back.poly.sources) !== JSON.stringify(sourcesNow)) problems.push({ name: 'sources', problem: 'the sources changed while the program was admitted' });
  if (problems.length) {
    rmSync(tmp, { force: true });
    throw new AdmitError(`certificate read-back failed (a toolchain fault): ${problems.map((p) => `${p.name}: ${p.problem}`).join('; ')}`);
  }
  rmSync(out, { force: true });
  renameSync(tmp, out);
  return { verdict: 'CLEAN', certificatePath: out, certificate: back, artefacts: artefactsOnDisk(dir, machines), report };
}
