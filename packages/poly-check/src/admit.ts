// `poly admit` (PT14, PT15, S126): check a project, and when it is CLEAN, write and sign its certificate.
//
// In M4 only a CLEAN program is admitted: accepting a finding needs a person's signature (PT12.5), which is M5's.
// The admission key is found by location (`env:NAME` or `file:PATH`), never committed, and a key file inside a
// version-controlled tree is refused. The certificate is written to a temporary name, read back against the
// files it describes and the signature it carries, and only then renamed into place: a certificate that does not
// read back is a toolchain fault, and nothing is left behind (the standing rule on artefacts the runtime reads).
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import {
  CERTIFIED_ARTEFACTS, sha256OfBytes, certificateDigest, buildIdOf, signDigest, publicKeyOf, certificateProblems,
  loadProject, type Certificate, type CertifiedMachine,
} from '@poly/core';
import type * as A from '@poly/core';
import { parse } from '@poly/lang';
import { readEmbedded } from '@poly/embed';
import { checkFile, checkProject, type ProjectReport } from './pipeline.js';

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
  /** For tests only: runs between the check and the certificate, as an edit during the check would land. */
  afterCheck?: () => void;
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

/**
 * A key file inside a version-controlled tree could be committed; it is refused whatever it holds (S126). The test
 * walks the file's real path, so a junction or a symbolic link from outside the tree does not hide it (review A4).
 */
function insideVersionControl(file: string): boolean {
  const lexical = resolve(file);
  let real = lexical;
  try { real = realpathSync.native(lexical); } catch {
    try { real = join(realpathSync.native(dirname(lexical)), basename(lexical)); } catch { /* no such directory: the lexical path */ }
  }
  for (let d = dirname(real); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

/** Review A3, S139: the test key of `poly admit --witness`, read from a file never under version control. */
export function witnessKey(file: string): { id: string; privateKeyPem: string } {
  if (insideVersionControl(file)) throw new AdmitError(`the witness key is at ${resolve(file)}, inside a tree under version control; a private key is never committed (S126)`);
  return { id: 'witness', privateKeyPem: readFileSync(file, 'utf8') };
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

/** What a certificate is issued from: the root its paths are relative to, the checked reports, the source files. */
interface Checked { dir: string; name: string; files: string[]; report: ProjectReport }

/** A project directory, or one module file checked alone (its handler lint is then not run, S72). */
async function checkTarget(target: string, root?: string): Promise<Checked> {
  const abs = resolve(target);
  if (existsSync(join(abs, 'poly.json'))) {
    const { manifest, files } = loadProject(abs);
    return { dir: abs, name: manifest.name, files, report: await checkProject(abs, { root: abs }) };
  }
  const dir = resolve(root ?? dirname(abs));
  const r = await checkFile(abs, { root: dir });
  const hasEffects = (r.effectKinds ?? []).length > 0;
  const report: ProjectReport = {
    project: dir, name: r.module ?? 'module', files: [r],
    handlers: hasEffects ? { status: 'not-run', reason: 'a module admitted alone has no poly.json naming its handlers (S72)' } : null,
    verdict: r.verdict, exit: r.exit,
  };
  return { dir, name: r.module ?? 'module', files: [abs], report };
}

export async function admit(target: string, opts: AdmitOptions & { root?: string } = {}): Promise<AdmitResult> {
  const abs = resolve(target);
  const projectDir = existsSync(join(abs, 'poly.json')) ? abs : null;
  const named = projectDir ? loadProject(projectDir).manifest.keys?.admission : undefined;
  const key = admissionKey(projectDir ?? dirname(abs), named, opts.key);
  // A failed admission leaves no certificate: an old one would describe a build this check is about to replace.
  const out = join(projectDir ?? resolve(opts.root ?? dirname(abs)), '.poly', 'certificate.json');
  rmSync(out, { force: true });
  const c = await checkTarget(abs, opts.root);
  opts.afterCheck?.();
  if (c.report.verdict !== 'CLEAN') {
    throw new AdmitError(`not admitted: the verdict is ${c.report.verdict}; in M4 only a CLEAN program is admitted, since accepting a finding needs a person's signature (PT12.5, S126)`);
  }
  // PT6.5, S72: the lint over handler modules is part of admission; a project with effects whose lint did not run is not admitted.
  if (c.report.handlers?.status === 'not-run') throw new AdmitError(`not admitted: the handler lint did not run (${c.report.handlers.reason})`);
  return issue(c, key, out, opts);
}

/**
 * S139: a witness certificate, for the exported test of a program with findings. Same format, `purpose:
 * "witness"`, the findings listed, signed with the key given (a test key, generated by the caller and never
 * stored). The runtime refuses it unless the caller passes allowWitness, which production refuses. It is never a
 * program's certificate: it is written to its own path, and `admit` still refuses the same program.
 */
export async function admitWitness(target: string, opts: { root?: string; key: { id: string; privateKeyPem: string }; out: string; now?: () => Date }): Promise<AdmitResult> {
  rmSync(opts.out, { force: true });
  const c = await checkTarget(target, opts.root);
  if (c.report.verdict === 'ERROR' || c.report.verdict === 'NONDETERMINISM' || c.report.verdict === 'REFUSED') {
    throw new AdmitError(`no witness certificate: the verdict is ${c.report.verdict}, so there is no checked build to walk`);
  }
  const findings: NonNullable<Certificate['findings']> = [];
  for (const r of c.report.files) {
    for (const m of r.machines) for (const d of m.diagnostics) if (d.witness) findings.push({ code: d.code, property: d.property ?? null, subject: `${r.module}.${m.machine}`, witness: d.witness.id });
    for (const k of r.configurations) for (const d of k.diagnostics) if (d.witness) findings.push({ code: d.code, property: d.property ?? null, subject: `${r.module}.${k.configuration}`, witness: d.witness.id });
  }
  return issue(c, opts.key, resolve(opts.out), { now: opts.now }, { purpose: 'witness', findings });
}

async function issue(c: Checked, key: { id: string; privateKeyPem: string }, out: string, opts: AdmitOptions, witness?: { purpose: 'witness'; findings: NonNullable<Certificate['findings']> }): Promise<AdmitResult> {
  const { dir, files, report } = c;
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
      // Only a program's certificate claims every check clean; a witness certificate records the clean ones it has.
      for (const s of m.stages) if (s.status === 'ran' && s.verdict === 'CLEAN') checks.push({ name: `${id}:${s.stage}`, ok: true, engine: s.engine, verdict: 'CLEAN' });
      const decl = ast?.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === m.machine);
      if (!witness) {
        for (const it of decl?.items ?? []) if (it.kind === 'Property' || it.kind === 'Liveness') guarantees.push(`${id}:${it.name}`);
        if (decl && !decl.service) guarantees.push(`${id}:deadlock-free`);
      }
      // PT19, S120, S137: every entry declares its bound, and none above the limit.
      const manifestPath = join(m.buildDir, 'effects.manifest.json');
      if (existsSync(manifestPath)) {
        const effects = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { effects: Record<string, Record<string, any>> }).effects ?? {};
        for (const [kind, entry] of Object.entries(effects)) {
          const n = entry.retry?.maxAttempts;
          if (!Number.isInteger(n)) throw new AdmitError(`${id} ${kind}: no retry.maxAttempts; every entry declares its bound (S120)`);
          if (n > MAX_ATTEMPTS) throw new AdmitError(`${id} ${kind}: retry.maxAttempts ${n} is above the limit; at most ${MAX_ATTEMPTS} (S120, S137, PT19)`);
          if (entry.decision) decisions.push({ machine: id, kind, provider: entry.decision.provider, result: entry.decision.result, labels: entry.labels ?? [], modelBound: false, calibration: 'runtime configuration' });
        }
      }
    }
    for (const k of r.configurations) {
      instances[`${r.module}.${k.configuration}`] = k.instance;
      for (const a of k.instance?.kernelAssumptions ?? []) kernel.add(a);
    }
  }
  if (decisions.length) kernel.add('K10');

  // Review A1, A2: certify what the check checked. Each source is the text the check read, and each artefact the
  // bytes the lowering wrote and every later stage read; a file that differs on disk now is refused, never certified.
  const checkedSource = new Map(report.files.map((r) => [resolve(r.file), r.sourceDigest]));
  for (const f of files) {
    const want = checkedSource.get(resolve(f));
    if (want && sha256OfBytes(readFileSync(f)) !== want) throw new AdmitError(`not admitted: ${rel(dir, f)} on disk is not the source the check checked (it changed during the check)`);
  }
  const sources = Object.fromEntries(files.map((f) => [rel(dir, f), checkedSource.get(resolve(f)) ?? sha256OfBytes(readFileSync(f))]));
  const artefacts = artefactsOf(dir, machines, opts.fault);
  for (const r of report.files) for (const m of r.machines) {
    if (!m.buildDir) continue;
    const prefix = rel(dir, m.buildDir);
    for (const [path, have] of Object.entries(artefacts)) {
      if (!path.startsWith(prefix + '/')) continue;
      const want = m.artefactDigests?.[path.slice(prefix.length + 1)];
      if (!opts.fault && want !== have) throw new AdmitError(`not admitted: ${path} on disk is not the bytes the check checked (certified bytes must be the checked bytes)`);
    }
  }
  const toolchain = { ...(report.files[0]?.engines ?? {}) };
  const body: Omit<Certificate, 'digest' | 'signatures'> = {
    v: 1,
    ...(witness ? { purpose: witness.purpose, findings: witness.findings } : {}),
    subject: { kind: 'poly.program', project: c.name, machines },
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
  mkdirSync(dirname(out), { recursive: true });
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
