// Loading an admitted build (PT15, PF8.1, S126). The runtime reads only public keys. It reads each certified
// artefact once, checks the bytes against the certificate and the certificate against a trusted signature, writes
// the verified bytes to a directory named by the build id, and registers polyrun's machines from that copy, so
// the bytes polyrun loads are the bytes checked. Any difference refuses the load, naming the artefact and both
// digests. A manifest entry without its retry bound is refused too (S120).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** S190: the repository's std/, where a certificate's `std:` paths are read. */
const STD = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'std');
import { actionTypes, type TypeNode } from './types.js';
import type { FlowDescriptor, SourceDescriptor } from './memory.js';
import { CERTIFIED_ARTEFACTS, certificateProblems, sha256OfBytes, parseManifest, keyringsOf, sameKeyrings, EMPTY_KEYRINGS, policySubject, verifyRecord, verifyChain, KeyringError, type Anchor, type Certificate, type CertificateProblem } from '@poly/core';

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
  /** PT10, S173: each certified workflow, from the verified bytes of its descriptor: the tool each effect kind maps to. */
  workflows: VerifiedWorkflow[];
  /** PS15: each certified channel, from the verified bytes of its descriptor. */
  channels: VerifiedChannel[];
  /** PT10e, review D4 (M9): each certified credential, from the verified bytes of its descriptor, read once here. */
  credentials: VerifiedCredential[];
  /** S321: the id of the anchor load verified the keyrings from, which memory records name; null with no keyrings. */
  anchorId: string | null;
  /** PT12.5, S210 (D9): whether the project's keyring anchor says it is production. */
  production: boolean;
  /** PT10i, PS17: each source's and each module's flow descriptor, from the verified bytes. */
  memory: { sources: SourceDescriptor[]; flows: FlowDescriptor[] };
  /** PT10r: each certified route and budget, from the verified bytes of its descriptor, read once here. */
  routes: VerifiedRoute[];
  budgets: VerifiedBudget[];
}

/** PS18.1 to PS18.3, PT10r: what the runtime needs of a route: its machine, its call's kind, its decision and its tiers. */
export interface VerifiedRoute {
  name: string;
  module: string;
  machine: string;
  effectKind: string;
  decision: { machine: string; name: string };
  tiers: VerifiedTier[];
  escalate: ({ on: 'conf' | 'margin'; below: number } | { on: 'failed' })[];
  budget: string | null;
}
export interface VerifiedTier {
  name: string;
  provider: string;
  model: string;
  maxTokens: number;
  reservation: number;
  prices: { path: string; digest: string; currency: string; perMillionTokens: Record<string, number> };
  calibration: { path: string; digest: string; decision: string; version: number; fittedFor: string; points: [number, number][]; mapDigest: string } | null;
}
/** PS18.4, PT10r: what the runtime needs of a budget: its machine and its caps, each with its address. */
export interface VerifiedBudget {
  name: string;
  module: string;
  machine: string;
  caps: { currency: string; amount: number; run: boolean; period: 'hour' | 'day' | 'month' | null; scope: boolean }[];
  onExhausted: 'deny' | 'escalate';
}

/** PS16.1, PT10e: what the runtime needs of a credential: its Grant machine, provider, scopes and whether it has a holder. */
export interface VerifiedCredential { name: string; machine: string; provider: string; scopes: string[]; holder: boolean }

/** PS15.4: what the runtime needs to route a channel's inbound message. */
export interface VerifiedChannel { channel: string; kind: string; application: string; conversation: string; thread: { template: string; fields: string[] }; starts: { action: string; onInbound: boolean }; inbound: { to: string; action: string }; audience?: string | null }

export interface WorkOrderTool { tool: string; target?: string; why: string }
export interface VerifiedWorkflow { name: string; machine: string; inputAction: string; key: { template: string; fields: Record<string, { pattern?: string }> }; tools: Record<string, WorkOrderTool> }

/** `load('./.poly/build', …)` (PT15) names the build; the certificate's paths are relative to the project above it. */
export function projectRootOf(buildDir: string): string {
  const abs = resolve(buildDir);
  return basename(abs) === 'build' && basename(dirname(abs)) === '.poly' ? dirname(dirname(abs)) : abs;
}

/**
 * S194, ruled on the keyring change: whether this process loads a certificate whose keyring anchor a test supplied.
 * Tests call acceptTestAnchors(); a production runtime never does, so a certificate admitted around the owner's anchor
 * never runs.
 */
let testAnchorsAccepted = false;
export function acceptTestAnchors(): void { testAnchorsAccepted = true; }

export function verifyBuild(buildDir: string, certificatePath: string, trust: Record<string, string>, opts: { allowWitness?: boolean; std?: string } = {}): VerifiedBuild {
  const root = projectRootOf(buildDir);
  if (!existsSync(certificatePath)) throw new LoadError(`no certificate at ${certificatePath}: the runtime loads only admitted programs (PF8.1)`);
  let certificate: Certificate;
  try { certificate = JSON.parse(readFileSync(certificatePath, 'utf8')) as Certificate; } catch (e) { throw new LoadError(`the certificate at ${certificatePath} is not JSON: ${(e as Error).message}`); }
  if (!certificate?.subject?.machines || !Array.isArray(certificate.subject.machines)) throw new LoadError('the certificate names no machines');
  // S139: a witness certificate admits a program with findings, for its exported tests only.
  if (opts.allowWitness && process.env.NODE_ENV === 'production') throw new LoadError('allowWitness is refused in production: a witness certificate admits a program with findings (S139)');
  if (certificate.purpose === 'witness' && !opts.allowWitness) throw new LoadError(`refused at load: ${certificatePath} is a witness certificate, for a program with ${certificate.findings?.length ?? 0} finding(s); only an exported witness test loads it, with allowWitness (S139)`);
  if (certificate.purpose !== undefined && certificate.purpose !== 'witness') throw new LoadError(`refused at load: unknown certificate purpose ${JSON.stringify(certificate.purpose)}`);
  if (certificate.poly?.keyringChain?.source === 'test' && !testAnchorsAccepted) throw new LoadError(`refused at load: PL6410 KEYRING_NOT_SIGNED: ${certificatePath} was admitted with a test keyring anchor, which only a test process accepts (S194)`);

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
  // PT10, S173: each workflow's descriptor, read once like any artefact. Before M8 nothing read it here, so a build with
  // a workflow could not load at all ("certified but missing").
  for (const w of certificate.poly?.workflows ?? []) {
    const f = join(root, w.descriptor);
    if (existsSync(f)) bytes.set(w.descriptor, readFileSync(f));
  }
  // PS15: each channel's descriptor, read once like any artefact.
  for (const c of certificate.poly?.channels ?? []) {
    const f = join(root, c.descriptor);
    if (existsSync(f)) bytes.set(c.descriptor, readFileSync(f));
  }
  // PT10i: each memory descriptor, read once like any artefact.
  for (const d of [...(certificate.poly?.memory?.sources ?? []), ...(certificate.poly?.memory?.flows ?? [])]) {
    const f = join(root, d.descriptor);
    if (existsSync(f)) bytes.set(d.descriptor, readFileSync(f));
  }
  // PT10e: each credential's descriptor, read once like any artefact; PT10r: each route's and each budget's too.
  for (const c of [...(certificate.poly?.credentials ?? []), ...(certificate.poly?.routes ?? []), ...(certificate.poly?.budgets ?? [])]) {
    const f = join(root, c.descriptor);
    if (existsSync(f)) bytes.set(c.descriptor, readFileSync(f));
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
    else packageBytes.set(p, b!);
  }
  if (h.lockfile) {
    const f = join(root, h.lockfile.path);
    const have = existsSync(f) ? sha256OfBytes(readFileSync(f)) : null;
    if (have !== h.lockfile.digest) changed.push(`the lockfile ${h.lockfile.path} is not the certified one (certified ${h.lockfile.digest}, found ${have ?? 'nothing'})`);
  }
  if (changed.length) throw new LoadError(`refused at load: PL6403 HANDLER_CHANGED: ${changed.join('; ')} (S142)`);

  // S190: the modules whose enums a build uses. Each contract records their digests, which must be the certificate's,
  // and each module's file must be the one certified: a member added to a std enum since the build refuses the load.
  const typeModules = certificate.poly?.typeModules ?? {};
  const stale: string[] = [];
  for (const [mod, x] of Object.entries(typeModules)) {
    // A path is relative to the project root, or std: and relative to the std root; only the hash decides.
    const f = x.path.startsWith('std:') ? join(opts.std ?? STD, x.path.slice(4)) : join(root, x.path);
    const have = existsSync(f) ? sha256OfBytes(readFileSync(f)) : null;
    if (have !== x.file) stale.push(`module ${mod} (${x.path}) changed since the build (certified ${x.file}, found ${have ?? 'nothing'})`);
  }
  for (const m of certificate.subject.machines) {
    const c = bytes.get(`${m.dir}/contract.json`);
    const recorded = c ? ((JSON.parse(c.toString('utf8')) as { typeModules?: Record<string, string> }).typeModules ?? {}) : {};
    for (const [mod, d] of Object.entries(recorded)) if (typeModules[mod]?.digest !== d) stale.push(`${m.id} was built against module ${mod} at ${d}, and the certificate records ${typeModules[mod]?.digest ?? 'nothing'}`);
  }
  if (stale.length) throw new LoadError(`refused at load: PL6407 TYPE_MODULE_CHANGED: ${stale.join('; ')}; its enums are lowered into the build, so admit the program again (S190)`);

  // S150: the keyrings that sign approvals and acceptances are the certified ones; a change needs re-admission.
  const ring = certificate.poly?.keyrings;
  // S210, D1: the certified rings are verified from the project's anchor, as admission verifies them, so the admission
  // key alone cannot widen the people ring; and the chain must extend the head the anchor keeps (D2).
  let anchor: Anchor | null = null;
  if (ring && Array.isArray(ring.people) && Array.isArray(ring.agents)) {
    try { anchor = verifyChain(root, certificate.subject.project, ring, certificate.poly?.keyringChain?.source === 'test' ? 'test' : 'user')?.anchor ?? null; } catch (e) { if (e instanceof KeyringError) throw new LoadError(`refused at load: ${e.message}`); throw e; }
  }
  if (!ring || !Array.isArray(ring.people) || !Array.isArray(ring.agents)) throw new LoadError('refused at load: PL6405 KEYRING_CHANGED: the certificate binds no keyrings; it predates S150, so admit the program again');
  const manifestPath = join(root, 'poly.json');
  let current;
  try { current = existsSync(manifestPath) ? keyringsOf(root, parseManifest(readFileSync(manifestPath, 'utf8'), manifestPath)) : EMPTY_KEYRINGS; } catch (e) { throw new LoadError(`refused at load: PL6405 KEYRING_CHANGED: the keyrings cannot be read: ${(e as Error).message}`); }
  if (!sameKeyrings(ring, current)) throw new LoadError('refused at load: PL6405 KEYRING_CHANGED: the people or agents keyring in poly.json differs from the certified one; a keyring change needs re-admission (S150)');

  const runDir = join(root, '.poly', 'run', certificate.buildId);
  const handlers = new Map<string, string>();
  const base = handlerCopyRoot(runDir, h.packageFiles ?? {});
  for (const [p, b] of handlerBytes) {
    const copy = join(base, ...p.split('/'));
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, b);
    if (h.roots.includes(p)) handlers.set(p, copy);
  }
  // Review D-F4: the runtime imports the copy, so a bare import resolves from there. The certified package files inside
  // the project are copied beside it as they sit beside the handlers, so the package that runs is the certified one.
  // Polywatch: a package above the project ('../node_modules/…') is copied too, above the copy's root, which sits
  // that many directories deep, so Node finds the copy before it leaves the run directory.
  for (const [p, b] of packageBytes) {
    const copy = join(base, ...p.split('/'));
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
  // S194, Q8: each scope's policy record, by a person of the certified ring, over the document as read, its certified
  // source and the engine the certificate pins; the engine as loaded is checked against that pin at the gate's opening.
  for (const p of certificate.poly?.policies ?? []) {
    const engine = certificate.poly.policyEngine;
    const doc = bytes.get(p.path);
    const sequence = p.sequence;
    const subject = doc && engine && p.source && Number.isSafeInteger(sequence) ? policySubject({ scope: p.scope, sequence: sequence!, document: sha256OfBytes(doc), sources: { [p.source]: certificate.poly.sources[p.source] }, engine }) : null;
    const v = subject && p.signature ? verifyRecord(p.signature, certificate.poly.keyrings, { kind: 'policy', subject }) : { ok: false as const, problem: 'the certificate binds no signature for it, or none with its sequence (S210)' };
    if (!v.ok) throw new LoadError(`refused at load: PL6409 POLICY_NOT_SIGNED: scope ${p.scope}: ${v.problem} (S194)`);
    // S210, D7: a policy older than the one the anchor keeps for its scope is never loaded again.
    const kept = anchor?.policies[p.scope];
    if (kept !== undefined && sequence! < kept) throw new LoadError(`refused at load: PL6409 POLICY_NOT_SIGNED: scope ${p.scope}: its sequence ${sequence} is lower than the ${kept} the anchor keeps (S210)`);
  }
  const policies = (certificate.poly?.policies ?? []).map((p) => ({ scope: p.scope, policies: p.policies, reads: p.reads, doc: JSON.parse(bytes.get(p.path)!.toString('utf8')) as Record<string, unknown> }));
  // S173: a workflow's mapped kinds become work orders, so each must be an effect of its machine, as certified.
  const workflows: VerifiedWorkflow[] = [];
  for (const w of certificate.poly?.workflows ?? []) {
    // S175: a certificate from before M8 lists a workflow as run by polyflow, outside the gate; it is not what runs here.
    if ((w as { runtime: string }).runtime !== 'poly-runtime' || (w as { gated: boolean }).gated !== true) throw new LoadError(`refused at load: the certificate lists workflow ${w.name} as run by ${(w as { runtime: string }).runtime}, outside the gate; it predates S175, so admit the program again`);
    const d = JSON.parse(bytes.get(w.descriptor)!.toString('utf8')) as Omit<VerifiedWorkflow, 'machine'>;
    // Polywatch on step 2: the descriptor is the certificate entry's own, by name, so the runtime runs what was signed.
    if (d.name !== w.name) throw new LoadError(`refused at load: the certificate's workflow ${w.name} has the descriptor of workflow ${String(d.name)} (S173)`);
    const m = machines.find((x) => x.id === w.machine);
    if (!m) throw new LoadError(`refused at load: workflow ${w.name} runs ${w.machine}, which the certificate does not name`);
    for (const kind of Object.keys(d.tools ?? {})) {
      if (!m.manifest?.effects?.[kind]) throw new LoadError(`refused at load: workflow ${w.name} maps ${kind}, which is not an effect of ${w.machine} (S173)`);
    }
    workflows.push({ name: d.name, machine: w.machine, inputAction: d.inputAction, key: d.key, tools: d.tools });
  }
  const channels: VerifiedChannel[] = [];
  for (const c of certificate.poly?.channels ?? []) {
    const d = JSON.parse(bytes.get(c.descriptor)!.toString('utf8')) as VerifiedChannel;
    if (d.channel !== c.name || d.application !== c.application) throw new LoadError(`refused at load: the certificate's channel ${c.name} has the descriptor of channel ${String(d.channel)} of ${String(d.application)} (PS15)`);
    for (const id of [d.application, d.conversation]) if (!machines.some((x) => x.id === id)) throw new LoadError(`refused at load: channel ${c.name} names ${id}, which the certificate does not name (PS15)`);
    channels.push({ channel: d.channel, kind: d.kind, application: d.application, conversation: d.conversation, thread: d.thread, starts: d.starts, inbound: d.inbound, audience: d.audience ?? null });
  }
  // Review D4, D5 (M9): each credential's descriptor is the certificate entry's own, by name, and its Grant a machine
  // the certificate names; the runtime keeps what was read here and never reads the file again.
  const credentials: VerifiedCredential[] = [];
  for (const c of certificate.poly?.credentials ?? []) {
    const d = JSON.parse(bytes.get(c.descriptor)!.toString('utf8')) as { credential?: unknown; provider?: unknown; scopes?: unknown; holder?: unknown };
    if (d.credential !== c.name) throw new LoadError(`refused at load: the certificate's credential ${c.name} has the descriptor of credential ${String(d.credential)} (PT10e)`);
    const m = machines.find((x) => x.id.endsWith(`.${c.name}.Grant`));
    if (!m) throw new LoadError(`refused at load: credential ${c.name} has no Grant machine the certificate names (PS16.1)`);
    if (typeof d.provider !== 'string' || !Array.isArray(d.scopes) || typeof d.holder !== 'boolean') throw new LoadError(`refused at load: the descriptor of credential ${c.name} is not a credential's (PT10e)`);
    credentials.push({ name: c.name, machine: m.id, provider: d.provider, scopes: d.scopes as string[], holder: d.holder });
  }
  // PT10i: each source's descriptor is the certificate entry's own, by name; each flow descriptor its module's.
  const memorySources: SourceDescriptor[] = [];
  for (const s of certificate.poly?.memory?.sources ?? []) {
    const d = JSON.parse(bytes.get(s.descriptor)!.toString('utf8')) as SourceDescriptor;
    if (d.source !== s.name || d.adapter !== s.adapter) throw new LoadError(`refused at load: the certificate's source ${s.name} has the descriptor of source ${String(d.source)} (PT10i)`);
    memorySources.push(d);
  }
  const memoryFlows: FlowDescriptor[] = [];
  for (const f of certificate.poly?.memory?.flows ?? []) {
    const d = JSON.parse(bytes.get(f.descriptor)!.toString('utf8')) as FlowDescriptor;
    if (d.module !== f.module) throw new LoadError(`refused at load: the certificate's flow of ${f.module} has the descriptor of ${String(d.module)} (PT10i)`);
    memoryFlows.push(d);
  }
  // PT10r: each route's and budget's descriptor is the certificate entry's own, by name, and its machine one the
  // certificate names; the runtime keeps what was read here and never reads the file again.
  const routes: VerifiedRoute[] = [];
  for (const c of certificate.poly?.routes ?? []) {
    const d = JSON.parse(bytes.get(c.descriptor)!.toString('utf8')) as VerifiedRoute & { route?: unknown };
    if (d.route !== c.name) throw new LoadError(`refused at load: the certificate's route ${c.name} has the descriptor of route ${String(d.route)} (PT10r)`);
    for (const id of [d.machine, d.decision?.machine]) if (!machines.some((x) => x.id === id)) throw new LoadError(`refused at load: route ${c.name} names ${String(id)}, which the certificate does not name (PS18.2)`);
    if (!Array.isArray(d.tiers) || !d.tiers.length) throw new LoadError(`refused at load: the descriptor of route ${c.name} has no tier (PT10r)`);
    routes.push({ name: c.name, module: d.module, machine: d.machine, effectKind: d.effectKind, decision: d.decision, tiers: d.tiers, escalate: d.escalate, budget: d.budget ?? null });
  }
  // Review C7 (M11): each routed decision's certified tiers are the ones its route's descriptor runs (PT24.5).
  for (const d of certificate.poly?.decisions ?? []) {
    if (!('route' in d)) continue;
    const r = routes.find((x) => x.name === d.route);
    const runs = r ? r.tiers.map((t) => ({ name: t.name, provider: t.provider, model: t.model, calibration: t.calibration?.mapDigest ?? null })) : null;
    if (JSON.stringify(d.tiers) !== JSON.stringify(runs)) throw new LoadError(`refused at load: ${d.kind} of ${d.machine} is certified with the tiers ${JSON.stringify(d.tiers)}, and its route's descriptor runs ${JSON.stringify(runs)} (PT24.5)`);
  }
  const budgets: VerifiedBudget[] = [];
  for (const c of certificate.poly?.budgets ?? []) {
    const d = JSON.parse(bytes.get(c.descriptor)!.toString('utf8')) as VerifiedBudget & { budget?: unknown };
    if (d.budget !== c.name) throw new LoadError(`refused at load: the certificate's budget ${c.name} has the descriptor of budget ${String(d.budget)} (PT10r)`);
    if (!machines.some((x) => x.id === d.machine)) throw new LoadError(`refused at load: budget ${c.name} names ${String(d.machine)}, which the certificate does not name (PS18.4)`);
    budgets.push({ name: c.name, module: d.module, machine: d.machine, caps: d.caps, onExhausted: d.onExhausted });
  }
  return { certificate, root, runDir, machines, handlers, policies, workflows, channels, credentials, production: anchor?.production === true, anchorId: anchor?.id ?? null, memory: { sources: memorySources, flows: memoryFlows }, routes, budgets };
}

/**
 * Where the project's root sits in the handlers' copy: as many directories below `handlers` as the deepest certified
 * package lies above the project, so every '../' path stays inside the copy (polywatch on S154).
 */
function handlerCopyRoot(runDir: string, packageFiles: Record<string, string>): string {
  let up = 0;
  for (const p of Object.keys(packageFiles)) up = Math.max(up, (p.match(/^(\.\.\/)*/)![0].length) / 3);
  return join(runDir, 'handlers', ...Array.from({ length: up }, (_, k) => `up${k}`));
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
  const base = handlerCopyRoot(v.runDir, v.certificate.poly.handlers.packageFiles ?? {});
  for (const [p, want] of Object.entries(v.certificate.poly.handlers.packageFiles ?? {})) {
    const have = sha256OfBytes(readFileSync(join(base, ...p.split('/'))));
    if (have !== want) throw new LoadError(`refused at load: PL6403 HANDLER_CHANGED: the verified copy of ${p} changed before it was imported (certified ${want}, found ${have})`);
  }
  // S142: the handler copies too, before the runtime imports them.
  for (const [p, want] of Object.entries(v.certificate.poly.handlers.files)) {
    const have = sha256OfBytes(readFileSync(join(base, ...p.split('/'))));
    if (have !== want) throw new LoadError(`refused at load: PL6403 HANDLER_CHANGED: the verified copy of ${p} changed before it was imported (certified ${want}, found ${have})`);
  }
}
