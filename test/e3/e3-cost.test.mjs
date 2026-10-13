// plan-e3.md E3.6, HAC6: the cost of each call is reported as its preamble (system prompt and tool schemas), its transcript and
// its output, and the step count per trial is reported with it, so that a change in cost can be traced to the term that moved
// it. The terms are the host's, taken as the provider is asked; the usage and the cost are the runtime's own, from its decision
// events; the report is consistent only when the two agree on every call, and a cost is recomputed from the price table.
// Labels (owner, 2026-10-11): a synthetic corpus of 12 trajectories with tokens estimated at four characters each; "reached the
// end of the plan", not "solved the task"; the figures hold for recordings only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';
import { CONFIGS, matrix, reportOf } from './e3-matrix-helpers.mjs';
import { run } from './e3-loop-helpers.mjs';
import { movedTerms } from '../../examples/harness/host/cost-report.mjs';
import { PREAMBLE, tokensOf, ALL_OFF, ALL_ON } from '../../examples/harness/host/loop.mjs';
import { step, trajectories } from '../fixtures/harness/trajectories.mjs';

const TABLE = join(ROOT, 'docs', 'e3', 'cost-report.json');
const corpus = () => trajectories();
const named = (n) => corpus().find((t) => t.name === n);

test('HAC6: in all 72 runs every call\'s terms are the runtime\'s own usage and the price table\'s cost, and the step and request counts follow the recording', { timeout: 1_800_000 }, async () => {
  const m = await matrix();
  let calls = 0;
  for (const [n, { runs }] of Object.entries(m)) {
    for (const [cfg, r] of Object.entries(runs)) {
      assert.deepEqual(r.report.problems, [], `${n}/${cfg}`);
      assert.equal(r.report.consistent, true);
      assert.equal(r.report.steps, r.steps, `${n}/${cfg}: steps`);
      // a request is a call of the main model: one for each answer of the recording that the trial reached, a reprompt included
      assert.equal(r.report.requests, r.modelEntries, `${n}/${cfg}: requests`);
      calls += r.report.rows.length;
    }
  }
  assert.ok(calls > 200, `${calls} calls reported`);
});

test('HAC6: a longer preamble moves the preamble term and no other', { timeout: 600_000 }, async () => {
  const t = named('t01-fix-tests');
  const extra = ' Every request also carries this sentence about the tools.'.repeat(4);
  const a = await run('e3-cost-pre-a', structuredClone(t.recording), { mechanisms: ALL_OFF });
  const b = await run('e3-cost-pre-b', structuredClone(t.recording), { mechanisms: ALL_OFF, preamble: PREAMBLE + extra });
  try {
    const ra = reportOf(a.rt, a.result);
    const rb = reportOf(b.rt, b.result);
    assert.ok(ra.consistent && rb.consistent);
    const added = tokensOf(PREAMBLE + extra) - tokensOf(PREAMBLE);
    assert.equal(rb.tiers.main.preamble - ra.tiers.main.preamble, added * ra.requests, 'the preamble term moved by the sentence in every request');
    // the transcript is the rest of the input: it moves by at most the rounding of a token a request
    assert.deepEqual(movedTerms(ra, rb, ra.requests), ['preamble']);
    assert.equal(rb.tiers.main.output, ra.tiers.main.output);
    assert.equal(rb.steps, ra.steps);
  } finally {
    await a.rt.close();
    await b.rt.close();
  }
});

test('HAC6: a longer answer moves the output term, and the transcript by the same words in each later request', { timeout: 600_000 }, async () => {
  const t = named('t01-fix-tests');
  const longer = structuredClone(t.recording);
  const pad = ' '.repeat(0) + '"note":"' + 'considering the options for this edit '.repeat(20) + '"';
  const call = JSON.parse(longer.steps[0].model[0].calls);
  call[1] = { ...call[1], pad };
  longer.steps[0].model[0].calls = JSON.stringify(call);
  const a = await run('e3-cost-out-a', structuredClone(t.recording), { mechanisms: ALL_OFF });
  const b = await run('e3-cost-out-b', longer, { mechanisms: ALL_OFF });
  try {
    const ra = reportOf(a.rt, a.result);
    const rb = reportOf(b.rt, b.result);
    assert.ok(ra.consistent && rb.consistent);
    const dOut = rb.tiers.main.output - ra.tiers.main.output;
    assert.ok(dOut > 100, `output moved by ${dOut}`);
    const dTr = rb.tiers.main.transcript - ra.tiers.main.transcript;
    // step 0's answer is in the transcript of step 1's request (one later request), within a token of rounding
    assert.ok(Math.abs(dTr - dOut) <= 2, `transcript moved by ${dTr}, output by ${dOut}`);
    assert.equal(rb.tiers.main.preamble, ra.tiers.main.preamble);
    assert.deepEqual(movedTerms(ra, rb, 2), ['transcript', 'output']);
  } finally {
    await a.rt.close();
    await b.rt.close();
  }
});

test('HAC6: switching the reducer on moves the transcript term of the main tier, and puts the log into the cheap tier', { timeout: 600_000 }, async () => {
  const m = await matrix();
  const base = m['t04-big-build-log'].runs.base.report;
  const on = m['t04-big-build-log'].runs.reducer.report;
  assert.deepEqual(movedTerms(base, on, 0), ['transcript']);
  assert.ok(on.tiers.main.transcript < base.tiers.main.transcript);
  assert.equal(base.tiers.cheap, undefined);
  assert.equal(on.tiers.cheap.calls, 1);
  assert.ok(on.tiers.cheap.transcript > 3000, 'the 14 KiB log is the cheaper model\'s input');
  assert.equal(on.tiers.main.output, base.tiers.main.output);
  assert.equal(on.tiers.main.preamble, base.tiers.main.preamble);
  // a cost that moved is traced: the micro-usd difference of the main tier is the difference of its input at the main price
  const price = JSON.parse(readFileSync(join(ROOT, 'examples', 'harness', 'prices', 'main.json'), 'utf8')).perMillionTokens;
  const dIn = on.tiers.main.preamble + on.tiers.main.transcript - (base.tiers.main.preamble + base.tiers.main.transcript);
  const dCost = on.tiers.main.microUsd - base.tiers.main.microUsd;
  assert.ok(Math.abs(dCost - (dIn * price.input) / 1_000_000) <= on.tiers.main.calls, `${dCost} against ${(dIn * price.input) / 1_000_000}`);
});

test('HAC6: the report of the corpus by configuration, and held in docs/e3/cost-report.json', { timeout: 1_800_000 }, async () => {
  const m = await matrix();
  const byConfig = {};
  for (const cfg of Object.keys(CONFIGS)) {
    const t = { steps: 0, requests: 0, main: { calls: 0, preamble: 0, transcript: 0, output: 0, microUsd: 0 }, cheap: { calls: 0, preamble: 0, transcript: 0, output: 0, microUsd: 0 } };
    for (const { runs } of Object.values(m)) {
      const r = runs[cfg].report;
      t.steps += r.steps;
      t.requests += r.requests;
      for (const tier of ['main', 'cheap']) for (const k of Object.keys(t[tier])) t[tier][k] += r.tiers[tier]?.[k] ?? 0;
    }
    byConfig[cfg] = t;
  }
  const perTrajectory = Object.fromEntries(Object.entries(m).map(([n, { runs }]) => [n, Object.fromEntries(Object.entries(runs).map(([cfg, r]) => [cfg, { steps: r.report.steps, requests: r.report.requests, main: r.report.tiers.main ?? null, cheap: r.report.tiers.cheap ?? null }]))]));
  const table = {
    labels: {
      corpus: 'a synthetic corpus of 12 trajectories, with tokens estimated at four characters each',
      completion: '"reached the end of the plan", not "solved the task"',
      scope: 'the figures hold for recordings only; the saving of Action Fusion cannot show on recordings and is measured at the live run',
      terms: 'a call\'s input is its preamble (the system prompt and the tool schemas) and its transcript; its output is what the model wrote; tiers: main is the agent, cheap is the summaries and the receipts',
      prices: 'placeholder price tables (example.com): the live run does not start until they pass host/price-gate.mjs',
    },
    byConfig,
    perTrajectory,
  };
  console.log(`\nHAC6 by configuration (preamble, transcript, output tokens of the main tier; requests; steps):\n${Object.entries(byConfig).map(([c, v]) => `  ${c.padEnd(10)} ${v.main.preamble} + ${v.main.transcript} + ${v.main.output}  ${v.requests} requests, ${v.steps} steps, ${v.main.microUsd + v.cheap.microUsd} micro-usd`).join('\n')}`);
  assert.ok(byConfig.all.main.transcript < byConfig.base.main.transcript, 'the full harness shows the main model less transcript');
  assert.equal(byConfig.all.main.preamble > 0, true);
  if (process.env.UPDATE_E3 || !existsSync(TABLE)) {
    mkdirSync(join(ROOT, 'docs', 'e3'), { recursive: true });
    writeFileSync(TABLE, `${JSON.stringify(table, null, 2)}\n`);
  }
  assert.deepEqual(JSON.parse(readFileSync(TABLE, 'utf8')), JSON.parse(JSON.stringify(table)), 'the committed table is the one this corpus gives (UPDATE_E3=1 rewrites it)');
});

void step;
void ALL_ON;
