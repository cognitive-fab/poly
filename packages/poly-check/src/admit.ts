// `poly admit` (PT14, PT15, S126): check a project, and when it is CLEAN, write and sign its certificate.
//
// In M4 only a CLEAN program is admitted: accepting a finding needs a person's signature (PT12.5), which is M5's.
// The admission key is found by location (`env:NAME` or `file:PATH`), never committed, and a key file inside a
// version-controlled tree is refused. The certificate is written to a temporary name, read back against the
// files it describes and the signature it carries, and only then renamed into place: a certificate that does not
// read back is a toolchain fault, and nothing is left behind (the standing rule on artefacts the runtime reads).
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync, mkdirSync, realpathSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import {
  CERTIFIED_ARTEFACTS, sha256OfBytes, certificateDigest, buildIdOf, signDigest, publicKeyOf, certificateProblems,
  loadProject, keyringsOf, verifyRecord, sameKeyrings, EMPTY_KEYRINGS, type Certificate, type CertifiedMachine, type Keyrings,
} from '@poly/core';
import type * as A from '@poly/core';
import { parse } from '@poly/lang';
import { readEmbedded } from '@poly/embed';
import { checkFile, checkProject, type ProjectReport } from './pipeline.js';
import { STD } from './uses.js';
import { LINT_VERSION, handlerClosure } from './handlers.js';
import { KeyringError, keyringChain } from './keyrings.js';

export class AdmitError extends Error {
  constructor(message: string) { super(message); this.name = 'AdmitError'; }
}

/** Deliberately broken certificate writers, for the read-back's test only (test/toolchain-faults.mjs). */
export const CERTIFICATE_FAULTS = ['omit-artefact', 'stale-artefact-digest', 'digest-before-limits', 'sign-wrong-message', 'stale-handler-digest', 'omit-handler-file', 'stale-policy-digest', 'omit-policy', 'omit-package-file', 'stale-adapter-digest', 'swap-adapter-kind', 'omit-adapters', 'wrong-policy-engine', 'stale-keyring-chain'] as const;
export type CertificateFault = (typeof CERTIFICATE_FAULTS)[number];

/** PT19, S120, S137: the most attempts a manifest entry may declare. */
export const MAX_ATTEMPTS = 10;

/** The limits every build states with its verdicts (S118, S134, S135, S142). */
export const M4_LIMITS = [
  'capabilities are bound in-process to the declared targets; what stops a handler reaching around them is the lint, a discipline, until the opt-in sandbox (PT6.5, S134, S152)',
  'the store is SQLite only; Postgres is not built (S135)',
  'installed packages are hashed, not linted: a package\'s own I/O is stopped only by the opt-in sandbox (S154)',
];

/** S191, ruled on step 10: a limit of M8 for a build with channels, until M9 moves addresses out of the journal. */
export const CHANNEL_ADDRESS_LIMIT = "a channel's journal holds its correspondents' addresses (in instance ids, Inbound step data and ingress records); M9 moves them to the erasable content store and keeps only their keyed digest in the journal (S191)";

export interface AdmitOptions {
  /** The admission key, when it is not named in poly.json. */
  key?: { id: string; privateKeyPem: string };
  now?: () => Date;
  fault?: CertificateFault;
  /** For tests only: runs between the check and the certificate, as an edit during the check would land. */
  afterCheck?: () => void;
  /** S190, for tests: the directory `std.*` modules are found in, instead of the repository's std/. */
  std?: string;
  /** Ruled on step 9, for tests only: the Polyaxion checkout to check against its pin, instead of the sibling one. */
  policyEngine?: string;
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
 * S190: where a type module's file is, as the certificate records it: relative to the project root, or `std:` and its
 * path under the std root. Never absolute, so an admitted project loads wherever it is copied; only the hash decides.
 */
function typeModulePath(dir: string, std: string, file: string, mod: string): string {
  const under = (root: string) => { const r = relative(root, file); return r !== '' && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : null; };
  const p = under(dir);
  if (p !== null) return p;
  const s = under(std);
  if (s !== null) return `std:${s}`;
  throw new AdmitError(`not admitted: module ${mod}, whose enums the build uses, is at ${file}, outside the project and outside std; the certificate records a type module by a path relative to one of them (S190)`);
}

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

/** PT12.5, S126: a person's signing key, read from a file never under version control. */
export function personKey(file: string): string {
  if (insideVersionControl(file)) throw new AdmitError(`the person key is at ${resolve(file)}, inside a tree under version control; a private key is never committed (S126)`);
  return readFileSync(file, 'utf8');
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
function artefactsOf(root: string, machines: CertifiedMachine[], fault?: CertificateFault, policies: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  // PT8: each scope's lowered policy is an artefact the runtime's gate reads.
  for (const p of policies) if (existsSync(join(root, p))) out[p] = sha256OfBytes(readFileSync(join(root, p)));
  for (const m of machines) {
    for (const name of CERTIFIED_ARTEFACTS) {
      const p = join(root, m.dir, name);
      if (existsSync(p)) out[`${m.dir}/${name}`] = sha256OfBytes(readFileSync(p));
    }
  }
  if (fault === 'stale-policy-digest' && policies.length) out[policies[0]] = sha256OfBytes(policies[0]);
  if (fault === 'omit-policy' && policies.length) delete out[policies[0]];
  if (fault === 'omit-artefact') delete out[Object.keys(out)[0]];
  if (fault === 'stale-artefact-digest') { const k = Object.keys(out)[0]; out[k] = sha256OfBytes(k); }
  return out;
}

/** What the runtime reads, re-read from disk: every certified name in every machine directory. */
export function artefactsOnDisk(root: string, machines: CertifiedMachine[], policies: string[] = []): Record<string, string> {
  return artefactsOf(root, machines, undefined, policies);
}

function moduleOf(file: string): A.Module | null {
  const text = readFileSync(file, 'utf8');
  return (file.endsWith('.ts') ? readEmbedded(text, file) : parse(text)).module;
}

/** What a certificate is issued from: the root its paths are relative to, the checked reports, the source files, the keyrings. */
interface Checked { dir: string; name: string; files: string[]; report: ProjectReport; keyrings: Keyrings; isolation?: 'openshell' }

/** A project directory, or one module file checked alone (its handler lint is then not run, S72). */
async function checkTarget(target: string, root?: string, std?: string): Promise<Checked> {
  const abs = resolve(target);
  if (existsSync(join(abs, 'poly.json'))) {
    const { manifest, files } = loadProject(abs);
    return { dir: abs, name: manifest.name, files, report: await checkProject(abs, { root: abs, ...(std ? { std } : {}) }), keyrings: keyringsOf(abs, manifest), ...(manifest.isolation ? { isolation: manifest.isolation } : {}) };
  }
  const dir = resolve(root ?? dirname(abs));
  const r = await checkFile(abs, { root: dir, ...(std ? { std } : {}) });
  const hasEffects = (r.effectKinds ?? []).length > 0;
  const report: ProjectReport = {
    project: dir, name: r.module ?? 'module', files: [r],
    handlers: hasEffects ? { status: 'not-run', reason: 'a module admitted alone has no poly.json naming its handlers (S72)' } : null,
    verdict: r.verdict, exit: r.exit,
  };
  return { dir, name: r.module ?? 'module', files: [abs], report, keyrings: EMPTY_KEYRINGS };
}

export async function admit(target: string, opts: AdmitOptions & { root?: string } = {}): Promise<AdmitResult> {
  const abs = resolve(target);
  const projectDir = existsSync(join(abs, 'poly.json')) ? abs : null;
  const named = projectDir ? loadProject(projectDir).manifest.keys?.admission : undefined;
  const key = admissionKey(projectDir ?? dirname(abs), named, opts.key);
  // A failed admission leaves no certificate: an old one would describe a build this check is about to replace.
  const out = join(projectDir ?? resolve(opts.root ?? dirname(abs)), '.poly', 'certificate.json');
  rmSync(out, { force: true });
  // S194: the rings are anchored, and every change to them signed by a person already trusted, before any check runs.
  chainOf(projectDir);
  const c = await checkTarget(abs, opts.root, opts.std);
  opts.afterCheck?.();
  // Ruled on step 9: a build with policies is admitted only with the gate engine as pinned, its files read now.
  if (c.report.files.some((f) => (f.policies ?? []).length)) {
    const { polyaxionPeer } = await import('@poly/runtime');
    const p = polyaxionPeer({ fresh: true, ...(opts.policyEngine ? { dir: opts.policyEngine } : {}) });
    if (!p.ok) throw new AdmitError(`not admitted: the build has policies, and the gate engine is not the pinned one: ${p.reason}`);
  }
  // PT12.5: a CLEAN program is admitted; a program with findings only when a person signed the acceptance of each.
  let accepted: NonNullable<Certificate['boundAccepted']> | null = null;
  if (c.report.verdict === 'FINDINGS') {
    try { accepted = acceptedFindings(c); } catch (e) {
      if (e instanceof AdmitError && !e.message.includes('FINDINGS')) throw new AdmitError(e.message.replace('not admitted: ', 'not admitted: the verdict is FINDINGS, and '));
      throw e;
    }
  }
  else if (c.report.verdict !== 'CLEAN') {
    throw new AdmitError(`not admitted: the verdict is ${c.report.verdict}; only a CLEAN program, or one whose every finding a person accepted, is admitted (PT12.5, S126)`);
  }
  // PT6.5, S72: the lint over handler modules is part of admission; a project with effects whose lint did not run is not admitted.
  if (c.report.handlers?.status === 'not-run') throw new AdmitError(`not admitted: the handler lint did not run (${c.report.handlers.reason})`);
  return issue(c, key, out, opts, undefined, accepted);
}

/**
 * PT12.5: each finding of a FINDINGS program with its acceptance, signed by a person in the certified keyring, read
 * from the project's `accepted/*.json`. Every finding must have one, and the check must otherwise be clean (nothing
 * not run, nothing vacuous, nothing inconclusive), or the program is not admitted.
 */
function acceptedFindings(c: Checked): NonNullable<Certificate['boundAccepted']> {
  const records: unknown[] = [];
  const folder = join(c.dir, 'accepted');
  if (existsSync(folder)) for (const f of readdirSync(folder).filter((x) => x.endsWith('.json')).sort()) {
    try { records.push(JSON.parse(readFileSync(join(folder, f), 'utf8'))); } catch { throw new AdmitError(`not admitted: accepted/${f} is not JSON`); }
  }
  const out: NonNullable<Certificate['boundAccepted']> = [];
  const missing: string[] = [];
  const problems: string[] = [];
  for (const r of c.report.files) {
    const subjects = [
      ...r.machines.map((m) => ({ name: `${r.module}.${m.machine}`, m })),
      ...r.configurations.map((k) => ({ name: `${r.module}.${k.configuration}`, m: k })),
      ...(r.policies ?? []).map((p) => ({ name: `policy:${p.scope}`, m: { notRun: [...p.notRun, ...p.stages.filter((s) => s.status === 'not-run').map((s) => ({ property: s.stage, reason: s.reason ?? '' }))], vacuous: p.vacuous, diagnostics: p.diagnostics } })),
    ];
    for (const { name, m } of subjects) {
      if (m.notRun.length || m.vacuous.length) throw new AdmitError(`not admitted: ${name} has checks not run or vacuous, which no acceptance covers (PT12.5)`);
      for (const d of m.diagnostics) {
        if (d.severity !== 'finding') throw new AdmitError(`not admitted: ${name} has ${d.code} ${d.name}, which is not a finding a person can accept (PT12.5)`);
        if (!d.witness) throw new AdmitError(`not admitted: ${name} has ${d.code} with no witness, so there is nothing to accept (PT12.5)`);
        const want = `${r.moduleDigest}:${d.witness.id}`;
        const verdicts = records.filter((x) => (x as { subject?: string })?.subject === want).map((x) => verifyRecord(x, c.keyrings, { kind: 'acceptance', subject: want }));
        const good = verdicts.find((v) => v.ok);
        if (good && good.ok) out.push({ code: d.code, property: d.property ?? null, subject: name, witness: d.witness.id, by: good.person.keyId, record: good.digest });
        else if (verdicts.length) problems.push(`${name} ${d.code}: ${(verdicts[0] as { problem: string }).problem}`);
        else missing.push(`${name} ${d.code}${d.property ? ` ${d.property}` : ''} (witness ${d.witness.id.slice(7, 19)}) has no signed acceptance`);
      }
    }
    if (r.diagnostics.length) throw new AdmitError(`not admitted: ${r.file} has diagnostics no acceptance covers`);
  }
  if (problems.length || missing.length) throw new AdmitError(`not admitted: the verdict is FINDINGS, and ${[...problems, ...missing].join('; ')} (PT12.5)`);
  return out;
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

/** S194: the keyring chain of a project as it is on disk now, or null for a module admitted alone or a project with no rings. */
function chainOf(projectDir: string | null): { anchor: string; head: string; source: 'user' | 'test' } | null {
  if (!projectDir) return null;
  const { manifest } = loadProject(projectDir);
  try { return keyringChain(projectDir, manifest, keyringsOf(projectDir, manifest)); } catch (e) { if (e instanceof KeyringError) throw new AdmitError(e.message); throw e; }
}

async function issue(c: Checked, key: { id: string; privateKeyPem: string }, out: string, opts: AdmitOptions, witness?: { purpose: 'witness'; findings: NonNullable<Certificate['findings']> }, accepted: Certificate['boundAccepted'] = null): Promise<AdmitResult> {
  const { dir, files, report } = c;
  const projectDir = existsSync(join(c.dir, 'poly.json')) ? c.dir : null;
  const chain = chainOf(projectDir);
  const machines: CertifiedMachine[] = [];
  const instances: Record<string, unknown> = {};
  const domains: Record<string, string[]> = {};
  const checks: Certificate['checks'] = [];
  const guarantees: string[] = [];
  const kernel = new Set<string>();
  const decisions: Certificate['poly']['decisions'] = [];
  const moduleDigests: Record<string, string> = {};
  const typeModules: NonNullable<Certificate['poly']['typeModules']> = {};
  // PT10, S164, S175: the workflows, each run on poly-runtime with every work order through the gate (S173).
  const workflows: NonNullable<Certificate['poly']['workflows']> = [];
  const channels: NonNullable<Certificate['poly']['channels']> = [];
  for (const r of report.files) {
    if (!r.module || !r.moduleDigest) throw new AdmitError(`${r.file}: no module digest`);
    moduleDigests[r.module] = r.moduleDigest;
    // S190: each module whose enums a build uses, by its file's bytes and its AST digest, which load compares.
    for (const [mod, x] of Object.entries(r.typeModules ?? {})) typeModules[mod] = { path: typeModulePath(dir, opts.std ?? STD, x.file, mod), digest: x.digest, file: sha256OfBytes(readFileSync(x.file)) };
    const ast = moduleOf(r.file);
    for (const w of ast?.decls.filter((d): d is A.Workflow => d.kind === 'Workflow') ?? []) {
      const m = r.machines.find((x) => x.machine === w.machine);
      if (!m?.buildDir) throw new AdmitError(`${r.module}: workflow ${w.name} runs ${w.machine}, which was checked without a build`);
      workflows.push({ name: w.name, machine: `${r.module}.${w.machine}`, runtime: 'poly-runtime', gated: true, descriptor: rel(dir, join(m.buildDir, '..', 'workflows', w.name, 'polyflow.workflow.json')) });
    }
    // PS15: each channel's descriptor, written with its application's build, certified like a workflow's.
    for (const ch of ast?.decls.filter((d): d is A.Channel => d.kind === 'Channel') ?? []) {
      const appName = ch.maps[0]?.machine ?? ch.starts?.machine;
      const m = r.machines.find((x) => x.machine === appName);
      if (!m?.buildDir) throw new AdmitError(`${r.module}: channel ${ch.name} binds ${appName}, which was checked without a build`);
      channels.push({ name: ch.name, application: `${r.module}.${appName}`, descriptor: rel(dir, join(m.buildDir, '..', 'channels', `${ch.name}.json`)) });
    }
    for (const m of r.machines) {
      if (!m.buildDir || !m.instance) throw new AdmitError(`${r.module}.${m.machine}: checked without a build`);
      const id = `${r.module}.${m.machine}`;
      // PS15: a channel's conversation, c.Conversation, is the machine Conversation of the module m.c.
      const dot = m.machine.lastIndexOf('.');
      machines.push({ id, module: dot < 0 ? r.module : `${r.module}.${m.machine.slice(0, dot)}`, machine: dot < 0 ? m.machine : m.machine.slice(dot + 1), dir: rel(dir, m.buildDir) });
      instances[id] = m.instance;
      domains[id] = m.instance.domains;
      for (const k of m.instance.kernelAssumptions) kernel.add(k);
      // Only a program's certificate claims every check clean; a witness certificate records the clean ones it has.
      for (const s of m.stages) if (s.status === 'ran' && s.verdict === 'CLEAN') checks.push({ name: `${id}:${s.stage}`, ok: true, engine: s.engine, verdict: 'CLEAN' });
      const decl = ast?.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === m.machine);
      if (!witness) {
        // PT12.5: a property whose finding a person accepted is not claimed, nor deadlock freedom after an accepted PL3201.
        const waived = (accepted ?? []).filter((x) => x.subject === id);
        for (const it of decl?.items ?? []) if ((it.kind === 'Property' || it.kind === 'Liveness') && !waived.some((x) => x.property === it.name)) guarantees.push(`${id}:${it.name}`);
        if (decl && !decl.service && !waived.some((x) => x.code === 'PL3201')) guarantees.push(`${id}:deadlock-free`);
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
  // PT8: the policies of every scope, as the check lowered them.
  const policyReports = report.files.flatMap((r) => r.policies ?? []);
  for (const p of policyReports) if (!p.artefact) throw new AdmitError(`not admitted: the policies of scope ${p.scope} were not lowered`);
  // Plan step 9: a policy decision is traced to the engine that made it. Polyaxion is resolved from a checkout, so its
  // pinned commit is certified, and a build with policies is not admitted when the commit is unknown.
  let policyEngine: { name: 'polyaxion'; commit: string } | null = null;
  if (policyReports.length) {
    const { polyaxionPeer } = await import('@poly/runtime');
    const p = polyaxionPeer({ fresh: true, ...(opts.policyEngine ? { dir: opts.policyEngine } : {}) });
    if (!p.ok || !/^[0-9a-f]{7,40}$/.test(p.commit)) throw new AdmitError(`not admitted: the build has policies, and the gate engine's commit is unknown (${p.ok ? p.commit : p.reason})`);
    policyEngine = { name: 'polyaxion', commit: p.commit };
    if (opts.fault === 'wrong-policy-engine') policyEngine = { name: 'polyaxion', commit: '0000000' };
  }
  // The workflow descriptors are artefacts poly-runtime reads, certified with the policies (PT10, S164, S173).
  const policyPaths = [...policyReports.map((p) => p.artefact!.path), ...workflows.map((w) => w.descriptor), ...channels.map((c) => c.descriptor)];
  const artefacts = artefactsOf(dir, machines, opts.fault, policyPaths);
  for (const p of policyReports) {
    if (!opts.fault && artefacts[p.artefact!.path] !== p.artefact!.digest) throw new AdmitError(`not admitted: ${p.artefact!.path} on disk is not the policy the check checked (certified bytes must be the checked bytes)`);
  }
  // Polywatch on step 3: a workflow's descriptor is outside its machine's directory, so it is compared by its own name.
  for (const ch of channels) {
    const m = report.files.flatMap((r) => r.machines.map((x) => ({ r, x }))).find(({ r, x }) => `${r.module}.${x.machine}` === ch.application)?.x;
    const want = m?.artefactDigests?.[`../channels/${ch.name}.json`];
    if (!opts.fault && (want === undefined || artefacts[ch.descriptor] !== want)) throw new AdmitError(`not admitted: ${ch.descriptor} on disk is not the bytes the check checked (certified bytes must be the checked bytes)`);
  }
  for (const w of workflows) {
    const m = report.files.flatMap((r) => r.machines.map((x) => ({ r, x }))).find(({ r, x }) => `${r.module}.${x.machine}` === w.machine)?.x;
    const want = m?.artefactDigests?.[`../workflows/${w.name}/polyflow.workflow.json`];
    if (!opts.fault && (want === undefined || artefacts[w.descriptor] !== want)) throw new AdmitError(`not admitted: ${w.descriptor} on disk is not the bytes the check checked (certified bytes must be the checked bytes)`);
  }
  for (const r of report.files) for (const m of r.machines) {
    if (!m.buildDir) continue;
    const prefix = rel(dir, m.buildDir);
    for (const [path, have] of Object.entries(artefacts)) {
      if (!path.startsWith(prefix + '/')) continue;
      const want = m.artefactDigests?.[path.slice(prefix.length + 1)];
      if (!opts.fault && want !== have) throw new AdmitError(`not admitted: ${path} on disk is not the bytes the check checked (certified bytes must be the checked bytes)`);
    }
    // Polywatch on review A1: and the other way round, so a checked artefact gone from disk is refused, not left out.
    for (const name of CERTIFIED_ARTEFACTS) {
      if (m.artefactDigests?.[name] !== undefined && artefacts[`${prefix}/${name}`] === undefined && !opts.fault) {
        throw new AdmitError(`not admitted: ${prefix}/${name} is gone from disk, so it is not the bytes the check checked (certified bytes must be the checked bytes)`);
      }
    }
  }
  // S142: the handlers, as the lint read them. A file that differs on disk now is refused, never certified.
  const lint = report.handlers;
  const handlers: Certificate['poly']['handlers'] = lint?.status === 'ran'
    ? { roots: lint.roots, files: lint.digests, lint: { version: LINT_VERSION, verdict: lint.diagnostics.length ? 'FINDINGS' : 'CLEAN' }, packages: lint.packages, packageFiles: lint.packageFiles, lockfile: lint.lockfile }
    : { roots: [], files: {}, lint: { version: LINT_VERSION, verdict: 'not-run', reason: lint?.status === 'not-run' ? lint.reason : 'the program has no effects and poly.json names no handlers' }, packages: [], packageFiles: {}, lockfile: null };
  const handlerProblems = (): string[] => {
    const out: string[] = [];
    for (const [p, want] of Object.entries(handlers.files)) {
      const f = join(dir, p);
      if (!existsSync(f) || sha256OfBytes(readFileSync(f)) !== want) out.push(`${p} on disk is not the handler the lint read`);
    }
    for (const [p, want] of Object.entries(handlers.packageFiles)) {
      const f = join(dir, p);
      if (!existsSync(f) || sha256OfBytes(readFileSync(f)) !== want) out.push(`${p} changed during the check`);
    }
    if (handlers.lockfile) {
      const f = join(dir, handlers.lockfile.path);
      if (!existsSync(f) || sha256OfBytes(readFileSync(f)) !== handlers.lockfile.digest) out.push(`${handlers.lockfile.path} changed during the check`);
    }
    return out;
  };
  const changed = handlerProblems();
  if (changed.length) throw new AdmitError(`not admitted: ${changed.join('; ')} (S142)`);
  // S142, the standing rule on artefacts: the broken variants a read-back must catch.
  const certifiedHandlers: Certificate['poly']['handlers'] = { ...handlers, files: { ...handlers.files }, packageFiles: { ...handlers.packageFiles } };
  const handlerPaths = Object.keys(certifiedHandlers.files);
  if (opts.fault === 'stale-handler-digest' && handlerPaths.length) certifiedHandlers.files[handlerPaths[0]] = sha256OfBytes(handlerPaths[0]);
  if (opts.fault === 'omit-handler-file' && handlerPaths.length) delete certifiedHandlers.files[handlerPaths[handlerPaths.length - 1]];
  const packagePaths = Object.keys(certifiedHandlers.packageFiles);
  if (opts.fault === 'omit-package-file' && packagePaths.length) delete certifiedHandlers.packageFiles[packagePaths[packagePaths.length - 1]];
  // S182, plan step 10: each channel's runtime adapter, bound by package name, version and digest. A channel whose
  // declared adapter the adapter package does not make (the tests' `test` kind) is bound to none, and cannot connect.
  let adapters: NonNullable<Certificate['poly']['adapters']> = [];
  let adapterPin: { package: string; version: string; digest: string } | null = null;
  const { adapterPackagePin, IO_ADAPTERS } = await import('@poly/runtime');
  /** Each channel's declared adapter, from its descriptor on disk, for one the adapter package makes. */
  const declaredAdapters = () => [...channels].sort((x, y) => (x.name < y.name ? -1 : 1)).flatMap((ch) => {
    const d = JSON.parse(readFileSync(join(dir, ch.descriptor), 'utf8')) as { adapter?: string };
    return d.adapter && IO_ADAPTERS.includes(d.adapter) ? [{ channel: ch.name, adapter: d.adapter }] : [];
  });
  if (channels.length) {
    for (const x of declaredAdapters()) {
      adapterPin ??= adapterPackagePin();
      adapters.push({ ...x, ...adapterPin });
    }
    if (opts.fault === 'stale-adapter-digest' && adapters.length) adapters[0] = { ...adapters[0], digest: `sha256:${'0'.repeat(64)}` };
    if (opts.fault === 'swap-adapter-kind' && adapters.length) adapters[0] = { ...adapters[0], adapter: IO_ADAPTERS.find((k) => k !== adapters[0].adapter)! };
    if (opts.fault === 'omit-adapters') adapters = [];
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
    boundAccepted: accepted,
    toolchain,
    issuedAt: (opts.now ?? (() => new Date()))().toISOString(),
    buildId: buildIdOf(artefacts, { ...sources, ...Object.fromEntries(Object.entries(certifiedHandlers.files).map(([p, d]) => [`handler:${p}`, d])) }, toolchain),
    poly: { sources, moduleDigests, ...(Object.keys(typeModules).length ? { typeModules } : {}), instances, kernelAssumptions: [...kernel].sort(), decisions, limits: [...M4_LIMITS, ...(channels.length ? [CHANNEL_ADDRESS_LIMIT] : []), ...(lint?.status === 'ran' && lint.packageUnresolved.length ? [`imports inside installed packages that resolve to no file are not certified (an optional dependency, say): ${lint.packageUnresolved.join('; ')} (S154)`] : []), ...(c.isolation === 'openshell' ? ['the OpenShell sandbox policies are generated and certified, and this runtime does not enforce them: handlers run in process, and enforcement needs an OpenShell gateway (not run, S152)'] : [])], handlers: certifiedHandlers, keyrings: c.keyrings, ...(chain ? { keyringChain: opts.fault === 'stale-keyring-chain' ? { ...chain, head: `sha256:${'0'.repeat(64)}` } : chain } : {}), policies: policyReports.map((p) => ({ scope: p.scope, policies: p.policies, path: p.artefact!.path, reads: p.reads })), ...(workflows.length ? { workflows } : {}), ...(channels.length ? { channels } : {}), ...(policyEngine ? { policyEngine } : {}), ...(adapters.length ? { adapters } : {}) },
  };
  const digest = opts.fault === 'digest-before-limits' ? certificateDigest({ ...body, poly: { ...body.poly, limits: [] } }) : certificateDigest(body);
  const signature = signDigest(opts.fault === 'sign-wrong-message' ? digest.slice(7) : digest, key.id, key.privateKeyPem);
  const certificate: Certificate = { ...body, signatures: [signature], digest };

  // Write, read back, then rename: what is renamed into place is what was read back.
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, JSON.stringify(certificate, null, 2) + '\n');
  const back = JSON.parse(readFileSync(tmp, 'utf8')) as Certificate;
  const problems = certificateProblems(back, artefactsOnDisk(dir, machines, policyPaths), { [key.id]: publicKeyOf(key.privateKeyPem) });
  const sourcesNow = Object.fromEntries(files.map((f) => [rel(dir, f), sha256OfBytes(readFileSync(f))]));
  if (JSON.stringify(back.poly.sources) !== JSON.stringify(sourcesNow)) problems.push({ name: 'sources', problem: 'the sources changed while the program was admitted' });
  for (const p of handlerProblems()) problems.push({ name: 'handlers', problem: p });
  // S182: the adapters read back are the installed adapter package as it is now.
  for (const x of back.poly.adapters ?? []) if (!adapterPin || x.package !== adapterPin.package || x.version !== adapterPin.version || x.digest !== adapterPin.digest) problems.push({ name: 'adapters', problem: `channel ${x.channel}'s adapter is bound to ${x.package} ${x.version} ${x.digest}, and the installed package is not that` });
  // Review D-F5 (M8b): and the binding is every channel's declared adapter, read again from its descriptor, so a
  // binding of another kind, or none at all, is caught here rather than at connect.
  const bound = JSON.stringify((back.poly.adapters ?? []).map((x) => ({ channel: x.channel, adapter: x.adapter })));
  if (bound !== JSON.stringify(declaredAdapters())) problems.push({ name: 'adapters', problem: `the certificate binds ${bound}, and the channels' descriptors declare ${JSON.stringify(declaredAdapters())}` });
  // Review D-F5 (M8b): the gate engine certified is the pinned engine, resolved again.
  if (policyReports.length) {
    const { polyaxionPeer } = await import('@poly/runtime');
    const p = polyaxionPeer({ fresh: true, ...(opts.policyEngine ? { dir: opts.policyEngine } : {}) });
    if (!p.ok || back.poly.policyEngine?.name !== 'polyaxion' || back.poly.policyEngine.commit !== p.commit) problems.push({ name: 'policyEngine', problem: `the certificate names ${JSON.stringify(back.poly.policyEngine ?? null)}, and the pinned engine is ${p.ok ? p.commit : `unknown (${p.reason})`}` });
  } else if (back.poly.policyEngine) problems.push({ name: 'policyEngine', problem: 'a gate engine is certified for a build with no policies' });
  // S194: the chain read back is the one on disk now, anchor and head.
  if (JSON.stringify(back.poly.keyringChain ?? null) !== JSON.stringify(chainOf(projectDir))) problems.push({ name: 'keyrings', problem: 'the certified keyring chain is not the chain on disk' });
  // S150: the keyrings read back are the ones the manifest names now.
  if (!sameKeyrings(back.poly.keyrings, existsSync(join(dir, 'poly.json')) ? keyringsOf(dir, loadProject(dir).manifest) : EMPTY_KEYRINGS)) problems.push({ name: 'keyrings', problem: 'the keyrings changed while the program was admitted' });
  // S142: the handlers read back are the closure of the roots as it is on disk now, file for file.
  if (lint?.status === 'ran') {
    const now = handlerClosure(dir, lint.roots.map((p) => join(dir, p)));
    if (JSON.stringify(back.poly.handlers.files) !== JSON.stringify(now.digests)) problems.push({ name: 'handlers', problem: 'the certified handler files are not the closure of the handlers on disk' });
    // Review of M5b, D: and the certified package files are every package file the closure reaches (S154).
    if (JSON.stringify(back.poly.handlers.packageFiles) !== JSON.stringify(now.packageFiles)) problems.push({ name: 'handlers', problem: 'the certified package files are not the package files the handlers reach on disk' });
  } else if (Object.keys(back.poly.handlers.files).length) problems.push({ name: 'handlers', problem: 'handler files certified with no lint run' });
  if (problems.length) {
    rmSync(tmp, { force: true });
    throw new AdmitError(`certificate read-back failed (a toolchain fault): ${problems.map((p) => `${p.name}: ${p.problem}`).join('; ')}`);
  }
  rmSync(out, { force: true });
  renameSync(tmp, out);
  return { verdict: 'CLEAN', certificatePath: out, certificate: back, artefacts: artefactsOnDisk(dir, machines, policyPaths), report };
}
