// The analysis of PT13 (plan-m3 section 7) on known values and on synthetic records built so that each rule's
// answer is known: a clear win, a null result, the surface decision each way, and a stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wilcoxonSignedRank, holm, ranks } from '../experiments/m3/analysis/stats.mjs';
import { analyse, runMeasures } from '../experiments/m3/analysis/analyse.mjs';

test('Wilcoxon signed-rank, exact and two-sided, on known values', () => {
  // Ten differences, all positive: W+ is 55, the most extreme of 2^10 sign patterns, so p = 2/1024.
  const x = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const y = x.map((v, i) => v - (i + 1));
  assert.deepEqual(wilcoxonSignedRank(x, y), { n: 10, wPlus: 55, p: 2 / 1024 });
  // Zero differences are dropped.
  assert.equal(wilcoxonSignedRank([1, 2, 3], [1, 2, 3]).p, 1);
  // Five differences, ranks 1..5, one negative at rank 1: W+ = 14; P(W+ >= 14) = 2/32, so p = 4/32.
  assert.equal(wilcoxonSignedRank([2, 3, 4, 5, 0], [0, 0, 0, 0, 1]).p, 4 / 32);
  // Ties share mean ranks, and the enumeration uses them.
  assert.deepEqual(ranks([3, 1, 3, 2]), [3.5, 1, 3.5, 2]);
  const t = wilcoxonSignedRank([1, 1, 2, -1], [0, 0, 0, 0]);
  assert.equal(t.wPlus, 2 + 2 + 4);
  assert.ok(t.p > 0 && t.p <= 1);
});

test('Holm\'s correction on known values', () => {
  const h = holm([0.01, 0.04, 0.03, 0.005], 0.05);
  // Sorted: 0.005*4 = 0.02, 0.01*3 = 0.03, 0.03*2 = 0.06, 0.04*1 = 0.04 -> monotone 0.06.
  assert.deepEqual(h.map((x) => +x.adjusted.toFixed(4)), [0.03, 0.06, 0.06, 0.02]);
  assert.deepEqual(h.map((x) => x.rejected), [true, false, false, true]);
});

const TASKS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10'];

/** A scored run record with four delivered versions, `escaped` failing O1 tests in all, and `tokens` spent. */
function run(arm, task, i, { escaped, tokens, delivered = true, admitted = true }) {
  const per = [escaped, 0, 0, 0];
  return {
    id: `${task}-arm${arm}-run${i}`, arm, task, run: i, spent: { tokens, wallMs: 1000 },
    scores: per.map((f, n) => ({ n, delivered, withinBudget: true, admitted: arm >= 3 ? admitted : null, o1: { ran: true, tests: 20, failed: f }, o2: { violated: [] }, o3: { traces: 10, failed: 0 } })),
  };
}

/** Five runs per arm and task; `f(arm, task index, run)` gives the run's options. */
function records(f) {
  const out = [];
  for (const arm of [1, 2, 3, 4]) TASKS.forEach((t, k) => { for (let i = 1; i <= 5; i++) out.push(run(arm, t, i, f(arm, k, i))); });
  return out;
}

test('a run delivers its task only when every version was delivered within budget, and its escaped defects add up', () => {
  const r = run(3, 'T1', 1, { escaped: 3, tokens: 10 });
  assert.deepEqual([runMeasures(r).delivered, runMeasures(r).escaped, runMeasures(r).admitted], [true, 3, true]);
  r.scores[2].withinBudget = false;
  assert.equal(runMeasures(r).delivered, false);
});

test('a clear win: arm 3 halves the escaped defects on every task at no more tokens', () => {
  const a = analyse(records((arm, k, i) => ({ escaped: arm === 3 ? 2 + (k % 3) : 6 + k + (i % 2), tokens: arm === 3 ? 150_000 : 100_000 })));
  assert.equal(a.rules.verdict, 'win');
  assert.deepEqual(a.rules.win[3], { effect: true, significant: true, win: true });
  assert.equal(a.rules.win[4].effect, false);
  const c31 = a.comparisons.escapedDefects.find((c) => c.arms[0] === 3 && c.arms[1] === 1);
  assert.equal(c31.tasks, 10);
  assert.ok(c31.rejected && c31.p === 2 / 1024);
});

test('S96: a 30% reduction that is not significant after Holm is no win', () => {
  // Arm 3 is better on six tasks and worse on four: the mean drops by more than 30%, the signed-rank test does not reject.
  const a = analyse(records((arm, k) => ({ escaped: arm === 3 ? (k < 6 ? 0 : 6) : 5, tokens: 100_000 })));
  assert.equal(a.rules.win[3].effect, true);
  assert.equal(a.rules.win[3].significant, false);
  assert.equal(a.rules.verdict, 'between');
});

test('S99: tokens are kept in their four parts, the sum is the measure, and cost at list price is secondary', async () => {
  const { tokenParts, costOf } = await import('../experiments/m3/analysis/analyse.mjs');
  const r = { versions: [{ usage: { input_tokens: 1e6, output_tokens: 2e6, cache_read_input_tokens: 3e6, cache_creation_input_tokens: 4e6 } }, { usage: { input_tokens: 1e6 } }] };
  assert.deepEqual(tokenParts(r), { input: 2e6, output: 2e6, cacheRead: 3e6, cacheWrite: 4e6 });
  assert.equal(costOf(tokenParts(r), { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }), 2 * 5 + 2 * 25 + 3 * 0.5 + 4 * 6.25);
});

test('a win in effect needs tokens no more than twice arm 1\'s', () => {
  const a = analyse(records((arm, k) => ({ escaped: arm === 3 ? 1 : 10 + k, tokens: arm === 3 ? 210_000 : 100_000 })));
  assert.equal(a.rules.win[3].effect, false);
  assert.equal(a.rules.verdict, 'between');
});

test('a null result: every arm alike, nothing significant, no win', () => {
  const a = analyse(records((arm, k, i) => ({ escaped: 4 + ((k + i + arm) % 3), tokens: 100_000 })));
  assert.equal(a.rules.verdict, 'between');
  assert.ok(a.comparisons.escapedDefects.every((c) => !c.rejected));
  assert.deepEqual([a.rules.win[3].effect, a.rules.win[4].effect], [false, false]);
});

test('the surface decision: arm 4 within 10% of arm 3 and cheaper makes the embedded surface primary', () => {
  const a = analyse(records((arm) => ({ escaped: arm === 4 ? 5.25 : 5, tokens: arm === 4 ? 90_000 : 100_000 })));
  assert.equal(a.rules.surface, 'embedded');
});

test('the surface decision: arm 4 more than 10% worse, or dearer, keeps the standalone syntax', () => {
  assert.equal(analyse(records((arm) => ({ escaped: arm === 4 ? 6 : 5, tokens: arm === 4 ? 90_000 : 100_000 }))).rules.surface, 'standalone');
  assert.equal(analyse(records((arm) => ({ escaped: 5, tokens: arm === 4 ? 110_000 : 100_000 }))).rules.surface, 'standalone');
});

test('a stop: neither poly arm delivers an admitted program in 70% of its runs', () => {
  // Arms 3 and 4 deliver an admitted program in three runs of five (60%).
  const a = analyse(records((arm, _k, i) => ({ escaped: 1, tokens: 100_000, admitted: arm < 3 || i <= 3 })));
  assert.equal(a.rules.stop, true);
  assert.equal(a.rules.verdict, 'stop');
  assert.deepEqual(a.rules.admittedRate, { 3: 0.6, 4: 0.6 });
  // One poly arm at 80% is not a stop.
  assert.equal(analyse(records((arm, _k, i) => ({ escaped: 1, tokens: 100_000, admitted: arm !== 4 || i <= 3 }))).rules.stop, false);
});

test('a task with no delivered run for an arm is left out of that comparison, and the report says so', () => {
  const a = analyse(records((arm, k) => ({ escaped: 3, tokens: 100_000, delivered: !(arm === 4 && k === 0) })));
  const c41 = a.comparisons.escapedDefects.find((c) => c.arms[0] === 4 && c.arms[1] === 1);
  assert.equal(c41.tasks, 9);
  assert.deepEqual(c41.leftOut, ['T1']);
});
