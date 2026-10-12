// plan-e3.md E3.9 preparation, PS18.3, HF3.6: the cost of a live run from the vendor's prices, the worst case that a per-run cap
// guarantees, and what each plan that fits the month's cap leaves of the paired test's power. Unit tests; no model, no run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSUMED, OPTIONS, plan, reservation, stepsBeforeCap, trialCost } from '../../examples/harness/host/cost-plan.mjs';
import { detectableGap } from '../../examples/harness/host/paired.mjs';

const MAIN = { perMillionTokens: { input: 2000000, output: 10000000, cache_write: 2500000, cache_read: 100000 } };
const OPUS = { perMillionTokens: { input: 4000000, output: 20000000, cache_write: 5000000, cache_read: 200000 } };
const CHEAP = { perMillionTokens: { input: 1000000, output: 5000000, cache_write: 1250000, cache_read: 100000 } };

test('the reservation of PS18.3: input limit at the input price plus output limit at the highest other price', () => {
  // the module's agent decision: max input tokens 100000, max tokens 8000
  assert.equal(reservation(MAIN, 100000, 8000), 280000, '0.20 + 0.08 USD');
  assert.equal(reservation(CHEAP, 100000, 4000), 120000, 'summaries: 0.10 + 0.02 USD');
  assert.equal(reservation(CHEAP, 100000, 2000), 110000, 'receipts: 0.10 + 0.01 USD');
  // Opus 5.5: the module's limits cost 0.40 + 0.16 USD, the proposed 50,000 and 4,000 cost 0.20 + 0.08
  assert.equal(reservation(OPUS, 100000, 8000), 560000);
  assert.equal(reservation(OPUS, 50000, 4000), 280000);
});

test('the cost of a trial, by hand: one step, and three steps with the cache read and written', () => {
  const a = { preamble: 5000, output: 300, tool: 1200 };
  // one step: write 5000 at 2.5, write nothing else, output 300 at 10 -> 12500 + 3000 micro = 15500 / 1e6 USD... in micro-USD per token-million
  assert.equal(trialCost(MAIN, { ...a, steps: 1 }), Math.ceil((5000 * 2500000 + 300 * 10000000) / 1e6));
  // three steps: step 2 reads 5000, writes 1500; step 3 reads 6500, writes 1500; each writes 300 output
  const micro = (5000 * 2500000 + 300 * 10000000
    + 5000 * 100000 + 1500 * 2500000 + 300 * 10000000
    + 6500 * 100000 + 1500 * 2500000 + 300 * 10000000) / 1e6;
  assert.equal(trialCost(MAIN, { ...a, steps: 3 }), Math.ceil(micro));
});

test('the cost grows with steps, faster than linearly (the cache read of a longer transcript)', () => {
  const c = (s) => trialCost(MAIN, { ...ASSUMED, steps: s });
  assert.ok(c(20) > 2 * c(10) - c(1), 'not linear');
  assert.ok(c(10) < c(16) && c(16) < c(30) && c(30) < c(60));
});

test('the worst case is the number of runs times the per-run cap, and every option put to the owner fits 25 USD', () => {
  for (const o of OPTIONS) {
    const p = plan({ ...o, assume: ASSUMED });
    assert.equal(p.worstUsd, +(p.trials * o.capUsd).toFixed(6), o.name);
    assert.ok(p.fits && p.worstUsd <= 25, `${o.name}: ${p.worstUsd}`);
  }
  // the plan the owner described first does not: 48 runs at the 1 USD cap
  const big = plan({ name: 'asked', tasks: 12, reruns: 2, capUsd: 1, assume: ASSUMED });
  assert.equal(big.trials, 48);
  assert.equal(big.worstUsd, 48);
  assert.equal(big.fits, false);
});

test('a run stops when spent plus the reservation would pass the cap: the spendable part of a cap is the cap less the reservation', () => {
  const p = plan({ name: 'full', tasks: 12, reruns: 2, capUsd: 0.5, maxInput: 50000, maxOutput: 4000, assume: ASSUMED });
  assert.equal(p.reservationUsd, 0.28);
  assert.equal(p.spendableUsd, 0.22);
  assert.equal(p.stepsBeforeCap, 12);
  const room = 220000;
  assert.ok(trialCost(OPUS, { ...ASSUMED, steps: 12 }) <= room && trialCost(OPUS, { ...ASSUMED, steps: 13 }) > room);
  assert.equal(stepsBeforeCap(OPUS, ASSUMED, 500000, 280000), 12);
  // a cap at or under the reservation lets no call through
  const tight = plan({ name: 'tight', tasks: 12, reruns: 2, capUsd: 0.25, maxInput: 50000, maxOutput: 4000, assume: ASSUMED });
  assert.deepEqual([tight.stepsBeforeCap, tight.spendableUsd], [0, 0]);
});

test('at Opus 5.5 prices the module\'s own limits leave one step under the staged cap: the reservation is 0.56 USD', () => {
  const asIs = plan({ name: 'staged-as-is', tasks: 12, trials: 40, capUsd: 0.6, assume: ASSUMED });
  assert.deepEqual([asIs.maxInput, asIs.maxOutput, asIs.reservationUsd, asIs.spendableUsd, asIs.stepsBeforeCap], [100000, 8000, 0.56, 0.04, 1]);
  // the largest cap 40 runs allow is 25 / 40 = 0.625, and it buys three steps
  const top = plan({ name: 'staged-top', tasks: 12, trials: 40, capUsd: 0.625, assume: ASSUMED });
  assert.deepEqual([top.worstUsd, top.fits, top.spendableUsd, top.stepsBeforeCap], [25, true, 0.065, 3]);
});

test('the fix: lowering the agent decision\'s limits buys steps, and the input limit stops being what binds at 50,000 and 4,000', () => {
  const row = (maxInput, maxOutput) => { const p = plan({ name: 'x', tasks: 12, trials: 40, capUsd: 0.6, maxInput, maxOutput, assume: ASSUMED }); return [p.reservationUsd, p.spendableUsd, p.stepsBeforeCap, p.stepsBeforeInputLimit]; };
  assert.deepEqual(row(60000, 4000), [0.32, 0.28, 16, 37]);
  assert.deepEqual(row(50000, 4000), [0.28, 0.32, 18, 31]);
  assert.deepEqual(row(40000, 4000), [0.24, 0.36, 20, 24]);
  assert.deepEqual(row(40000, 2000), [0.2, 0.4, 22, 24]);
  assert.deepEqual(row(30000, 2000), [0.16, 0.44, 23, 17], 'at 30,000 the input limit binds first (17 steps)');
  const proposed = row(50000, 4000);
  assert.ok(proposed[2] < proposed[3], 'the cap, not the input limit, ends a trial');
});
test('what each option leaves of the paired test: 12 pairs detect a gain of half the tasks, 8 pairs only 0.70; a single run measures no noise floor', () => {
  assert.deepEqual(OPTIONS.map((o) => o.name), ['staged', 'staged-on-4', 'full', 'eight-tasks', 'single-run']);
  const by = Object.fromEntries(OPTIONS.map((o) => [o.name, plan({ ...o, assume: ASSUMED })]));
  assert.equal(by.full.detectableGap, 0.5);
  assert.equal(by.staged.detectableGap, 0.5);
  assert.equal(by['staged-on-4'].detectableGap, 0.5);
  assert.deepEqual([by.staged.stepsBeforeCap, by['staged-on-4'].stepsBeforeCap, by.full.stepsBeforeCap, by['eight-tasks'].stepsBeforeCap, by['single-run'].stepsBeforeCap], [18, 26, 12, 25, 36]);
  assert.equal(by['staged-on-4'].trials, 24 + 8);
  assert.equal(by['eight-tasks'].detectableGap, 0.7);
  assert.equal(by['single-run'].detectableGap, 0.5);
  assert.equal(by.full.detectableGap, detectableGap(12));
  assert.ok(by['eight-tasks'].detectableGap > by.full.detectableGap, 'fewer tasks detect less');
  // the staged plan: 24 first runs and 16 reruns, 40 in all
  assert.equal(by.staged.trials, 24 + 16);
  assert.equal(by['single-run'].trials, 24);
  assert.equal(by.full.discordantNeeded, 5);
});

test('the expected cost at Opus 5.5 prices and the assumed sizes: 0.28 USD for 16 steps, and a longer trial is stopped by its cap', () => {
  const p = plan({ name: 'staged', tasks: 12, trials: 40, capUsd: 0.6, maxInput: 50000, maxOutput: 4000, assume: ASSUMED });
  assert.deepEqual([10, 16, 30, 60].map((s) => +p.expected[s].trialUsd.toFixed(2)), [0.17, 0.28, 0.57, 1.4]);
  assert.equal(p.expected[16].capped, false);
  assert.equal(p.expected[30].capped, true, 'a 30-step trial costs more than the 0.32 spendable and stops at 18 steps');
  assert.equal(p.expected[60].capped, true);
  assert.ok(p.expected[60].runUsd <= p.capUsd);
  assert.ok(40 * p.expected[16].trialUsd < 25 / 2, 'expected total under half the month cap, when trials take 16 steps');
});
