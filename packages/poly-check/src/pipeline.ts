// The M0 check pipeline (02 §5, PT12, PT14): `poly check <file>`.
//
//   0  parse, type, domains          @poly/lang, @poly/core
//      lower, write .poly/build      @poly/lower
//   1  strict validate()             @cognitive-fab/sam-pattern
//   1b translation validation        @poly/ref (PS9.3)
//   2  model check                   polygraph (invariants, step and reject properties)
//   2b deadlock                      @poly/ref (PS5.6)
//   3  effects                       polyrun check-effects, confirmed by @poly/ref (PS5.4, S33)
//
// A stage that cannot run because an earlier one refused is listed as not
// run, with the reason; it never lowers the verdict (02 §5). No stage calls a
// language model.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { parse } from '@poly/lang';
import { checkModule, effectKind, effectSignature, fold, verdictOf, diag, loadProject, EXIT_CODES, type Diagnostic, type Module, type Verdict } from '@poly/core';
import type * as A from '@poly/core';
import { lowerMachine } from '@poly/lower';
import { translationValidate, confirmWitness, confirmEffectsWitness, checkJoint, jointStep, stimuliAt, flattenData, evaluate, type Joint, stateDigestOf, loadLoweredModule, keyOf, type MachineReport } from '@poly/ref';
import { check as polygraphCheck, type PolygraphViolation } from '@cognitive-fab/polygraph/scripts/check.mjs';
import { checkEffects } from '@cognitive-fab/polygraph/polyrun/src/check-effects.mjs';
import { checkProduct } from '@cognitive-fab/polygraph/polyrun/src/check-product.mjs';

export type StageName = 'parse-type' | 'lower' | 'validate' | 'translation-validation' | 'model-check' | 'deadlock' | 'effects' | 'composition';

export interface StageRecord {
  stage: StageName;
  status: 'ran' | 'not-run';
  engine: string;
  verdict?: Verdict;
  reason?: string;
  ms?: number;
  note?: string;
  /** Engine output that is not a finding and is printed as it is, never dropped (S39). */
  notes?: string[];
}

export interface MachineCheck {
  machine: string;
  stages: StageRecord[];
  /** Properties that were not checked, with the reason and the milestone that checks them (M1-2). */
  notRun: { property: string; reason: string }[];
  diagnostics: Diagnostic[];
  verdict: Verdict;
  instance?: InstanceRecord;
  buildDir?: string;
}

export interface InstanceRecord {
  domains: string[];
  states: number;
  transitions: number;
  bounds: string[];
  kernelAssumptions: string[];
  engines: Record<string, string>;
  /** S35: reject properties that name an action with no handler; polygraph never takes that step, so poly-ref alone decides them. */
  refOnly: { property: string; actions: string[] }[];
  /** S38: the machine emits and has no path property, so PL4002 is decided by poly-ref alone. */
  effectsByRefOnly?: boolean;
  /** PS7: the joint states of the parent and its attached children, when it has any. */
  jointStates?: number;
  /** The machine has attached children and no compose invariant, so check-product did not run. */
  compositionByRefOnly?: boolean;
}

export interface CheckReport {
  file: string;
  module: string | null;
  verdict: Verdict | 'NONDETERMINISM' | 'ERROR';
  exit: number;
  diagnostics: Diagnostic[];
  machines: MachineCheck[];
  error?: string;
  engines: Record<string, string>;
  /** S41: each effect kind the module declares, with what must agree across the project's modules. */
  effectKinds?: { kind: string; signature: string; effect: string; line?: number; col?: number }[];
}

export interface CheckOptions {
  /** Where `.poly/build` goes; the working directory by default (PT1.5). */
  root?: string;
}

const HERE_REQUIRE = createRequire(import.meta.url);

function versionOf(pkg: string): string {
  try { return (HERE_REQUIRE(`${pkg}/package.json`) as { version: string }).version; } catch { /* an exports map may hide package.json */ }
  try {
    // Walk up from the package's entry point to its package.json.
    let dir = dirname(HERE_REQUIRE.resolve(pkg));
    for (let k = 0; k < 6; k++, dir = dirname(dir)) {
      const p = join(dir, 'package.json');
      if (existsSync(p)) { const j = JSON.parse(readFileSync(p, 'utf8')); if (j.name === pkg) return j.version; }
    }
  } catch { /* reported as unknown */ }
  return 'unknown';
}

/** S16: polygraph replays and model-checks with its own vendored SAM build; record both versions. */
export function engineVersions(): Record<string, string> {
  let vendored = 'unknown';
  try {
    const path = HERE_REQUIRE.resolve('@cognitive-fab/polygraph/scripts/vendor/sam-pattern.cjs');
    vendored = /version:\s*([0-9][^\s]*)/.exec(readFileSync(path, 'utf8').slice(0, 2000))?.[1] ?? 'unknown';
  } catch { /* reported as unknown */ }
  return {
    'sam-pattern': versionOf('@cognitive-fab/sam-pattern'),
    polygraph: versionOf('@cognitive-fab/polygraph'),
    'polygraph sam-pattern (vendored)': vendored,
    'poly-ref': versionOf('@poly/ref'),
  };
}

export async function checkFile(file: string, opts: CheckOptions = {}): Promise<CheckReport> {
  const src = readFileSync(file, 'utf8');
  const report: CheckReport = { file, module: null, verdict: 'CLEAN', exit: 0, diagnostics: [], machines: [], engines: engineVersions() };

  // ── stage 0: parse, type, domains ─────────────────────────────────────
  const parsed = parse(src);
  report.diagnostics.push(...parsed.diagnostics);
  if (!parsed.module) return finish(report);
  const module = parsed.module;
  report.module = module.name;
  const checked = checkModule(module);
  report.diagnostics.push(...checked.diagnostics);
  report.effectKinds = [...checked.machines.values()].flatMap((f) => [...f.effects.values()].map((e) => ({ kind: effectKind(e), signature: effectSignature(e), effect: `${f.machine.name}.${e.name}`, line: e.span?.line, col: e.span?.col })));
  const refused = report.diagnostics.some((d) => d.severity === 'error');
  const engines = report.engines;

  for (const machine of checked.machines.keys()) {
    const mc: MachineCheck = { machine, stages: [], notRun: [], diagnostics: [], verdict: 'CLEAN' };
    // M1-2: liveness is checked from M2; each property is listed, never silently dropped (no silent clean).
    const decl = module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === machine);
    for (const it of decl?.items ?? []) {
      if (it.kind === 'Liveness') mc.notRun.push({ property: it.name, reason: 'liveness is checked from milestone M2 (PS6)' });
    }
    report.machines.push(mc);
    mc.stages.push({ stage: 'parse-type', status: 'ran', engine: '@poly/lang, @poly/core', verdict: refused ? 'REFUSED' : 'CLEAN' });
    if (refused) {
      notRun(mc, ['lower', 'validate', 'translation-validation', 'model-check', 'deadlock'], 'the program was refused at stage 0');
      continue;
    }
    try {
      await checkMachineStages(module, checked, machine, mc, opts, engines);
    } catch (e) {
      const err = e as Error & { nondeterministic?: boolean };
      report.error = `${machine}: ${err.message}`;
      report.verdict = err.nondeterministic ? 'NONDETERMINISM' : 'ERROR';
      report.exit = err.nondeterministic ? EXIT_CODES.NONDETERMINISM : EXIT_CODES.ERROR;
      return report;
    }
  }
  return finish(report, module);
}

/**
 * A copy of a lowered ES module named by its content. polyrun imports property modules by path, and Node
 * caches an import by URL for the life of the process, so a second check of the same machine in one
 * process would read the first check's properties. A content-addressed name changes when the file does.
 */
function byContent(dir: string, file: string): string {
  const text = readFileSync(join(dir, file), 'utf8');
  const copy = join(dir, `${file.replace(/\.mjs$/, '')}.${createHash('sha256').update(text).digest('hex').slice(0, 16)}.mjs`);
  if (!existsSync(copy)) writeFileSync(copy, text);
  return copy;
}

function notRun(mc: MachineCheck, stages: StageName[], reason: string): void {
  for (const stage of stages) mc.stages.push({ stage, status: 'not-run', engine: '', reason });
}

async function checkMachineStages(module: Module, checked: ReturnType<typeof checkModule>, machine: string, mc: MachineCheck, opts: CheckOptions, engines: Record<string, string>): Promise<void> {
  // ── lower ─────────────────────────────────────────────────────────────
  let t0 = performance.now();
  const { lowered, diagnostics } = lowerMachine(module, checked, machine);
  if (!lowered) {
    mc.diagnostics.push(...diagnostics);
    mc.stages.push({ stage: 'lower', status: 'ran', engine: '@poly/lower', verdict: 'REFUSED', ms: performance.now() - t0 });
    notRun(mc, ['validate', 'translation-validation', 'model-check', 'deadlock'], 'the lowering refused the machine');
    return;
  }
  const dir = join(resolve(opts.root ?? process.cwd()), '.poly', 'build', `${module.name}.${machine}`);
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(lowered.files)) writeFileSync(join(dir, f), text);
  mc.buildDir = dir;
  mc.stages.push({ stage: 'lower', status: 'ran', engine: '@poly/lower', verdict: 'CLEAN', ms: performance.now() - t0 });

  // ── stage 1: strict validate() ────────────────────────────────────────
  t0 = performance.now();
  // Finding 5: the lowered module is loaded with sam-pattern resolved from poly's own install, so any --root works.
  let mod: { instance: (o: object) => { validate: () => string[] } };
  try {
    mod = loadLoweredModule(join(dir, 'next.cjs'));
  } catch (e) {
    throw new Error(`the lowered module does not load: ${(e as Error).message}`);
  }
  let problems: string[];
  try { problems = mod.instance({}).validate(); } catch (e) { problems = [(e as Error).message]; }
  if (problems.length) {
    // S20: a lowered module that fails strict validation is a toolchain fault, PL2001, never the author's.
    mc.diagnostics.push(diag('PL2001', { module: module.name, machine }, `the lowered module fails strict validate(): ${problems.join('; ')} (addressed to the toolchain, not the author)`, { engine: `sam-pattern@${engines['sam-pattern']}` }));
    mc.stages.push({ stage: 'validate', status: 'ran', engine: `sam-pattern@${engines['sam-pattern']}`, verdict: 'REFUSED', ms: performance.now() - t0 });
    notRun(mc, ['translation-validation', 'model-check', 'deadlock'], 'strict validate() refused the lowered module (PL2001)');
    return;
  }
  mc.stages.push({ stage: 'validate', status: 'ran', engine: `sam-pattern@${engines['sam-pattern']}`, verdict: 'CLEAN', ms: performance.now() - t0 });

  // ── stage 1b: translation validation (PS9.3) ──────────────────────────
  t0 = performance.now();
  const tv = await translationValidate(module, machine, dir);
  const ref: MachineReport = tv.report;
  mc.instance = instanceRecord(ref, engines, refOnlyProperties(module, machine));
  if (tv.mismatches.length) {
    mc.diagnostics.push(...tv.mismatches.slice(0, 20));
    mc.stages.push({ stage: 'translation-validation', status: 'ran', engine: 'poly-ref', verdict: 'REFUSED', ms: performance.now() - t0, note: `${tv.mismatches.length} mismatches over ${tv.transitions} transitions` });
    notRun(mc, ['model-check', 'deadlock'], 'translation validation refused the lowering (PL2501)');
    return;
  }
  mc.stages.push({ stage: 'translation-validation', status: 'ran', engine: 'poly-ref', verdict: 'CLEAN', ms: performance.now() - t0, note: `${tv.transitions} transitions and ${tv.propertyChecks} property evaluations agree` });

  // ── stage 2: polygraph model check ────────────────────────────────────
  t0 = performance.now();
  const outside = new Set(ref.graph.edges.filter((e) => e.outcome.kind !== 'state').map((e) => keyOf({ ctor: '', payload: e.outcome.state })));
  // S5: polygraph cannot stop at a state outside the instance. Its cap is poly-ref's count, plus the
  // out-of-instance states, plus one; the cap hit that follows is expected and already reported (PL3901, PL3102).
  const maxStates = outside.size ? ref.states + outside.size + 1 : Math.max(ref.states + 1, 2);
  const inv = await import(pathToFileURL(join(dir, 'invariants.mjs')).href + `?v=${Date.now()}`);
  const contract = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf8'));
  const pg = polygraphCheck({ specModule: mod, contract, invariants: inv, maxStates });
  const stage2: Diagnostic[] = [];
  if (pg.error) throw new Error(`polygraph could not check the lowered module: ${pg.error}`);
  if (pg.nondeterministic) {
    mc.stages.push({ stage: 'model-check', status: 'ran', engine: `polygraph@${engines.polygraph}`, verdict: 'REFUSED', ms: performance.now() - t0, note: 'nondeterminism: two explorations differ' });
    throw Object.assign(new Error('polygraph found the lowered module nondeterministic (double pass)'), { nondeterministic: true });
  }
  if (!outside.size && pg.statesExplored !== ref.states) {
    stage2.push(diag('PL2501', { module: module.name, machine }, `polygraph explored ${pg.statesExplored} states of the lowered module and poly-ref ${ref.states}; with no state outside the instance they must agree`, { engine: `polygraph@${engines.polygraph}` }));
  }
  const at = { module: module.name, machine };
  // A flat key of the lowered module names a field of the source (PS9.1b).
  const fieldOf = (key: string) => lowered.layout.fields.find((l) => l.flat.includes(key))?.field ?? key;
  // Review finding 7: every polygraph finding is confirmed through poly-ref. It counts only if its
  // witness stays inside the checked instance (PS4.2); if the witness leaves the instance first, it is
  // a bound hit; if poly-ref disagrees inside the instance, the lowering is at fault (PL2501).
  for (const v of pg.violations) {
    const d = fromPolygraph(v, at, engines.polygraph, fieldOf);
    if (d.code === 'PL3001' || d.code === 'PL3002' || d.code === 'PL3003') {
      const named = v.kind === 'state' ? v.path[v.path.length - 1] : v.path[v.path.length - 2];
      if (named) d.stateDigest = stateDigestOf(ref, named.state);
    }
    if (v.kind !== 'state' && v.kind !== 'transition' && v.kind !== 'rejection') { stage2.push(d); continue; }
    const c = confirmWitness(ref, { kind: v.kind, property: v.invariant, path: v.path });
    if (c.status === 'confirmed') stage2.push(d);
    else if (c.status === 'outside') {
      stage2.push(diag('PL3901', at, `${v.invariant} is violated only on a path that leaves the checked instance at step ${c.step} (PS4.2a): a bound hit, not a finding`, { engine: d.engine, witness: d.witness }));
    } else {
      stage2.push(diag('PL2501', at, `polygraph reports ${v.invariant} violated, and poly-ref disagrees: ${c.reason} (addressed to the toolchain, not the author)`, { engine: d.engine, witness: d.witness }));
    }
  }
  const merged = mergeFindings(stage2, ref.findings, new Set(mc.instance.refOnly.map((r) => r.property)));
  mc.diagnostics.push(...merged);
  mc.stages.push({ stage: 'model-check', status: 'ran', engine: `polygraph@${engines.polygraph}`, verdict: verdictOf(merged), ms: performance.now() - t0, note: `${pg.statesExplored} states explored${pg.capHit ? `, cap ${maxStates} hit` : ''}` });

  // ── stage 2b: deadlock (PS5.6) ────────────────────────────────────────
  t0 = performance.now();
  const dead = ref.findings.filter((f) => f.code === 'PL3201');
  mc.diagnostics.push(...dead);
  mc.stages.push({ stage: 'deadlock', status: 'ran', engine: 'poly-ref', verdict: verdictOf(dead), ms: performance.now() - t0, note: ref.model.service ? 'service: exempt (PS1.7)' : `${ref.states} states` });

  // ── stage 3: effects (PS5.4, S33) ─────────────────────────────────────
  if (lowered.files['effects.cjs']) await effectsStage(module, machine, mc, dir, contract, ref, engines);

  // ── stage 4: attached children (PS7) ──────────────────────────────────
  if (checked.machines.get(machine)!.children.size) await compositionStage(module, checked, machine, mc, dir, opts, engines);
}

/**
 * Stage 4. poly-ref explores the joint machine of the parent and its attached children (PS7) and checks
 * the compose invariants and the doctrine classes (S47). polyrun's check-product explores the same joint
 * machine from the lowered artefacts; each of its findings is replayed through poly-ref's cascade and must
 * agree (PL2501 otherwise), and with no cap hit the two must count the same joint states. check-product
 * needs a compose invariant, so with none the stage is poly-ref's alone and says so (as S38 does). The
 * joint semantics rests on K1 to K3 (PS7.4) and K9 (S45), which the instance line lists.
 */
async function compositionStage(module: Module, checked: ReturnType<typeof checkModule>, machine: string, mc: MachineCheck, dir: string, opts: CheckOptions, engines: Record<string, string>): Promise<void> {
  const t0 = performance.now();
  const at = { module: module.name, machine };
  const engine = `polyrun@${engines.polygraph}`;
  const joint = checkJoint(module, machine);
  mc.instance!.kernelAssumptions = ['K1', 'K2', 'K3', 'K7', 'K9'];
  mc.instance!.jointStates = joint.states;
  const out: Diagnostic[] = [];
  const facts = checked.machines.get(machine)!;
  const hasCompose = facts.machine.items.some((i) => i.kind === 'Property' && i.form === 'compose');
  if (!hasCompose) {
    out.push(...joint.findings);
    mc.diagnostics.push(...out);
    mc.instance!.compositionByRefOnly = true;
    mc.stages.push({ stage: 'composition', status: 'ran', engine: 'poly-ref', verdict: verdictOf(out), ms: performance.now() - t0, note: `${joint.states} joint states; no compose invariant, so polyrun check-product did not run` });
    return;
  }
  // Each child machine is lowered where the engines read it (S28: <module>.<Machine>).
  const root = join(resolve(opts.root ?? process.cwd()), '.poly', 'build');
  const children = [...new Set([...facts.children.values()].map((c) => c.machine))].map((id) => {
    const name = id.split('.').pop()!;
    const { lowered } = lowerMachine(module, checked, name);
    if (!lowered) throw new Error(`the child machine ${id} does not lower`);
    const cdir = join(root, id);
    mkdirSync(cdir, { recursive: true });
    for (const [f, text] of Object.entries(lowered.files)) writeFileSync(join(cdir, f), text);
    return { machineId: id, module: join(cdir, 'next.cjs'), contract: join(cdir, 'contract.json') };
  });
  const r = await checkProduct({
    parent: { machineId: `${module.name}.${machine}`, module: join(dir, 'next.cjs'), contract: join(dir, 'contract.json'), mapper: join(dir, 'effects.cjs'), manifest: join(dir, 'effects.manifest.json') },
    children,
    invariants: byContent(dir, 'invariants.compose.mjs'),
    maxStates: joint.states + 1,
  });
  if (r.nondeterministic) throw Object.assign(new Error('polyrun check-product found the lowered machines nondeterministic (double pass)'), { nondeterministic: true });
  if (!r.capHit && !joint.capHit && r.statesExplored !== joint.states) {
    out.push(diag('PL2501', at, `polyrun check-product explored ${r.statesExplored} joint states and poly-ref ${joint.states}; with no cap hit they must agree (addressed to the toolchain, not the author)`, { engine }));
  }
  const confirmed = new Set<string>();
  for (const v of r.violations) {
    const replay = replayProduct(joint, facts.machine, v.path.slice(1).map((s) => s.stimulus!));
    if (typeof replay === 'string') { out.push(diag('PL2501', at, `polyrun check-product reports ${v.invariant}, and poly-ref cannot follow its path: ${replay} (addressed to the toolchain, not the author)`, { engine })); continue; }
    const code = productCode(v);
    if (code === 'PL2501') { out.push(diag('PL2501', at, `polyrun check-product reports ${v.invariant}${v.detail ? `: ${v.detail}` : ''}, which a poly program cannot reach unless its lowering lost something (S47; addressed to the toolchain, not the author)`, { engine })); continue; }
    const agrees = code === 'PL5001' ? replay.violates.has(v.invariant) : replay.doctrine.has(code);
    if (!agrees) { out.push(diag('PL2501', at, `polyrun check-product reports ${v.invariant}, and poly-ref's cascade does not (addressed to the toolchain, not the author)`, { engine })); continue; }
    confirmed.add(code === 'PL5001' ? `PL5001:${v.invariant}` : code);
  }
  for (const f of joint.findings) {
    const key = f.code === 'PL5001' ? `PL5001:${f.property}` : f.code;
    out.push(confirmed.has(key) ? { ...f, engine: `${f.engine}, ${engine}` } : f);
  }
  mc.diagnostics.push(...out);
  mc.stages.push({ stage: 'composition', status: 'ran', engine: `${engine}, poly-ref`, verdict: verdictOf(out), ms: performance.now() - t0, note: `${joint.states} joint states (polyrun ${r.statesExplored})`, notes: r.notes.length ? r.notes.map((n) => `polyrun: ${n}`) : undefined });

  /** The poly code of a check-product finding (S47). */
  function productCode(v: { invariant: string; kind: string; detail?: string }): string {
    if (v.kind === 'state' || v.kind === 'transition') return 'PL5001';
    if (v.kind === 'poison') return /exceeded depth/.test(v.detail ?? '') ? 'PL5201' : /no child with key/.test(v.detail ?? '') ? 'PL5104' : 'PL2501';
    if (v.invariant.startsWith('childkey-collision')) return 'PL5101';
    if (v.invariant.startsWith('unhandled-delivery')) return 'PL5102';
    return 'PL2501';
  }
}

/** Replays check-product's stimuli through poly-ref's cascade: the compose invariants violated at the end, and the doctrine the last step raises. */
function replayProduct(report: ReturnType<typeof checkJoint>, machine: A.Machine, stimuli: { target: string; action: string; data: unknown }[]): { violates: Set<string>; doctrine: Set<string> } | string {
  const g = report.graph;
  let j: Joint = g.states[0];
  let doctrine = new Set<string>();
  const stable = (v: unknown): string => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`);
  const childMachines = new Map([...g.states.flatMap((s) => s.children.map(([, c]) => [c.machine.id, c.machine] as const))]);
  for (const st of stimuli) {
    const target = st.target === 'parent' ? j.parent : j.children.find(([k]) => k === st.target)?.[1];
    if (!target) return `no instance ${st.target}`;
    const stim = stimuliAt(j).find((x) => x.target === st.target && x.action === st.action && stable(flattenData(x.data, x.action, target.machine)) === stable(st.data));
    if (!stim) return `${st.target}.${st.action} ${stable(st.data)} is not offered in that joint state`;
    const step = jointStep(j, stim, childMachines);
    doctrine = new Set(step.doctrine.map((d) => d.code));
    j = step.joint;
  }
  // PS7.3: each compose invariant, evaluated by poly-ref on the joint state polyrun's path reaches.
  const violates = new Set<string>();
  for (const p of machine.items) {
    if (p.kind !== 'Property' || p.form !== 'compose') continue;
    const env = { M: j.parent.machine, state: j.parent.state, data: {}, locals: new Map(), joint: { parent: j.parent.state, children: new Map(j.children.map(([k, c]) => [k, c.state])) } };
    if (evaluate(p.expr, env) !== true) violates.add(p.name);
  }
  return { violates, doctrine };
}

/**
 * Stage 3. polyrun's `check-effects` explores the lowered module with its effects mapper and evaluates the
 * path properties; every finding it reports is confirmed through poly-ref (review finding 7, extended to
 * polyrun in M1). poly-ref decides the same questions exactly, over every path of I with cycles, so its
 * findings stand where polyrun's simple-path exploration cannot see them. A disagreement inside the
 * instance is the toolchain's (PL2501).
 */
async function effectsStage(module: Module, machine: string, mc: MachineCheck, dir: string, contract: unknown, ref: MachineReport, engines: Record<string, string>): Promise<void> {
  const t0 = performance.now();
  const at = { module: module.name, machine };
  const engine = `polyrun@${engines.polygraph}`;
  const fromRef = ref.findings.filter((f) => f.code === 'PL4001' || f.code === 'PL4002');
  const hasPath = existsSync(join(dir, 'effect-invariants.mjs'));
  if (!hasPath) {
    // S38: check-effects needs at least one path property, so PL4002 is poly-ref's alone.
    mc.diagnostics.push(...fromRef);
    mc.stages.push({ stage: 'effects', status: 'ran', engine: 'poly-ref', verdict: verdictOf(fromRef), ms: performance.now() - t0, note: 'no path property, so polyrun check-effects did not run; PL4002 decided by poly-ref alone (S38)' });
    mc.instance!.effectsByRefOnly = true;
    return;
  }
  const r = await checkEffects({
    module: join(dir, 'next.cjs'), mapper: join(dir, 'effects.cjs'), manifest: join(dir, 'effects.manifest.json'), invariants: byContent(dir, 'effect-invariants.mjs'),
    contract,
    // A simple path visits each state at most once, so the reachable states bound its length.
    maxDepth: Math.max(ref.states, 1),
  });
  const out: Diagnostic[] = [];
  const notes: string[] = [];
  // What polyrun confirmed, finding by finding: PL4001 by property, PL4002 by the action of its step.
  const agreed = new Set<string>();
  const pathNames = new Set(ref.model.pathProperties.map((p) => p.name));
  for (const v of r.violations) {
    if (v.invariant === 'cycle-edge-emits') {
      const more = (r.violationCounts[v.invariant] ?? 1) - 1;
      notes.push(`polyrun reports cycle-edge-emits at ${v.counterexample.join(', ')}${more > 0 ? ` (and ${more} more)` : ''}, emitting ${v.emitted.map((x) => x.kind).join(', ')}: a note, not a poly property; path properties are decided over every path, cycles included, by poly-ref (S39)`);
      continue;
    }
    const kind = v.invariant === 'identity-accept-emits' ? 'identity' : pathNames.has(v.invariant) && !v.detail ? 'path' : null;
    if (!kind) {
      out.push(diag('PL2501', at, `polyrun check-effects reports ${v.invariant}${v.detail ? `: ${v.detail}` : ''} at ${v.counterexample.join(', ')} (addressed to the toolchain, not the author)`, { engine }));
      continue;
    }
    const c = confirmEffectsWitness(ref, { kind, property: v.invariant, steps: v.counterexample });
    const code = kind === 'path' ? 'PL4001' : 'PL4002';
    if (c.status === 'disagrees') { out.push(diag('PL2501', at, `polyrun reports ${v.invariant} at ${v.counterexample.join(', ')}, and poly-ref disagrees: ${c.reason} (addressed to the toolchain, not the author)`, { engine })); continue; }
    if (c.status === 'outside') { out.push(diag('PL3901', at, `${v.invariant} is reported only on a path that leaves the checked instance at step ${c.step} (PS4.2a): a bound hit, not a finding`, { engine })); continue; }
    const lastStep = v.counterexample[v.counterexample.length - 1] ?? '';
    agreed.add(`${code}:${kind === 'path' ? v.invariant : lastStep.slice(0, lastStep.indexOf('('))}`);
  }
  // poly-ref's finding carries the shortest witness; polyrun's confirmed one says the engine agrees.
  for (const f of fromRef) {
    if (agreed.has(`${f.code}:${f.property}`)) { out.push({ ...f, engine: `${f.engine}, ${engine}` }); continue; }
    // polyrun keeps one example per finding kind, so another action's identity-accept-emits may stand
    // behind the one it printed; only no report at all, from an unbounded run, is a disagreement.
    const polyrunIdle = r.violations.some((v) => v.invariant === 'identity-accept-emits');
    if (f.code === 'PL4002' && !polyrunIdle && !r.bounded) out.push(diag('PL2501', at, `poly-ref finds ${f.property} emitting without a state change, and polyrun check-effects, which visits every reachable state, does not (addressed to the toolchain, not the author)`, { engine }));
    else if (f.code === 'PL4002') out.push({ ...f, message: `${f.message} (poly-ref: polyrun check-effects prints one identity-accept-emits example, for another action)` });
    // polyrun extends a path only by a step that changes the state, and only along simple paths, so a
    // violation that needs a repeated or a state-preserving step is poly-ref's to find.
    else out.push({ ...f, message: `${f.message} (poly-ref alone: polyrun check-effects explores simple paths and does not extend a path by a step that leaves the state unchanged)` });
  }
  mc.diagnostics.push(...out);
  const coverage = r.bounded ? 'bounded' : r.cyclesPruned ? `simple paths, ${r.cyclesPruned} cycle edges pruned` : 'exhaustive';
  mc.stages.push({ stage: 'effects', status: 'ran', engine: `${engine}, poly-ref`, verdict: verdictOf(out), ms: performance.now() - t0, note: `${r.pathsExplored} paths, ${r.statesSeen} states, ${coverage}`, notes });
}

function fromPolygraph(v: PolygraphViolation, at: { module: string; machine: string }, version: string, fieldOf: (flatKey: string) => string): Diagnostic {
  const engine = `polygraph@${version}`;
  const trace = v.path.slice(1).map((step, i) => ({ pre: v.path[i].state, action: String(step.action), data: step.data, post: step.state, ...(step.rejected ? { verdict: `rejected(${step.reason})` } : {}) }));
  const witness = { id: '', length: trace.length, trace };
  const name = v.invariant;
  // Review finding 8: each diagnostic says which property or field it is about, as data.
  if (v.kind === 'state') {
    const auto = /^(domain|shape|bound):(.*)$/.exec(name);
    if (auto && auto[1] === 'bound') return diag('PL3901', at, `${auto[2]} leaves its check domain (polygraph)`, { engine, witness, field: fieldOf(auto[2]) });
    if (auto) return diag('PL3102', at, `${name} is violated: a value leaves its declared type`, { engine, witness, field: fieldOf(auto[2]) });
    return diag('PL3001', at, `invariant ${name} is violated in a reachable state`, { engine, witness, property: name });
  }
  if (v.kind === 'transition') return diag('PL3002', at, `step property ${name} is violated`, { engine, witness, property: name });
  if (v.kind === 'rejection') return diag('PL3003', at, `reject property ${name} is violated`, { engine, witness, property: name });
  return diag('PL2501', at, `polygraph: ${name}: ${v.detail ?? ''}`, { engine, witness });
}

const mergeKey = (d: Diagnostic) => `${d.code}:${d.property ?? d.field ?? '*'}`;

/**
 * Stage 2's findings: polygraph's (already confirmed through poly-ref), then poly-ref's for anything
 * polygraph did not report. poly-ref is authoritative inside Reach(I), which polygraph's cap may
 * truncate (S5). Results merge on (code, property or field), never on message text (finding 8).
 */
export function mergeFindings(fromPolygraph: Diagnostic[], fromRef: Diagnostic[], refOnly: Set<string> = new Set()): Diagnostic[] {
  const out = [...fromPolygraph];
  const have = new Set(out.map(mergeKey));
  for (const f of fromRef) {
    if (f.code === 'PL3201' || f.code === 'PL4001' || f.code === 'PL4002') continue; // stage 2b reports deadlocks, stage 3 path properties
    if (have.has(mergeKey(f))) continue;
    // Finding 6: an escape or bound is kept per field, and poly-ref's exploration cap (no field) on its own.
    if (f.code === 'PL3003' && f.property && refOnly.has(f.property)) {
      out.push({ ...f, message: `${f.message} (poly-ref alone: the property names an action with no handler, which polygraph never takes, S35)` });
      have.add(mergeKey(f));
      continue;
    }
    const capped = f.code === 'PL3001' || f.code === 'PL3002' || f.code === 'PL3003';
    out.push(capped ? { ...f, message: `${f.message} (poly-ref; polygraph's exploration was capped at the bound)` } : f);
    have.add(mergeKey(f));
  }
  return out;
}

/**
 * S35: the reject properties that name an action with no handler. Such an action is not in the lowered
 * module, so polygraph never takes its step and cannot check the property on it; poly-ref, which explores
 * every action, decides it alone, and the verdict record says so.
 */
export function refOnlyProperties(module: Module, machine: string): { property: string; actions: string[] }[] {
  const decl = module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === machine);
  if (!decl) return [];
  const handled = new Set(decl.items.filter((i): i is A.Handler => i.kind === 'Handler').map((h) => h.action));
  const handlerless = new Set(decl.items.filter((i): i is A.Action => i.kind === 'Action' && !handled.has(i.name)).map((a) => a.name));
  const out: { property: string; actions: string[] }[] = [];
  for (const p of decl.items) {
    if (p.kind !== 'Property' || p.form !== 'reject') continue;
    const named = new Set<string>();
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const node = n as { kind?: string; name?: string };
      if (node.kind === 'Name' && node.name && handlerless.has(node.name)) named.add(node.name);
      for (const [k, v] of Object.entries(n)) if (k !== 'span') walk(v);
    };
    walk(p.expr);
    if (named.size) out.push({ property: p.name, actions: [...named].sort() });
  }
  return out;
}

function instanceRecord(ref: MachineReport, engines: Record<string, string>, refOnly: { property: string; actions: string[] }[] = []): InstanceRecord {
  const bounds = [...new Set(ref.findings.filter((f) => f.code === 'PL3901').map((f) => f.field ?? 'exploration cap'))];
  return {
    domains: [...ref.instance.fields.map((f) => `${f.name} ∈ ${f.domain}`), ...ref.instance.params.map((p) => `${p.name} ∈ ${p.domain}`)],
    states: ref.states,
    transitions: ref.transitions,
    bounds,
    // M0 checks one machine's relation: K7 (profile fidelity) is the kernel assumption its guarantee uses (PS10).
    kernelAssumptions: ['K7'],
    engines,
    refOnly,
  };
}

function finish(report: CheckReport, module?: Module): CheckReport {
  // Engine diagnostics carry no source position. One that names a node (a property, a handler) points at
  // that node's line; any other points at the machine's declaration (display only, PT12.1).
  const spans = new Map<string, { line: number; col: number }>();
  const index = (x: unknown): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(index); return; }
    const n = x as { id?: string; span?: { line: number; col: number } };
    if (n.id && n.span) spans.set(n.id, n.span);
    for (const [k, v] of Object.entries(x)) if (k !== 'span') index(v);
  };
  if (module) index(module.decls);
  for (const m of report.machines) {
    const decl = module?.decls.find((d) => d.kind === 'Machine' && d.name === m.machine);
    for (const d of m.diagnostics) {
      if (d.at.line !== undefined) continue;
      // polygraph names a property but no node: the property's declaration is the place.
      const prop = d.property ? decl?.kind === 'Machine' ? decl.items.find((i) => i.kind === 'Property' && i.name === d.property) : undefined : undefined;
      const span = (d.at.node && spans.get(d.at.node)) || prop?.span || decl?.span;
      // Diagnostics of one stage can share their `at` object, so each gets its own copy.
      if (span) d.at = { ...d.at, line: span.line, col: span.col };
    }
  }
  // A property not run keeps the verdict from CLEAN: INCONCLUSIVE at best, FINDINGS if a safety check failed (M1-2).
  for (const m of report.machines) m.verdict = fold([verdictOf(m.diagnostics), ...m.stages.filter((s) => s.verdict).map((s) => s.verdict!), ...(m.notRun.length ? ['INCONCLUSIVE' as Verdict] : [])]);
  const v = fold([verdictOf(report.diagnostics), ...report.machines.map((m) => m.verdict)]);
  report.verdict = v;
  report.exit = EXIT_CODES[v];
  return report;
}


// ── project mode (PT1.2, decision M1-6) ────────────────────────────────────

export interface ProjectReport {
  project: string;
  name: string;
  files: CheckReport[];
  verdict: CheckReport['verdict'];
  exit: number;
}

/**
 * `poly check <dir>`: every module the manifest names, each through the whole
 * pipeline. The build goes under the project directory unless --root says
 * otherwise (PT1.5). The project verdict is the fold of the files' verdicts;
 * an error or a nondeterminism in any file decides it.
 */
export async function checkProject(dir: string, opts: CheckOptions = {}): Promise<ProjectReport> {
  const { manifest, files } = loadProject(dir);
  const reports: CheckReport[] = [];
  for (const f of files) reports.push(await checkFile(f, { root: opts.root ?? dir }));
  // S41: polyrun keys handlers by kind across the whole deployment, so effects of one kind must agree
  // across the project's modules. A disagreement is reported in the later file and refuses it.
  const first = new Map<string, { report: CheckReport; k: NonNullable<CheckReport['effectKinds']>[number] }>();
  for (const report of reports) {
    for (const k of report.effectKinds ?? []) {
      const seen = first.get(k.kind);
      if (!seen) { first.set(k.kind, { report, k }); continue; }
      if (seen.report === report || seen.k.signature === k.signature) continue;
      report.diagnostics.push(diag('PL1002', { module: report.module ?? undefined, line: k.line, col: k.col }, `effect ${k.effect} has kind "${k.kind}", which ${seen.report.module}.${seen.k.effect} declares with a different payload, completions or class (S41)`));
      finish(report);
    }
  }
  const special = reports.find((r) => r.verdict === 'ERROR') ?? reports.find((r) => r.verdict === 'NONDETERMINISM');
  const verdict = special ? special.verdict : fold(reports.map((r) => r.verdict as Verdict));
  return { project: dir, name: manifest.name, files: reports, verdict, exit: special ? special.exit : EXIT_CODES[verdict as Verdict] };
}
