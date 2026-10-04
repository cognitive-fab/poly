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
import { readFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importArtefact } from './import-artefact.js';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { parse, printExpr } from '@poly/lang';
import { readEmbedded } from '@poly/embed';
import { canonicalize, digest, sha256Hex, checkModule, effectKind, effectSignature, fold, verdictOf, diag, loadProject, EXIT_CODES, type Diagnostic, type Module, type Verdict } from '@poly/core';
import type * as A from '@poly/core';
import { lowerMachine } from '@poly/lower';
import { attachFixes } from './fixes.js';
import { exportable } from './witness.js';
import { handlerClosure } from './handlers.js';
import { policyReports, type PolicyReport } from './policies.js';
import { translationValidate, confirmWitness, confirmEffectsWitness, checkJoint, conjunction, checkConfiguration, jointStep, stimuliAt, flattenData, evaluate, type Joint, stateDigestOf, loadLoweredModule, keyOf, type MachineReport, type Vacuous } from '@poly/ref';
import { check as polygraphCheck, type PolygraphViolation } from '@cognitive-fab/polygraph/scripts/check.mjs';
import { checkEffects } from '@cognitive-fab/polygraph/polyrun/src/check-effects.mjs';
import { checkProduct } from '@cognitive-fab/polygraph/polyrun/src/check-product.mjs';

export type StageName = 'parse-type' | 'lower' | 'validate' | 'translation-validation' | 'model-check' | 'deadlock' | 'liveness' | 'effects' | 'decisions' | 'composition' | 'configuration' | 'workflow';

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
  /** PT12.3, S128: properties whose antecedent is never true where they are judged; each makes the verdict INCONCLUSIVE. */
  vacuous: VacuousRecord[];
  diagnostics: Diagnostic[];
  verdict: Verdict;
  instance?: InstanceRecord;
  buildDir?: string;
  /** Review A1: the SHA-256 of each artefact as the lowering wrote it, the bytes every later stage checked. */
  artefactDigests?: Record<string, string>;
}

/** A vacuous property (PT12.3, S128): its name, its antecedent's source text, and the member it never held for. */
export interface VacuousRecord {
  property: string;
  reason: 'vacuous';
  antecedent: string;
  member?: number;
}

function vacuousRecords(list: Vacuous[]): VacuousRecord[] {
  return list.map((v) => ({
    property: v.property,
    reason: 'vacuous',
    // Review D5: printed as one conjunction, so a part that needs parentheses keeps them.
    antecedent: v.text ?? printExpr(conjunction(v.parts)),
    ...(v.member !== undefined ? { member: v.member } : {}),
  }));
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

/** Stage 4b for one configuration (PS13): poly-ref's exploration of its global states. */
export interface ConfigCheck {
  configuration: string;
  stages: StageRecord[];
  /** Liveness properties, listed as not run (M1-2). */
  notRun: { property: string; reason: string }[];
  /** PT12.3, S128: as for a machine. */
  vacuous: VacuousRecord[];
  diagnostics: Diagnostic[];
  verdict: Verdict;
  /** The checked instance (PT12.3a): the instances, the bounds, and what the verdict assumes. */
  instance?: {
    instances: string[];
    states: number;
    transitions: number;
    bounds: string[];
    kernelAssumptions: string[];
  };
}

export interface CheckReport {
  file: string;
  module: string | null;
  /** The module digest (PT1.4) the witnesses and fixes of this report were computed on (S69). */
  moduleDigest?: string;
  /** Review A2: the SHA-256 of the source text the check read. */
  sourceDigest?: string;
  verdict: Verdict | 'NONDETERMINISM' | 'ERROR';
  exit: number;
  diagnostics: Diagnostic[];
  machines: MachineCheck[];
  /** Stage 4b: each configuration of the module (PS13). */
  configurations: ConfigCheck[];
  error?: string;
  engines: Record<string, string>;
  /** Stage 5 (PT8): the module's policies, one report per trust scope. */
  policies: PolicyReport[];
  /** S41: each effect kind the module declares, with what must agree across the project's modules. */
  effectKinds?: { kind: string; signature: string; effect: string; line?: number; col?: number }[];
}

export interface CheckOptions {
  /** Where `.poly/build` goes; the working directory by default (PT1.5). */
  root?: string;
  /** PT8: the modules the policies of this file govern; the file's own module when it is checked alone. */
  program?: Module[];
  /** PT6.5, S152: generate the OpenShell sandbox policies (poly.json's `isolation`). */
  isolation?: 'openshell';
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
  // The source's absolute path, so a later `poly witness` or `poly fix` finds it from any directory (review D4).
  const report: CheckReport = { file: resolve(file), module: null, sourceDigest: 'sha256:' + createHash('sha256').update(src, 'utf8').digest('hex'), verdict: 'CLEAN', exit: 0, diagnostics: [], machines: [], configurations: [], policies: [], engines: engineVersions() };

  // ── stage 0: parse, type, domains ─────────────────────────────────────
  // S71: a .ts module is read by poly-embed into the same AST; everything after this line is shared.
  const parsed = file.endsWith('.ts') ? readEmbedded(src, file) : parse(src);
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
    const mc: MachineCheck = { machine, stages: [], notRun: [], vacuous: [], diagnostics: [], verdict: 'CLEAN' };
    report.machines.push(mc);
    mc.stages.push({ stage: 'parse-type', status: 'ran', engine: '@poly/lang, @poly/core', verdict: refused ? 'REFUSED' : 'CLEAN' });
    if (refused) {
      notRun(mc, ['lower', 'validate', 'translation-validation', 'model-check', 'deadlock', ...laterStages(checked, machine)], 'the program was refused at stage 0');
      continue;
    }
    try {
      await checkMachineStages(module, checked, machine, mc, opts, engines);
    } catch (e) {
      const err = e as Error & { nondeterministic?: boolean };
      // No silent clean in the JSON form either: the machine that stopped and every machine and configuration
      // after it list what did not run, and none of them folds to CLEAN (polywatch, rated at M2's start).
      const reason = `the check stopped with an error in ${machine}`;
      const done = new Set(mc.stages.map((st) => st.stage));
      notRun(mc, (['lower', 'validate', 'translation-validation', 'model-check', 'deadlock', ...laterStages(checked, machine)] as StageName[]).filter((st) => !done.has(st)), reason);
      const cut = [mc];
      for (const rest of [...checked.machines.keys()].slice([...checked.machines.keys()].indexOf(machine) + 1)) {
        const other: MachineCheck = { machine: rest, stages: [], notRun: [], vacuous: [], diagnostics: [], verdict: 'CLEAN' };
        notRun(other, ['lower', 'validate', 'translation-validation', 'model-check', 'deadlock', ...laterStages(checked, rest)], reason);
        report.machines.push(other);
        cut.push(other);
      }
      for (const d of module.decls) if (d.kind === 'Configuration') report.configurations.push({ configuration: d.name, stages: [{ stage: 'configuration', status: 'not-run', engine: '', reason }], notRun: [], vacuous: [], diagnostics: [], verdict: 'INCONCLUSIVE' });
      finish(report, module);
      for (const m of cut) m.verdict = fold([m.verdict, 'INCONCLUSIVE']);
      report.error = `${machine}: ${err.message}`;
      report.verdict = err.nondeterministic ? 'NONDETERMINISM' : 'ERROR';
      report.exit = err.nondeterministic ? EXIT_CODES.NONDETERMINISM : EXIT_CODES.ERROR;
      return report;
    }
  }
  // ── stage 4b: configurations (PS13) ─────────────────────────────────────
  const configs = configurationReports(module, refused);
  report.configurations.push(...configs.configurations);
  // ── stage 5: policies (PT8) ─────────────────────────────────────────────
  if (module.decls.some((d) => d.kind === 'Policy')) {
    if (refused) {
      for (const d of module.decls) if (d.kind === 'Policy') report.policies.push({ scope: d.scope, policies: [d.name], stages: [{ stage: 'policy-types', status: 'not-run', engine: '', reason: 'the program was refused at stage 0' }], notRun: [], vacuous: [], diagnostics: [], verdict: 'INCONCLUSIVE', reads: [] });
    } else {
      try { report.policies.push(...await policyReports(module, opts.program ?? [module], resolve(opts.root ?? process.cwd()))); } catch (e) {
        finish(report, module);
        report.error = `policies: ${(e as Error).message}`;
        report.verdict = 'ERROR';
        report.exit = EXIT_CODES.ERROR;
        return report;
      }
    }
  }
  if (configs.error) {
    // As for a machine's stages: a throw is an ERROR report, never a rejected check (review finding).
    finish(report, module);
    report.error = configs.error;
    report.verdict = 'ERROR';
    report.exit = EXIT_CODES.ERROR;
    return report;
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

/**
 * PT10, S165: polyflow admits a workflow only if check-effects over its contract finds no violation and is not bounded
 * (depth 12, 50,000 paths). The stage runs that admission itself, with the vendored library's certify, so a workflow
 * poly reports CLEAN is one polyflow admits; a bounded run is INCONCLUSIVE (PL3901), never CLEAN. A violation polyflow
 * reports is one of the machine's path properties, which the effects stage decides over every path; it is listed here
 * as polyflow's refusal.
 */
async function workflowStage(moduleName: string, w: A.Workflow, mc: MachineCheck, dir: string): Promise<void> {
  const t0 = performance.now();
  const engine = '@cognitive-fab/polyflow-server@0.4.2 (certify)';
  const at = { module: moduleName, machine: mc.machine, node: w.id, line: w.span?.line, col: w.span?.col };
  const { Library } = await import('@cognitive-fab/polyflow-server/library');
  const wf = new Library(join(dir, '..', 'workflows')).load().get(w.name);
  if (!wf) {
    mc.diagnostics.push(diag('PL2501', at, `polyflow does not load the workflow ${w.name} from its lowered descriptor (addressed to the toolchain, not the author)`, { engine }));
    mc.stages.push({ stage: 'workflow', status: 'ran', engine, verdict: 'REFUSED', ms: performance.now() - t0 });
    return;
  }
  const c = await new Library(join(dir, '..', 'workflows')).certify(wf);
  const out: Diagnostic[] = [];
  if (c.bounded) out.push(diag('PL3901', at, `workflow ${w.name}: polyflow's admission explores at most depth 12 and 50,000 paths, and this machine's emission paths go beyond them, so polyflow would refuse it (S165)`, { engine }));
  for (const v of c.violations) out.push(diag('PL4001', at, `workflow ${w.name}: polyflow's admission finds a path that violates ${v.invariant ?? v.name ?? 'an effect invariant'}, so it would refuse the workflow (S165)`, { engine }));
  mc.diagnostics.push(...out);
  mc.stages.push({ stage: 'workflow', status: 'ran', engine, verdict: verdictOf(out), ms: performance.now() - t0, note: `polyflow ${c.ok ? 'admits' : 'refuses'} ${w.name} (${c.pathsExplored} paths); it runs on polyflow, outside the gate (S164)` });
}

/** Stages 2c, 3 and 4, where the machine has them: listed as not run when an earlier stage stops (review finding P7). */
function laterStages(checked: ReturnType<typeof checkModule>, machine: string): StageName[] {
  const f = checked.machines.get(machine)!;
  const mapper = f.effects.size > 0 || f.decisions.size > 0 || f.timerKeys.size > 0 || f.children.size > 0 || kernelIntents(f.machine).length > 0;
  const live = f.machine.items.some((i) => i.kind === 'Liveness');
  return [...(live ? ['liveness' as const] : []), ...(mapper ? ['effects' as const] : []), ...(f.decisions.size ? ['decisions' as const] : []), ...(f.children.size ? ['composition' as const] : [])];
}

function notRun(mc: MachineCheck, stages: StageName[], reason: string): void {
  for (const stage of stages) mc.stages.push({ stage, status: 'not-run', engine: '', reason });
}

async function checkMachineStages(module: Module, checked: ReturnType<typeof checkModule>, machine: string, mc: MachineCheck, opts: CheckOptions, engines: Record<string, string>): Promise<void> {
  // ── lower ─────────────────────────────────────────────────────────────
  let t0 = performance.now();
  const { lowered, diagnostics } = lowerMachine(module, checked, machine, opts.isolation ? { isolation: opts.isolation } : {});
  if (!lowered) {
    mc.diagnostics.push(...diagnostics);
    mc.stages.push({ stage: 'lower', status: 'ran', engine: '@poly/lower', verdict: 'REFUSED', ms: performance.now() - t0 });
    notRun(mc, ['validate', 'translation-validation', 'model-check', 'deadlock', ...laterStages(checked, machine)], 'the lowering refused the machine');
    return;
  }
  const dir = join(resolve(opts.root ?? process.cwd()), '.poly', 'build', `${module.name}.${machine}`);
  // A file left by an earlier build (effects.cjs, effect-invariants.mjs) would be read as this program's (review finding P2).
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(lowered.files)) {
    // PT10: a workflow's descriptor sits in its own directory under .poly/build/workflows/, written afresh.
    if (f.startsWith('../workflows/')) { rmSync(dirname(join(dir, f)), { recursive: true, force: true }); mkdirSync(dirname(join(dir, f)), { recursive: true }); }
    writeFileSync(join(dir, f), text);
  }
  mc.buildDir = dir;
  mc.artefactDigests = Object.fromEntries(Object.entries(lowered.files).map(([f, text]) => [f, 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex')]));
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
    notRun(mc, ['translation-validation', 'model-check', 'deadlock', ...laterStages(checked, machine)], 'strict validate() refused the lowered module (PL2001)');
    return;
  }
  mc.stages.push({ stage: 'validate', status: 'ran', engine: `sam-pattern@${engines['sam-pattern']}`, verdict: 'CLEAN', ms: performance.now() - t0 });

  // ── stage 1b: translation validation (PS9.3) ──────────────────────────
  t0 = performance.now();
  const tv = await translationValidate(module, machine, dir, opts.isolation ? { isolation: opts.isolation } : {});
  const ref: MachineReport = tv.report;
  mc.instance = instanceRecord(ref, engines, refOnlyProperties(module, machine));
  if (tv.mismatches.length) {
    mc.diagnostics.push(...tv.mismatches.slice(0, 20));
    mc.stages.push({ stage: 'translation-validation', status: 'ran', engine: 'poly-ref', verdict: 'REFUSED', ms: performance.now() - t0, note: `${tv.mismatches.length} mismatches over ${tv.transitions} transitions` });
    notRun(mc, ['model-check', 'deadlock', ...laterStages(checked, machine)], 'translation validation refused the lowering (PL2501)');
    return;
  }
  mc.stages.push({ stage: 'translation-validation', status: 'ran', engine: 'poly-ref', verdict: 'CLEAN', ms: performance.now() - t0, note: `${tv.transitions} transitions and ${tv.propertyChecks} property evaluations agree` });

  mc.vacuous = vacuousRecords(ref.vacuous);

  // ── stage 2: polygraph model check ────────────────────────────────────
  t0 = performance.now();
  const outside = new Set(ref.graph.edges.filter((e) => e.outcome.kind !== 'state').map((e) => keyOf({ ctor: '', payload: e.outcome.state })));
  // S5: polygraph cannot stop at a state outside the instance. Its cap is poly-ref's count, plus the
  // out-of-instance states, plus one; the cap hit that follows is expected and already reported (PL3901, PL3102).
  const maxStates = outside.size ? ref.states + outside.size + 1 : Math.max(ref.states + 1, 2);
  const inv = await importArtefact(join(dir, 'invariants.mjs'));
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

  // ── stage 2c: liveness (PS6) ──────────────────────────────────────────
  if (ref.model.liveness.length) {
    t0 = performance.now();
    const live = ref.findings.filter((f) => f.code === 'PL3301');
    mc.diagnostics.push(...live);
    mc.stages.push({ stage: 'liveness', status: 'ran', engine: 'poly-ref', verdict: verdictOf(live), ms: performance.now() - t0, note: `${ref.model.liveness.length} propert${ref.model.liveness.length === 1 ? 'y' : 'ies'} under weak fairness (PS6.4)` });
  }

  // ── stage 3: effects (PS5.4, S33) ─────────────────────────────────────
  if (lowered.files['effects.cjs']) await effectsStage(module, machine, mc, dir, contract, ref, engines);
  // PT10, S165: each workflow that runs this machine, admitted by polyflow's own gate at its own bounds.
  for (const w of module.decls.filter((d): d is A.Workflow => d.kind === 'Workflow' && d.machine === machine)) await workflowStage(module.name, w, mc, dir);

  // ── stage 3b: decisions (PD1.4d, S75) ─────────────────────────────────
  if (ref.model.decisions.size) {
    t0 = performance.now();
    const ungated = ref.findings.filter((f) => f.code === 'PL6201' || f.code === 'PL6203');
    mc.diagnostics.push(...ungated);
    mc.stages.push({ stage: 'decisions', status: 'ran', engine: 'poly-ref', verdict: verdictOf(ungated), ms: performance.now() - t0, note: `${ref.model.decisions.size} decision${ref.model.decisions.size === 1 ? '' : 's'}, each answer at each interval of its confidence and margin (PD1.4b); the completion step alone (S75)` });
  }

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
  // Review B3: K11 stays when the machine's actions take claims (PD5.5).
  mc.instance!.kernelAssumptions = ['K1', 'K2', 'K3', 'K7', 'K9', ...(mc.instance!.kernelAssumptions.includes('K11') ? ['K11'] : [])];
  mc.instance!.jointStates = joint.states;
  mc.vacuous.push(...vacuousRecords(joint.vacuous));
  const out: Diagnostic[] = [];
  const facts = checked.machines.get(machine)!;
  const hasCompose = facts.machine.items.some((i) => i.kind === 'Property' && i.form === 'compose');
  // S60: check-product runs the parent's mapper, and polyrun has no createInstance intent. A send it validates and
  // lets leave the joint machine (M3-2, polygraph 8.3.2).
  const missing = missingIntents(facts.machine);
  if (!hasCompose || missing.length) {
    out.push(...joint.findings);
    mc.diagnostics.push(...out);
    mc.instance!.compositionByRefOnly = true;
    mc.stages.push({ stage: 'composition', status: 'ran', engine: 'poly-ref', verdict: verdictOf(out), ms: performance.now() - t0, note: `${joint.states} joint states; ${missing.length ? missingText(missing) : 'no compose invariant'}, so polyrun check-product did not run` });
    return;
  }
  // Each child machine is lowered where the engines read it (S28: <module>.<Machine>).
  const root = join(resolve(opts.root ?? process.cwd()), '.poly', 'build');
  const ids = [...new Set([...facts.children.values()].map((c) => c.machine))];
  const refusedChild = ids.find((id) => !lowerMachine(module, checked, id.split('.').pop()!).lowered);
  if (refusedChild) {
    // The child's own stages report its refusal; the joint check cannot run without its artefacts (review finding P5).
    mc.diagnostics.push(...joint.findings);
    mc.stages.push({ stage: 'composition', status: 'not-run', engine: '', reason: `the child machine ${refusedChild} was refused at lowering, so polyrun check-product cannot run; poly-ref's joint findings are listed` });
    return;
  }
  const children = ids.map((id) => {
    const name = id.split('.').pop()!;
    // Review D-F1: a child is lowered as its own stages lowered it, sandbox policy included.
    const { lowered } = lowerMachine(module, checked, name, opts.isolation ? { isolation: opts.isolation } : {});
    const cdir = join(root, id);
    rmSync(cdir, { recursive: true, force: true });
    mkdirSync(cdir, { recursive: true });
    for (const [f, text] of Object.entries(lowered!.files)) { mkdirSync(dirname(join(cdir, f)), { recursive: true }); writeFileSync(join(cdir, f), text); }
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
  const missing = missingIntents(module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === machine));
  if (hasPath && missing.length) {
    // S60: check-effects would read the mapper's createInstance intents as an undeclared kind.
    mc.diagnostics.push(...fromRef);
    mc.stages.push({ stage: 'effects', status: 'ran', engine: 'poly-ref', verdict: verdictOf(fromRef), ms: performance.now() - t0, note: `${missingText(missing)}, so polyrun check-effects did not run; path properties and PL4002 decided by poly-ref alone` });
    mc.instance!.effectsByRefOnly = true;
    return;
  }
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

/**
 * Stage 4b (architecture §5, PT7a). poly-ref explores the configuration's global states with every input and
 * every arrival order within its bounds (PS13) and checks its invariants, sends to none and stuck states. No
 * engine checks configurations, so the stage is poly-ref's alone (PA0.1). Liveness is listed as not run (M1-2).
 * A bound hit is INCONCLUSIVE, never CLEAN (PS13.5).
 */
function configurationStage(module: Module, decl: A.Configuration, refused: boolean): ConfigCheck {
  const cc: ConfigCheck = { configuration: decl.name, stages: [], notRun: [], vacuous: [], diagnostics: [], verdict: 'CLEAN' };
  if (refused) {
    cc.stages.push({ stage: 'configuration', status: 'not-run', engine: '', reason: 'the program was refused at stage 0' });
    return cc;
  }
  const t0 = performance.now();
  const r = checkConfiguration(module, decl.name);
  cc.diagnostics.push(...r.findings);
  cc.vacuous = vacuousRecords(r.vacuous);
  const groups = new Map<string, { machine: string; n: number }>();
  for (const i of r.instances) {
    const key = i.group ?? i.name;
    groups.set(key, { machine: i.machine.name, n: (groups.get(key)?.n ?? 0) + 1 });
  }
  cc.instance = {
    instances: [...groups].map(([k, g]) => (r.instances.some((i) => i.group === k) ? `${k}[0..${g.n - 1}]: ${g.machine}` : `${k}: ${g.machine}`)),
    states: r.states,
    transitions: r.transitions,
    bounds: [`transit ≤ ${decl.bounds?.transit}`, ...(decl.bounds?.instances != null ? [`instances ≤ ${decl.bounds.instances}`] : [])],
    // PS13.7 rests on one step per message at its receiver (K4, K8), atomic single-writer steps (K1, K2) and the profile (K7).
    kernelAssumptions: ['K1', 'K2', 'K4', 'K7', 'K8'],
  };
  const missing = [...new Set(r.instances.flatMap((i) => missingIntents(module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === i.machine.name))))].sort().reverse();
  cc.stages.push({
    stage: 'configuration', status: 'ran', engine: 'poly-ref', verdict: verdictOf(r.findings), ms: performance.now() - t0,
    note: `${r.states} global states, ${r.transitions} global steps${r.liveness.length ? `; liveness under delivery fairness per message value (PS13.2b, PS14.2)` : ''}`,
    notes: missing.length ? [`${missingText(missing)}: the configuration is checked from the semantics, and its machines do not run under polyrun until it has`] : undefined,
  });
  return cc;
}

/** Stage 4b for every configuration of a module; the first explorer throw stops the stage and is reported. */
export function configurationReports(module: Module, refused: boolean): { configurations: ConfigCheck[]; error?: string } {
  const configurations: ConfigCheck[] = [];
  for (const d of module.decls) {
    if (d.kind !== 'Configuration') continue;
    try {
      configurations.push(configurationStage(module, d, refused));
    } catch (e) {
      return { configurations, error: `configuration ${d.name}: ${(e as Error).message}` };
    }
  }
  return { configurations };
}

/** The kernel intents for other instances a machine's handlers use: sendTo (S58) and createInstance (S60). */
function kernelIntents(decl: A.Machine | undefined): string[] {
  const found = new Set<string>();
  const walk = (body: A.Stmt[]): void => {
    for (const s of body) {
      if (s.kind === 'Intent' && s.op === 'send') found.add('sendTo');
      if (s.kind === 'Intent' && s.op === 'spawn' && s.modifier === 'detached') found.add('createInstance');
      if (s.kind === 'If') { walk(s.then); walk(s.else ?? []); }
      if (s.kind === 'Match') for (const a of s.arms) walk(a.body);
      if (s.kind === 'For') walk(s.body);
    }
  };
  for (const i of decl?.items ?? []) if (i.kind === 'Handler') walk(i.body);
  return [...found].sort().reverse();
}
/** Those polyrun does not have: createInstance (S60). sendTo is a kernel intent since polygraph 8.3.2 (M3-2, S89). */
const missingIntents = (decl: A.Machine | undefined): string[] => kernelIntents(decl).filter((n) => n !== 'sendTo');
const missingText = (names: string[]) => `polyrun has no ${names.join(' or ')} intent yet (S60)`;

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
    if (f.code === 'PL3201' || f.code === 'PL3301' || f.code === 'PL4001' || f.code === 'PL4002' || f.code === 'PL6201' || f.code === 'PL6203') continue; // stages 2b and 2c report deadlocks and liveness, stage 3 path properties
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
    // PD5.1.3c: the principal representatives the verdict holds for, when the machine has any.
    domains: [...ref.instance.fields.map((f) => `${f.name} ∈ ${f.domain}`), ...ref.instance.params.map((p) => `${p.name} ∈ ${p.domain}`), ...(ref.instance.principals ? [`${ref.instance.principals} principal representatives (PD5.1.3c)`] : [])],
    states: ref.states,
    transitions: ref.transitions,
    bounds,
    // M0 checks one machine's relation: K7 (profile fidelity) is the kernel assumption its guarantee uses (PS10); K11
    // when the machine's actions take claims, which only the verifier vouches for (PD5.5, S110).
    kernelAssumptions: ref.model.actions.some((a) => a.claims) ? ['K7', 'K11'] : ['K7'],
    engines,
    refOnly,
  };
}

function finish(report: CheckReport, module?: Module): CheckReport {
  // S69, S86: a witness id is the digest of { moduleDigest, subject, property, trace }, the subject being the
  // machine or configuration it is about, so the same trace in another version of the module, or in another
  // machine with the same defect, is another witness.
  if (module) {
    report.moduleDigest = digest(module);
    const scoped = [
      ...report.diagnostics.map((d) => ({ d, subject: d.at.machine ?? null })),
      ...report.machines.flatMap((m) => m.diagnostics.map((d) => ({ d, subject: m.machine }))),
      ...report.configurations.flatMap((c) => c.diagnostics.map((d) => ({ d, subject: c.configuration }))),
      ...report.policies.flatMap((p) => p.diagnostics.map((d) => ({ d, subject: `policy:${p.scope}` }))),
    ];
    for (const { d, subject } of scoped) {
      // Ruling after the M2 review: a witness no exported test can judge yet is marked, and its export refused.
      if (d.witness && !exportable(d.code, report.configurations.some((c) => c.configuration === subject && c.diagnostics.includes(d)))) d.testExport = 'no test export until M4';
      if (d.witness) d.witness.id = 'sha256:' + sha256Hex(canonicalize({ moduleDigest: report.moduleDigest, subject, property: d.property ?? d.code, trace: d.witness.trace }));
    }
    // S70: fixes are computed on the module this report checked; their ids carry its digest (S69). Since M3-3 an
    // embedded module is offered the same fixes, which applyFix splices into its text.
    attachFixes([
      ...report.diagnostics.map((d) => ({ d, machine: d.at.machine ?? null })),
      ...report.machines.flatMap((m) => m.diagnostics.map((d) => ({ d, machine: m.machine }))),
      ...report.configurations.flatMap((c) => c.diagnostics.map((d) => ({ d, machine: null }))),
    ], module, report.moduleDigest);
  }
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
  for (const c of report.configurations) {
    const decl = module?.decls.find((d): d is A.Configuration => d.kind === 'Configuration' && d.name === c.configuration);
    for (const d of c.diagnostics) {
      if (d.at.line !== undefined) continue;
      const span = (d.at.node && spans.get(d.at.node)) || decl?.span;
      if (span) d.at = { ...d.at, line: span.line, col: span.col };
    }
  }
  // A property not run keeps the verdict from CLEAN: INCONCLUSIVE at best, FINDINGS if a safety check failed (M1-2).
  for (const m of [...report.machines, ...report.configurations]) m.verdict = fold([verdictOf(m.diagnostics), ...m.stages.filter((s) => s.verdict).map((s) => s.verdict!), ...(m.notRun.length || m.vacuous.length ? ['INCONCLUSIVE' as Verdict] : [])]);
  // PT8: a policy scope folds like a machine: its diagnostics, its stages, and anything not run or vacuous.
  for (const p of report.policies) {
    if (p.verdict === 'INCONCLUSIVE' && p.stages.every((s) => s.status === 'not-run')) continue;
    p.verdict = fold([verdictOf(p.diagnostics), ...p.stages.filter((s) => s.verdict).map((s) => s.verdict!), ...(p.notRun.length || p.vacuous.length || p.stages.some((s) => s.status === 'not-run') ? ['INCONCLUSIVE' as Verdict] : [])]);
  }
  const v = fold([verdictOf(report.diagnostics), ...report.machines.map((m) => m.verdict), ...report.configurations.map((c) => c.verdict), ...report.policies.map((p) => p.verdict)]);
  report.verdict = v;
  report.exit = EXIT_CODES[v];
  return report;
}


// ── project mode (PT1.2, decision M1-6) ────────────────────────────────────

export interface ProjectReport {
  project: string;
  name: string;
  files: CheckReport[];
  /**
   * S72: the handler lint (PT6.5), or not run, and why. S142: it runs over the files poly.json names and every file
   * they reach through relative imports, read once; admission certifies these digests.
   */
  handlers: {
    status: 'ran'; files: number; diagnostics: Diagnostic[];
    roots: string[]; digests: Record<string, string>; packages: string[]; packageFiles: Record<string, string>; packageUnresolved: string[]; lockfile: { path: string; digest: string } | null;
  } | { status: 'not-run'; reason: string } | null;
  verdict: CheckReport['verdict'];
  exit: number;
}

/**
 * `poly check <dir>`: every module the manifest names, each through the whole
 * pipeline. The build goes under the project directory unless --root says
 * otherwise (PT1.5). The project verdict is the fold of the files' verdicts;
 * an error or a nondeterminism in any file decides it.
 */
/**
 * S41: polyrun keys handlers by kind across the whole deployment, so effects of one kind must agree across
 * the project's modules. A disagreement is reported in the later file and refuses it.
 */
export function projectKindConflicts(reports: CheckReport[]): void {
  const first = new Map<string, { report: CheckReport; k: NonNullable<CheckReport['effectKinds']>[number] }>();
  for (const report of reports) {
    for (const k of report.effectKinds ?? []) {
      const seen = first.get(k.kind);
      if (!seen) { first.set(k.kind, { report, k }); continue; }
      if (seen.report === report || seen.k.signature === k.signature) continue;
      report.diagnostics.push(diag('PL1002', { module: report.module ?? undefined, line: k.line, col: k.col }, `effect ${k.effect} has kind "${k.kind}", which ${seen.report.module}.${seen.k.effect} declares with a different payload, completions or class (S41)`));
      refold(report);
    }
  }
}

/** Folds a report again after a project-level diagnostic; an ERROR or a NONDETERMINISM stands (review finding P4). */
function refold(report: CheckReport): void {
  if (report.verdict === 'ERROR' || report.verdict === 'NONDETERMINISM') return;
  finish(report);
}

export async function checkProject(dir: string, opts: CheckOptions = {}): Promise<ProjectReport> {
  const { manifest, files, handlers: handlerFiles } = loadProject(dir);
  const reports: CheckReport[] = [];
  // PT8: policies govern the whole project, so every module is read first and given to each file's policy stage.
  const program: Module[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const m = (f.endsWith('.ts') ? readEmbedded(text, f) : parse(text)).module;
    if (m) program.push(m);
  }
  for (const f of files) reports.push(await checkFile(f, { root: opts.root ?? dir, program, ...(manifest.isolation ? { isolation: manifest.isolation } : {}) }));
  // PT8.2: a scope's policies lower to one document, so they live in one module.
  const scopes = new Map<string, CheckReport>();
  for (const report of reports) {
    for (const p of report.policies) {
      const prev = scopes.get(p.scope);
      if (prev && prev !== report) { report.diagnostics.push(diag('PL1002', { module: report.module ?? undefined, line: 1, col: 1 }, `scope "${p.scope}" also has policies in ${prev.file}; a scope's policies lower to one document, so they are declared in one module (PT8.2)`)); refold(report); }
      else scopes.set(p.scope, report);
    }
  }
  projectKindConflicts(reports);
  // PT1.3, PT1.5: a module is named once in a project; two modules of one name would share their build
  // directory and their machine ids (review finding P3).
  const named = new Map<string, CheckReport>();
  for (const report of reports) {
    if (!report.module) continue;
    const prev = named.get(report.module);
    if (!prev) { named.set(report.module, report); continue; }
    report.diagnostics.push(diag('PL1002', { module: report.module, line: 1, col: 1 }, `module ${report.module} is also declared in ${prev.file}; a project names each module once (PT1.3)`));
    refold(report);
  }
  // S72, PT6.5: the handler lint. A violation is not admitted (REFUSED); a project with effects and no handlers
  // field lists the lint as not run, never as clean.
  const hasEffects = reports.some((r) => (r.effectKinds ?? []).length > 0);
  let handlers: ProjectReport['handlers'] = null;
  if (handlerFiles) {
    const c = handlerClosure(dir, handlerFiles);
    handlers = { status: 'ran', files: c.bytes.size, diagnostics: c.diagnostics, roots: c.roots, digests: c.digests, packages: c.packages, packageFiles: c.packageFiles, packageUnresolved: c.packageUnresolved, lockfile: c.lockfile };
  }
  else if (hasEffects) handlers = { status: 'not-run', reason: 'the project has effects, and poly.json names no handlers (S72)' };
  const lintVerdict: Verdict[] = handlers?.status === 'ran' ? [verdictOf(handlers.diagnostics)] : [];
  const special = reports.find((r) => r.verdict === 'ERROR') ?? reports.find((r) => r.verdict === 'NONDETERMINISM');
  const verdict = special ? special.verdict : fold([...reports.map((r) => r.verdict as Verdict), ...lintVerdict]);
  return { project: dir, name: manifest.name, files: reports, handlers, verdict, exit: special ? special.exit : EXIT_CODES[verdict as Verdict] };
}
