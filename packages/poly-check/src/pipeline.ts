// The M0 check pipeline (02 §5, PT12, PT14): `poly check <file>`.
//
//   0  parse, type, domains          @poly/lang, @poly/core
//      lower, write .poly/build      @poly/lower
//   1  strict validate()             @cognitive-fab/sam-pattern
//   1b translation validation        @poly/ref (PS9.3)
//   2  model check                   polygraph (invariants, step and reject properties)
//   2b deadlock                      @poly/ref (PS5.6)
//
// A stage that cannot run because an earlier one refused is listed as not
// run, with the reason; it never lowers the verdict (02 §5). No stage calls a
// language model.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parse } from '@poly/lang';
import { checkModule, fold, verdictOf, diag, EXIT_CODES, type Diagnostic, type Module, type Verdict } from '@poly/core';
import { lowerMachine } from '@poly/lower';
import { translationValidate, confirmWitness, stateDigestOf, keyOf, type MachineReport } from '@poly/ref';
import { check as polygraphCheck, type PolygraphViolation } from '@cognitive-fab/polygraph/scripts/check.mjs';

export type StageName = 'parse-type' | 'lower' | 'validate' | 'translation-validation' | 'model-check' | 'deadlock';

export interface StageRecord {
  stage: StageName;
  status: 'ran' | 'not-run';
  engine: string;
  verdict?: Verdict;
  reason?: string;
  ms?: number;
  note?: string;
}

export interface MachineCheck {
  machine: string;
  stages: StageRecord[];
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
  const refused = report.diagnostics.some((d) => d.severity === 'error');
  const engines = report.engines;

  for (const machine of checked.machines.keys()) {
    const mc: MachineCheck = { machine, stages: [], diagnostics: [], verdict: 'CLEAN' };
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
  const req = createRequire(join(dir, 'next.cjs'));
  let mod: { instance: (o: object) => { validate: () => string[] } };
  try {
    const path = req.resolve(join(dir, 'next.cjs'));
    delete req.cache[path];
    mod = req(path);
  } catch (e) {
    const msg = (e as Error).message;
    if (/@cognitive-fab\/sam-pattern/.test(msg)) throw new Error(`cannot load the lowered module: @cognitive-fab/sam-pattern is not resolvable from ${dir}; install it in the project`);
    throw new Error(`the lowered module does not load: ${msg}`);
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
  mc.instance = instanceRecord(ref, engines);
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
  const merged = mergeFindings(stage2, ref.findings);
  mc.diagnostics.push(...merged);
  mc.stages.push({ stage: 'model-check', status: 'ran', engine: `polygraph@${engines.polygraph}`, verdict: verdictOf(merged), ms: performance.now() - t0, note: `${pg.statesExplored} states explored${pg.capHit ? `, cap ${maxStates} hit` : ''}` });

  // ── stage 2b: deadlock (PS5.6) ────────────────────────────────────────
  t0 = performance.now();
  const dead = ref.findings.filter((f) => f.code === 'PL3201');
  mc.diagnostics.push(...dead);
  mc.stages.push({ stage: 'deadlock', status: 'ran', engine: 'poly-ref', verdict: verdictOf(dead), ms: performance.now() - t0, note: ref.model.service ? 'service: exempt (PS1.7)' : `${ref.states} states` });
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
export function mergeFindings(fromPolygraph: Diagnostic[], fromRef: Diagnostic[]): Diagnostic[] {
  const out = [...fromPolygraph];
  const have = new Set(out.map(mergeKey));
  for (const f of fromRef) {
    if (f.code === 'PL3201') continue; // stage 2b reports deadlocks
    if (have.has(mergeKey(f))) continue;
    // Finding 6: an escape or bound is kept per field, and poly-ref's exploration cap (no field) on its own.
    const capped = f.code === 'PL3001' || f.code === 'PL3002' || f.code === 'PL3003';
    out.push(capped ? { ...f, message: `${f.message} (poly-ref; polygraph's exploration was capped at the bound)` } : f);
    have.add(mergeKey(f));
  }
  return out;
}

function instanceRecord(ref: MachineReport, engines: Record<string, string>): InstanceRecord {
  const bounds = [...new Set(ref.findings.filter((f) => f.code === 'PL3901').map((f) => f.field ?? 'exploration cap'))];
  return {
    domains: [...ref.instance.fields.map((f) => `${f.name} ∈ ${f.domain}`), ...ref.instance.params.map((p) => `${p.name} ∈ ${p.domain}`)],
    states: ref.states,
    transitions: ref.transitions,
    bounds,
    // M0 checks one machine's relation: K7 (profile fidelity) is the kernel assumption its guarantee uses (PS10).
    kernelAssumptions: ['K7'],
    engines,
  };
}

function finish(report: CheckReport, module?: Module): CheckReport {
  // Engine diagnostics carry no source position; they point at the machine's declaration (display only, PT12.1).
  for (const m of report.machines) {
    const decl = module?.decls.find((d) => d.kind === 'Machine' && d.name === m.machine);
    for (const d of m.diagnostics) if (d.at.line === undefined && decl?.span) { d.at.line = decl.span.line; d.at.col = decl.span.col; }
  }
  for (const m of report.machines) m.verdict = fold([verdictOf(m.diagnostics), ...m.stages.filter((s) => s.verdict).map((s) => s.verdict!)]);
  const v = fold([verdictOf(report.diagnostics), ...report.machines.map((m) => m.verdict)]);
  report.verdict = v;
  report.exit = EXIT_CODES[v];
  return report;
}

