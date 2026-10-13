// plan-e3.md E3.9, docs/e3/e3-9-plan.md section 3: the launcher of the staged plan. 40 trials: pass 1 runs each of the 12 tasks once under the
// base harness and once under the full one (24 trials); pass 2 reruns eight tasks the same way (16 trials), chosen before the run by a rule that
// does not look at results: the four tasks of each repository with the most stages. Each trial is capped at 0.60 USD by the host (assumption
// trial-cap), and the month's cap of 25 USD is poly's own: the harness is loaded once per trial over one store, so the month's budget instance
// accumulates across the plan; the launcher also keeps its own tally and does not start a trial that could take the plan past 25 USD.
//
//   node staged.mjs [--out <dir>] [--resume <dir>]     needs ANTHROPIC_API_KEY in the environment, Docker Desktop started, the image built
//
// It stops at the first of: the end of the plan; the month's cap (no trial is started that could take the tally past it); a failure of the
// isolation check (made before every trial, inside the container); any error. It then writes ONE report, report.json, and calls nothing
// after it: no model, no tool. Each finished trial is also written to its own file as it ends (a crash loses at most the trial in flight), and
// --resume continues from a folder of such files, counting what they cost; the isolation check, the price gate and the cap apply again.
//
// What the report holds: the schedule and why it stopped; every trial (result, stages with turns and what ended them, the commands of every
// bash call, what the classifier and the Reducer's condition said, tokens by class and cost per call and per trial, poly's charge beside the
// driver's); the totals by configuration; the trigger rates of the four mechanisms; the noise floor over the tasks that were rerun; and the
// paired comparison of the two configurations with its verdict (which at 12 pairs is expected to be INCONCLUSIVE) and the figures under a cap.
// Labels: the task set of 12 from the owner's repositories, 31 stages, binary stage scores, "reached the end of the plan" is not "solved the task".
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { admittedHarness, loaded } from '../../../test/e3/e3-runtime-helpers.mjs';
import { createAnthropic } from './anthropic.mjs';
import { containerExec } from './container-exec.mjs';
import { runLive } from './live.mjs';
import { ALL_OFF, ALL_ON } from './loop.mjs';
import { decide } from './paired.mjs';
import { limitsOf, measure } from './pilot.mjs';
import { reservation } from './cost-plan.mjs';
import { checkPrices } from './price-gate.mjs';
import { scoreRun } from './score.mjs';
import { taskIds, taskOf } from './tasks.mjs';
import { makeHost } from './transports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = resolve(HERE, '..');
const ROOT = resolve(EXAMPLE, '..', '..');
const CONFIGS = { base: ALL_OFF, full: ALL_ON };
const sum = (xs) => xs.reduce((a, x) => a + x, 0);
export const MONTH_CAP_MICRO = 25_000_000;
export const TRIAL_CAP_MICRO = 600_000;

/**
 * The tasks rerun in pass 2, chosen before the run by a rule that does not look at results: in each repository, the four with the most stages
 * (ties by id). With the 12 tasks of the plan these are todo-dates, todo-fuzzy, todo-nlparse, todo-recurrence and snip-config, snip-dedup,
 * snip-group, snip-utils.
 */
export function rerunTasks(ids = taskIds(), perRepo = 4) {
  const by = {};
  for (const id of ids) {
    const t = taskOf(id);
    (by[t.repo] ??= []).push({ id, stages: t.stages.length });
  }
  return Object.values(by).flatMap((xs) => xs.sort((a, b) => b.stages - a.stages || a.id.localeCompare(b.id)).slice(0, perRepo).map((x) => x.id)).sort();
}

/**
 * The trials in the order they run. Within a pair, the order of the two configurations alternates by task, and pass 2 reverses pass 1 for the
 * same task, so that neither configuration always runs first and the pairs are adjacent (a stop leaves whole pairs).
 */
export function schedule(ids = taskIds(), reruns = rerunTasks(ids)) {
  const out = [];
  const pass = (list, flip) => list.forEach((id, i) => {
    const order = (i % 2 === 0) !== flip ? ['base', 'full'] : ['full', 'base'];
    for (const config of order) out.push({ n: out.length + 1, task: id, config, pass: flip ? 2 : 1, label: `${id}.${config}.p${flip ? 2 : 1}` });
  });
  pass([...ids].sort(), false);
  pass([...reruns].sort(), true);
  return out;
}

const fileOf = (dir, t) => join(dir, `trial-${String(t.n).padStart(2, '0')}-${t.label}.json`);

/** The trials already finished in a folder, by label. */
function finished(dir) {
  if (!existsSync(dir)) return new Map();
  return new Map(readdirSync(dir).filter((f) => /^trial-\d+-.+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))).map((t) => [t.label, t]));
}

/** The comparison of the two configurations from the finished trials: floor over the rerun tasks, the paired verdict, and the mechanisms' rates. */
export function summarise(trials) {
  const runsOf = (config) => {
    const m = {};
    for (const t of trials.filter((x) => x.config === config && x.score)) (m[t.task] ??= []).push({ ...t.score, ended: t.ended });
    return m;
  };
  const base = runsOf('base');
  const full = runsOf('full');
  const both = Object.keys(base).filter((id) => full[id]);
  const out = { tasksWithBoth: both.length };
  if (both.length) {
    const pick = (m) => Object.fromEntries(both.map((id) => [id, m[id]]));
    try {
      out.paired = decide({ base: pick(base), candidate: pick(full), source: 'live', partialReruns: true });
    } catch (e) {
      out.paired = { error: e.message };
    }
  }
  const rate = (config, f) => {
    const ts = trials.filter((t) => t.config === config && t.turns);
    const turns = ts.flatMap((t) => t.turns);
    return f(ts, turns);
  };
  out.mechanisms = Object.fromEntries(Object.keys(CONFIGS).map((c) => [c, rate(c, (ts, turns) => ({
    trials: ts.length, turns: turns.length,
    fusion: { opportunities: sum(ts.map((t) => t.metrics.fusion.opportunities)), fired: sum(ts.map((t) => t.metrics.fusion.fired)), fusedToolUsed: turns.filter((x) => x.fusedTool).length },
    compaction: { opportunities: sum(ts.map((t) => t.metrics.compaction.opportunities)), chosen: sum(ts.map((t) => t.metrics.compaction.chosen)), forced: sum(ts.map((t) => t.metrics.compaction.forced)) },
    pack: { opportunities: sum(ts.map((t) => t.metrics.pack.opportunities)), observations: sum(ts.map((t) => t.metrics.pack.observations)), handled: sum(ts.map((t) => t.metrics.pack.handled)) },
    reducer: { opportunities: sum(ts.map((t) => t.metrics.reducer.opportunities)), receipts: sum(ts.map((t) => t.metrics.reducer.receipts)), verified: sum(ts.map((t) => t.metrics.reducer.verified)), rejected: sum(ts.map((t) => t.metrics.reducer.rejected)), flagged: sum(ts.map((t) => t.metrics.reducer.flagged)) },
    commands: turns.flatMap((x) => x.commands),
  }))]));
  out.totals = Object.fromEntries(Object.keys(CONFIGS).map((c) => {
    const ts = trials.filter((t) => t.config === c);
    return [c, { trials: ts.length, completed: ts.filter((t) => t.score && t.score.stages.every((s) => s.score === 1)).length, microUsd: sum(ts.map((t) => t.driverMicroUsd ?? 0)), agentCalls: sum(ts.map((t) => t.measured?.agentCalls ?? 0)) }];
  }));
  return out;
}

/**
 * @param {{ models: { main: string, cheap: string }, tables: Record<string, object>, world: (o: { task: object, run: string }) => { exec: Function, prepare: () => Promise<string>, remove?: () => Promise<void> },
 *   isolation: () => boolean | Promise<boolean>, outDir: string, trials?: object[], pricesDir?: string, trialCapMicro?: number, monthCapMicro?: number,
 *   wallClockMs?: number, baseUrl?: string, getKey?: () => string | undefined, sleep?: (ms: number) => Promise<void>, today?: Date, log?: (s: string) => void }} o
 * @returns {Promise<object>} the report, also written to outDir/report.json
 */
export async function runStaged({ models, tables, world, isolation, outDir, trials = schedule(), pricesDir = join(EXAMPLE, 'prices-live'), trialCapMicro = TRIAL_CAP_MICRO, monthCapMicro = MONTH_CAP_MICRO, wallClockMs = 20 * 60_000, baseUrl, getKey, sleep, today = new Date(), log = () => {} }) {
  const gate = checkPrices(pricesDir, today);
  if (!gate.ok) throw new Error(`the price tables of the run do not pass the gate: ${JSON.stringify(gate.tables.filter((t) => t.refusals.length))}`);
  mkdirSync(outDir, { recursive: true });
  const moduleText = readFileSync(join(EXAMPLE, 'harness.poly'), 'utf8');
  const reservations = {
    agent: reservation(tables[models.main], ...Object.values(limitsOf(moduleText, 'agent'))),
    summarise: reservation(tables[models.cheap], ...Object.values(limitsOf(moduleText, 'summarise'))),
    read: reservation(tables[models.cheap], ...Object.values(limitsOf(moduleText, 'read'))),
  };
  const done = finished(outDir);
  let tally = sum([...done.values()].map((t) => t.driverMicroUsd ?? 0));
  const results = [...done.values()];
  let stop = null;
  let isolationChecks = 0;
  let a = null;
  const store = { sqlite: join(outDir, `poly-${process.pid}.sqlite`) };
  try {
    for (const t of trials) {
      if (done.has(t.label)) continue;
      if (tally + trialCapMicro > monthCapMicro) { stop = { reason: 'month-cap', detail: `${tally} spent and a trial may spend ${trialCapMicro}, over the month's ${monthCapMicro}` }; break; }
      isolationChecks += 1;
      if (!(await isolation())) { stop = { reason: 'isolation-check-failed', detail: `before trial ${t.n} (${t.label})` }; break; }
      a ??= await (async () => { log('admitting the harness with the live tables'); return admittedHarness(`staged-${process.pid}`, { pricesDir }); })();
      log(`trial ${t.n} of ${trials.length}: ${t.label}`);
      const task = taskOf(t.task);
      const w = world({ task, run: t.label });
      let rt = null;
      let record;
      try {
        await w.prepare();
        const host = makeHost({ exec: w.exec });
        ({ rt } = await loaded(a, { transports: host.transports, store }));
        const logPath = join(outDir, `calls-${String(t.n).padStart(2, '0')}-${t.label}.jsonl`);
        writeFileSync(logPath, '');
        const anthropic = createAnthropic({ tables, logPath, ...(baseUrl ? { baseUrl } : {}), ...(getKey ? { getKey } : {}), ...(sleep ? { sleep } : {}) });
        const result = await runLive({ rt, host, task, models, anthropic, editableDir: join(EXAMPLE, 'editable'), mechanisms: CONFIGS[t.config], trialCapMicro, reservations, wallClockMs, runId: t.label });
        const score = scoreRun(await rt.getJournal(result.ids.trial));
        let poly = 0;
        for (const id of [...result.turns.map((x) => `turn:${result.runId}:${x.stage}:${x.turn - 1}`), ...result.receipts, result.ids.context]) {
          for (const e of (await rt.chain(id)).filter((x) => x.kind === 'decision')) poly += e.body.cost?.units ?? 0;
        }
        const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        record = {
          ...t, trial: { mode: result.trial.mode, why: result.trial.why }, score: { total: score.total, stages: score.stages }, ended: score.ended, stages: score.stages,
          failingStage: score.failingStage, turns: result.turns, metrics: result.metrics, compactions: result.compactions.length, wallClockMs: result.wallClockMs,
          measured: measure(lines), driverMicroUsd: result.llm.spentThisTrial, polyMicroUsd: poly,
        };
        writeFileSync(fileOf(outDir, t), `${JSON.stringify(record, null, 2)}\n`);
        results.push(record);
        tally += record.driverMicroUsd;
      } finally {
        if (rt) await rt.close();
        try { await w.remove?.(); } catch { /* the container is removed at the end anyway */ }
      }
    }
    if (!stop) stop = { reason: 'plan-complete', detail: `${trials.length} trials` };
  } catch (e) {
    stop = { reason: 'error', detail: String(e.message).replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[key]').slice(0, 600) };
  }
  results.sort((x, y) => x.n - y.n);
  const report = {
    stoppedBecause: stop, models, trialCapMicro, monthCapMicro, reservations, schedule: trials.map(({ n, task, config, pass, label }) => ({ n, task, config, pass, label })),
    trialsFinished: results.length, trialsPlanned: trials.length, spentMicroUsd: tally, isolationChecksMade: isolationChecks, ...summarise(results), trials: results,
    labels: ['12 tasks from the owner\'s repositories, 31 stages, binary stage scores', '"reached the end of the plan" is not "solved the task"', 'completion under a cap partly measures cost: see paired.underCap', 'pass 2 reruns eight tasks, chosen before the run by stage count', 'one model (Opus 5.5 main, Haiku 4.5 cheap), live prices of 2026-10-12'],
  };
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

// ---------------------------------------------------------------- the command line

async function main() {
  const { send, up, down, isolation, tag } = await import('../container/ctl.mjs');
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : d; };
  if (typeof process.env.ANTHROPIC_API_KEY !== 'string' || process.env.ANTHROPIC_API_KEY === '') throw new Error('ANTHROPIC_API_KEY is not set in the environment; the plan does not start');
  const dir = join(EXAMPLE, 'prices-live');
  const tables = {};
  for (const f of ['main.json', 'cheap.json']) {
    const t = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    tables[t.model] = t;
  }
  const models = { main: JSON.parse(readFileSync(join(dir, 'main.json'), 'utf8')).model, cheap: JSON.parse(readFileSync(join(dir, 'cheap.json'), 'utf8')).model };
  const outDir = resolve(arg('--resume', arg('--out', join(ROOT, '.poly', 'e3-live', `staged-${new Date().toISOString().replace(/[:.]/g, '-')}`))));
  console.log(`image ${tag()}; output ${outDir}`);
  up();
  let report;
  try {
    if (!isolation()) throw new Error('the isolation check failed inside the container; the plan does not start');
    report = await runStaged({
      models, tables, outDir, log: (s) => console.log(s), isolation: () => isolation(true),
      world: ({ task, run }) => { const c = containerExec({ send, task, run }); return { prepare: () => c.prepare(), exec: c.exec, remove: () => c.remove() }; },
    });
  } finally {
    down();
  }
  console.log(`stopped: ${report.stoppedBecause.reason} (${report.stoppedBecause.detail})`);
  console.log(`${report.trialsFinished} of ${report.trialsPlanned} trials, ${(report.spentMicroUsd / 1e6).toFixed(4)} USD`);
  for (const [c, t] of Object.entries(report.totals)) console.log(`${c}: ${t.completed} of ${t.trials} reached the end of the plan, ${t.agentCalls} agent calls, ${(t.microUsd / 1e6).toFixed(4)} USD`);
  console.log(`report: ${join(outDir, 'report.json')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (e) => { console.error(String(e.message).replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[key]')); process.exit(1); });
}
