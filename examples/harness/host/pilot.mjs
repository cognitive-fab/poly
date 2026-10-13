// plan-e3.md E3.9, docs/e3/e3-9-plan.md section 3 "The pilot": the first two trials of the plan (task 1, the base harness and the full one),
// run with the live driver, and then a stop. The report holds what was measured (turns, tokens by class, cost per trial) and the plan
// recomputed from it, and nothing is run after it until the owner has read it.
//
//   node pilot.mjs [--task <id>]      needs ANTHROPIC_API_KEY in the environment (it is read by the client at each call and nowhere else),
//                                     Docker Desktop started, and the image built (container/ctl.mjs build)
//
// What it does, in order, and refuses at the first thing that does not hold:
//   1. the price tables of the run pass the price gate, and are the tables the module is admitted with (a copy of the harness is admitted
//      with prices-live in the place of prices, so the module's charge is the live one; the committed placeholder tables stay for the recordings);
//   2. the container is started fresh, and the isolation check passes inside it;
//   3. the harness is admitted once; for each configuration a fresh runtime, a fresh copy of the task inside the container, and a trial
//      under the trial's cap (host-enforced, assumption trial-cap) and the wall clock;
//   4. the container is removed; the report is written to docs/e3/pilot-<date>.json and printed. The key is in no file and no line of it.
//
// runPilot is the part that holds no Docker or key of its own, so that a test can run it against a local fake API (e3-pilot.test.mjs).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { admittedHarness, loaded } from '../../../test/e3/e3-runtime-helpers.mjs';
import { createAnthropic } from './anthropic.mjs';
import { ASSUMED, plan, reservation } from './cost-plan.mjs';
import { containerExec } from './container-exec.mjs';
import { runLive } from './live.mjs';
import { ALL_OFF, ALL_ON } from './loop.mjs';
import { checkPrices } from './price-gate.mjs';
import { scoreRun } from './score.mjs';
import { makeHost } from './transports.mjs';
import { taskOf } from './tasks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = resolve(HERE, '..');
const ROOT = resolve(EXAMPLE, '..', '..');
const sum = (xs) => xs.reduce((a, x) => a + x, 0);

/** The input and output limits the module declares for a decision, read from its text so that the host's reservations cannot drift from them. */
export function limitsOf(moduleText, decision) {
  const at = moduleText.indexOf(`decision ${decision}(`);
  if (at < 0) throw new Error(`no decision ${decision}`);
  const m = /max input tokens (\d+) max tokens (\d+)/.exec(moduleText.slice(at, at + 600));
  if (!m) throw new Error(`decision ${decision} declares no limits`);
  return { maxInput: Number(m[1]), maxOutput: Number(m[2]) };
}

/** What a trial's call log says about its size, for the recomputed plan. */
export function measure(lines) {
  const agent = lines.filter((l) => l.kind === 'agent' && l.status === 200);
  const totalIn = (l) => l.usage.input + l.usage.cache_write + l.usage.cache_read;
  const steps = agent.length;
  const output = steps ? sum(agent.map((l) => l.usage.output)) / steps : 0;
  const growth = steps > 1 ? (totalIn(agent[steps - 1]) - totalIn(agent[0])) / (steps - 1) : 0;
  const byKind = {};
  for (const l of lines) byKind[l.kind] = (byKind[l.kind] ?? 0) + (l.microUsd ?? 0);
  const classes = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
  for (const l of agent) for (const k of Object.keys(classes)) classes[k] += l.usage[k];
  return {
    agentCalls: steps, calls: lines.length, preambleTokens: steps ? totalIn(agent[0]) : 0, outputPerStep: Math.round(output),
    toolPerStep: Math.max(0, Math.round(growth - output)), tokensByClass: classes, microUsd: sum(lines.map((l) => l.microUsd ?? 0)), byKind,
    perCall: lines.map((l) => ({ n: l.n, kind: l.kind, stop: l.stopReason, usage: l.usage, microUsd: l.microUsd, latencyMs: l.latencyMs })),
  };
}

/**
 * @param {{ taskId: string, models: { main: string, cheap: string }, tables: Record<string, object>, world: (o: { task: object, run: string }) => { exec: Function, prepare: () => Promise<string> },
 *   baseUrl?: string, getKey?: () => string | undefined, outDir: string, pricesDir?: string, capMicro?: number, wallClockMs?: number,
 *   configs?: [string, object][], sleep?: (ms: number) => Promise<void>, today?: Date, log?: (s: string) => void }} o
 */
export async function runPilot({ taskId, models, tables, world, baseUrl, getKey, outDir, pricesDir = join(EXAMPLE, 'prices-live'), capMicro = 600_000, wallClockMs = 20 * 60_000, configs = [['base', ALL_OFF], ['full', ALL_ON]], sleep, today = new Date(), log = () => {} }) {
  const gate = checkPrices(pricesDir, today);
  if (!gate.ok) throw new Error(`the price tables of the run do not pass the gate: ${JSON.stringify(gate.tables.filter((t) => t.refusals.length))}`);
  mkdirSync(outDir, { recursive: true });
  const task = taskOf(taskId);
  const moduleText = readFileSync(join(EXAMPLE, 'harness.poly'), 'utf8');
  const reservations = {
    agent: reservation(tables[models.main], ...Object.values(limitsOf(moduleText, 'agent'))),
    summarise: reservation(tables[models.cheap], ...Object.values(limitsOf(moduleText, 'summarise'))),
    read: reservation(tables[models.cheap], ...Object.values(limitsOf(moduleText, 'read'))),
  };
  log(`admitting the harness with the tables of ${pricesDir}`);
  const a = await admittedHarness(`pilot-${process.pid}`, { pricesDir });
  const trials = [];
  for (const [name, mechanisms] of configs) {
    log(`trial ${name}: ${taskId}`);
    const w = world({ task, run: `pilot-${name}` });
    await w.prepare();
    const host = makeHost({ exec: w.exec });
    const { rt } = await loaded(a, { transports: host.transports });
    const logPath = join(outDir, `${taskId}-${name}.calls.jsonl`);
    writeFileSync(logPath, '');
    const anthropic = createAnthropic({ tables, logPath, ...(baseUrl ? { baseUrl } : {}), ...(getKey ? { getKey } : {}), ...(sleep ? { sleep } : {}) });
    try {
      const result = await runLive({ rt, host, task, models, anthropic, editableDir: join(EXAMPLE, 'editable'), mechanisms, trialCapMicro: capMicro, reservations, wallClockMs });
      const score = scoreRun(await rt.getJournal(result.ids.trial));
      // poly's own charge for the same calls: the decision events of every instance the trial used
      let poly = 0;
      for (const id of [...result.turns.map((t) => `turn:${result.runId}:${t.stage}:${t.turn - 1}`), ...result.receipts, result.ids.context]) {
        for (const e of (await rt.chain(id)).filter((x) => x.kind === 'decision')) poly += e.body.cost?.units ?? 0;
      }
      const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      trials.push({
        config: name, mechanisms, trial: { mode: result.trial.mode, why: result.trial.why }, stages: score.stages, failingStage: score.failingStage,
        turns: result.turns, metrics: result.metrics, compactions: result.compactions.length, wallClockMs: result.wallClockMs,
        measured: measure(lines), driverMicroUsd: result.llm.spentThisTrial, polyMicroUsd: poly,
      });
    } finally {
      await rt.close();
    }
  }
  // the plan recomputed from what was measured: the sizes of a step, and the steps of each trial
  const agentTrials = trials.filter((t) => t.measured.agentCalls > 0);
  const mean = (f) => (agentTrials.length ? Math.round(sum(agentTrials.map(f)) / agentTrials.length) : 0);
  const assume = { preamble: mean((t) => t.measured.preambleTokens), output: mean((t) => t.measured.outputPerStep), tool: mean((t) => t.measured.toolPerStep), steps: agentTrials.map((t) => t.measured.agentCalls) };
  const limits = limitsOf(moduleText, 'agent');
  const recomputed = assume.steps.length
    ? { assumptions: assume, assumedBefore: ASSUMED, staged: plan({ name: 'staged', tasks: 12, trials: 40, capUsd: capMicro / 1e6, maxInput: limits.maxInput, maxOutput: limits.maxOutput, assume, tables: { main: tables[models.main], cheap: tables[models.cheap] } }) }
    : null;
  return { task: taskId, models, capMicro, reservations, trials, recomputed };
}

// ---------------------------------------------------------------- the command line

async function main() {
  const { send, up, down, isolation, tag } = await import('../container/ctl.mjs');
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : d; };
  const taskId = arg('--task', 'todo-urgency');
  if (typeof process.env.ANTHROPIC_API_KEY !== 'string' || process.env.ANTHROPIC_API_KEY === '') throw new Error('ANTHROPIC_API_KEY is not set in the environment; the pilot does not start');
  const dir = join(EXAMPLE, 'prices-live');
  const tables = {};
  for (const f of ['main.json', 'cheap.json']) {
    const t = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    tables[t.model] = t;
  }
  const models = { main: JSON.parse(readFileSync(join(dir, 'main.json'), 'utf8')).model, cheap: JSON.parse(readFileSync(join(dir, 'cheap.json'), 'utf8')).model };
  console.log(`image ${tag()}`);
  up();
  try {
    if (!isolation()) throw new Error('the isolation check failed inside the container; the pilot does not start');
    const outDir = join(ROOT, '.poly', 'e3-live', `pilot-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const report = await runPilot({ taskId, models, tables, outDir, log: (s) => console.log(s), world: ({ task, run }) => { const c = containerExec({ send, task, run }); return { prepare: () => c.prepare(), exec: c.exec }; } });
    const file = join(ROOT, 'docs', 'e3', `pilot-${new Date().toISOString().slice(0, 10)}.json`);
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report: ${file}`);
    for (const t of report.trials) console.log(`${t.config}: ${t.trial.mode}/${t.trial.why}, stages ${t.stages.map((s) => `${s.state}(${s.turns}, ${s.endedBy})`).join(' ')}, ${t.measured.agentCalls} agent calls, ${(t.driverMicroUsd / 1e6).toFixed(4)} USD (poly ${(t.polyMicroUsd / 1e6).toFixed(4)})`);
  } finally {
    down();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (e) => { console.error(String(e.message).replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[key]')); process.exit(1); });
}
