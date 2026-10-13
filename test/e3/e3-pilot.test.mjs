// plan-e3.md E3.9: the pilot (host/pilot.mjs) run against a local fake of the API, with the live price tables and the module admitted with them,
// on a Go task in a scratch copy on this host (the real pilot uses the container). Shown: the pilot refuses tables that do not pass the gate;
// it runs the base and the full configuration of one task, scores each from the journal, reports the turns, the tokens by class and the cost
// of each trial, with poly's own charge equal to the driver's under the live Opus table; it recomputes the plan from what it measured; and
// the key is in no file it writes. No key of value, no model, no spend. Heavy: it admits the module with the live tables. Run alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';
import { CANARY_KEY, answer, fakeApi, toolUse } from './e3-fake-api.mjs';
import { limitsOf, measure, runPilot } from '../../examples/harness/host/pilot.mjs';
import { stepsBeforeCap } from '../../examples/harness/host/cost-plan.mjs';
import { makeHost } from '../../examples/harness/host/transports.mjs';
import { prepare, taskOf } from '../../examples/harness/host/tasks.mjs';

const LIVE = join(ROOT, 'examples', 'harness', 'prices-live');
const tablesOf = () => {
  const main = JSON.parse(readFileSync(join(LIVE, 'main.json'), 'utf8'));
  const cheap = JSON.parse(readFileSync(join(LIVE, 'cheap.json'), 'utf8'));
  return { models: { main: main.model, cheap: cheap.model }, tables: { [main.model]: main, [cheap.model]: cheap } };
};
const TODAY = new Date('2026-10-14T12:00:00Z');
const OUT = join(ROOT, '.poly', 'tmp', `pilot-${process.pid}`);
const TASK = taskOf('snip-headtail');
const FILE = 'internal/filter/actions.go';
const edit = (k) => toolUse('edit', { path: FILE, old: TASK.stages[k].edits[0].broken, new: TASK.stages[k].edits[0].fixed });

/** A world on this host, in the shape the pilot asks for: a scratch copy and the exec transport that serves it. */
const world = ({ task, run }) => {
  const h = makeHost();
  return { prepare: async () => { const { copy } = prepare(task.id, `${run}-${process.pid}`); h.setWorld({ copy, task }); return copy; }, exec: h.transports.exec };
};

test('the module\'s limits are read from its text, so the host\'s reservations cannot drift from them', () => {
  const text = readFileSync(join(ROOT, 'examples', 'harness', 'harness.poly'), 'utf8');
  assert.deepEqual(limitsOf(text, 'agent'), { maxInput: 50000, maxOutput: 4000 });
  assert.deepEqual(limitsOf(text, 'summarise'), { maxInput: 100000, maxOutput: 4000 });
  assert.deepEqual(limitsOf(text, 'read'), { maxInput: 100000, maxOutput: 2000 });
  assert.throws(() => limitsOf(text, 'nothing'), /no decision/);
});

test('measure: the size of a step from a call log, by class, with the cost per kind', () => {
  const line = (n, kind, usage, microUsd) => ({ n, kind, status: 200, stopReason: 'tool_use', usage: { input: 0, output: 0, cache_write: 0, cache_read: 0, ...usage }, microUsd, latencyMs: 10 });
  const m = measure([
    line(1, 'agent', { input: 100, cache_write: 4900, output: 300 }, 1000),
    line(2, 'agent', { input: 50, cache_read: 5000, cache_write: 1450, output: 300 }, 800),
    line(3, 'read', { input: 2000, output: 80 }, 50),
    line(4, 'agent', { input: 50, cache_read: 6450, cache_write: 1450, output: 300 }, 900),
  ]);
  assert.equal(m.agentCalls, 3);
  assert.equal(m.preambleTokens, 5000);
  assert.equal(m.outputPerStep, 300);
  // total input grows from 5000 to 7950 over two steps: 1475 a step, of which 300 is the model's own output
  assert.equal(m.toolPerStep, 1175);
  assert.deepEqual(m.byKind, { agent: 2700, read: 50 });
  assert.equal(m.microUsd, 2750);
  assert.deepEqual(m.tokensByClass, { input: 200, output: 900, cache_write: 7800, cache_read: 11450 });
});

test('the pilot does not start on tables that do not pass the price gate', async () => {
  const { models, tables } = tablesOf();
  await assert.rejects(runPilot({ taskId: 'snip-headtail', models, tables, world, outDir: OUT, pricesDir: join(ROOT, 'examples', 'harness', 'prices'), today: TODAY }), /do not pass the gate/);
  await assert.rejects(runPilot({ taskId: 'snip-headtail', models, tables, world, outDir: OUT, today: new Date('2027-06-01T00:00:00Z') }), /do not pass the gate/, 'and not on stale ones');
});

test('E3.9 pilot: base and full on one task, scored from the journal, with the turns, the tokens and the cost of each trial, and the plan recomputed', { timeout: 1_800_000 }, async () => {
  mkdirSync(OUT, { recursive: true });
  const { models, tables } = tablesOf();
  const api = await fakeApi((entry) => {
    const isAgent = Array.isArray(entry.body?.tools);
    if (!isAgent) return answer({ blocks: [{ type: 'text', text: 'summary' }], stop: 'end_turn', usage: { input_tokens: 500, output_tokens: 60 } });
    const done = JSON.stringify(entry.body.messages).includes('Stage 2 of 2') ? edit(1) : edit(0);
    return answer({ blocks: [done, toolUse('done', {})], stop: 'tool_use', usage: { input_tokens: 300, output_tokens: 150, cache_creation_input_tokens: 4000, cache_read_input_tokens: 2000 } });
  });
  try {
    const report = await runPilot({ taskId: 'snip-headtail', models, tables, world, outDir: OUT, baseUrl: api.url, getKey: () => CANARY_KEY, sleep: async () => {}, today: TODAY });
    assert.deepEqual(report.trials.map((t) => t.config), ['base', 'full']);
    for (const t of report.trials) {
      assert.deepEqual(t.trial, { mode: 'Done', why: 'PlanDone' });
      assert.deepEqual(t.stages.map((s) => [s.state, s.turns, s.endedBy]), [['passed', 1, 'Done'], ['passed', 1, 'Done']]);
      assert.equal(t.measured.agentCalls, 2);
      assert.deepEqual(t.measured.tokensByClass, { input: 600, output: 300, cache_write: 8000, cache_read: 4000 });
      assert.equal(t.driverMicroUsd, t.measured.microUsd, 'the trial\'s spend is the sum of its calls');
      assert.equal(t.polyMicroUsd, t.driverMicroUsd, 'poly\'s charge under the module\'s live table is the driver\'s');
      assert.ok(t.driverMicroUsd > 0);
    }
    // the configurations differ in the tools offered, which the requests show
    const toolsOf = (i) => api.seen.filter((s) => Array.isArray(s.body?.tools))[i].body.tools.map((x) => x.name);
    assert.ok(!toolsOf(0).includes('edit_and_run'), 'the base harness is not offered the fused action');
    assert.ok(toolsOf(2).includes('edit_and_run'), 'the full one is');
    // the plan recomputed from the measured sizes, at the module's limits and the ruled cap
    const r = report.recomputed;
    assert.equal(r.assumptions.preamble, 6300, 'the first request\'s whole input: 300 + 4000 + 2000');
    assert.equal(r.assumptions.output, 150);
    assert.deepEqual(r.assumptions.steps, [2, 2]);
    assert.equal(r.staged.worstUsd, 24);
    assert.equal(r.staged.reservationUsd, 0.28);
    // not the 18 of the assumed sizes: the steps the cap buys at the sizes the pilot measured (a 6,300-token preamble, 150 output tokens a step)
    assert.equal(r.staged.stepsBeforeCap, stepsBeforeCap(tables[models.main], r.assumptions, 600000, 280000));
    assert.notEqual(r.staged.stepsBeforeCap, 18);
    assert.deepEqual(report.reservations, { agent: 280000, summarise: 120000, read: 110000 }, 'the limits of the module at the live tables: Opus 50,000 and 4,000; Haiku 100,000 and 4,000, and 100,000 and 2,000');
    // the key is in nothing the pilot wrote
    const written = readdirSync(OUT).map((f) => readFileSync(join(OUT, f), 'utf8')).join('\n') + JSON.stringify(report);
    assert.ok(!written.includes(CANARY_KEY));
    assert.ok(api.seen.every((s) => s.headers['x-api-key'] === CANARY_KEY && !s.raw.includes(CANARY_KEY)));
  } finally {
    await api.close();
  }
});

test('the temporary files of this file are removed', () => {
  rmSync(OUT, { recursive: true, force: true });
});
