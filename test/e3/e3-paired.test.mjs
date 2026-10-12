// plan-e3.md E3.8, HAC3, HAC8, HF2.8, Q-E3-6 and the owner's rulings of 2026-10-12: the paired acceptance and its statistics.
// Unit tests on synthetic pairs and synthetic outcome tables. No admission, no checker, no model. A replay of a recording
// repeats exactly, so the noise floor of a recording is zero by construction; the tests below say so and do not treat it as a
// measurement (the real floor is measured at E3.9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';
import { criticalWins, decide, detectableGap, mcnemarExact, minDiscordant, noiseFloor, power, upperTail } from '../../examples/harness/host/paired.mjs';

/** A run as the scorer gives it: the stage scores, 1 or 0. */
const run = (...scores) => ({ total: scores.length, stages: scores.map((score) => ({ score })) });
const PASS = run(1, 1, 1);
const FAIL3 = run(1, 1, 0); // fails its last stage only
const ids = (n) => Array.from({ length: n }, (_, i) => `t${String(i + 1).padStart(2, '0')}`);

/** Twelve tasks, each a plan of three stages. `base` and `cand` give a run (or its reruns) per task index. */
function table(base, cand, n = 12) {
  const b = {};
  const c = {};
  ids(n).forEach((id, i) => {
    const one = (f, i2) => { const r = f(i2); return Array.isArray(r) ? r : [r, r]; };
    b[id] = one(base, i);
    c[id] = one(cand, i);
  });
  return { base: b, candidate: c };
}

test('the exact tail: the values the spec states for 12 pairs, and the first outcome that reaches 0.05', () => {
  assert.equal(upperTail(5, 5), 1 / 32);
  assert.ok(Math.abs(upperTail(8, 7) - 9 / 256) < 1e-15);
  assert.ok(Math.abs(upperTail(9, 8) - 10 / 512) < 1e-15);
  assert.equal(upperTail(7, 6), 8 / 128, '6 of 7 gives 0.0625');
  assert.equal(upperTail(4, 4), 1 / 16, '4 of 4 gives 0.0625, so 4 discordant pairs can never reach 0.05');
  assert.equal(upperTail(10, 0), 1);
  assert.equal(upperTail(10, 11), 0);
  assert.equal(minDiscordant(), 5);
  // the table: out of m discordant pairs, at least k must go one way
  assert.deepEqual([4, 5, 6, 7, 8, 9, 10, 12].map((m) => criticalWins(m)), [null, 5, 6, 7, 7, 8, 9, 10]);
  // 6 of 7 is not enough, 7 of 7 is (the spec's sentence: only 5 of 5, 7 of 8, 8 of 9 among those it lists)
  assert.ok(mcnemarExact(5, 0).pGain <= 0.05 && mcnemarExact(7, 1).pGain <= 0.05 && mcnemarExact(8, 1).pGain <= 0.05);
  assert.ok(mcnemarExact(6, 1).pGain > 0.05);
  const m = mcnemarExact(7, 1);
  assert.deepEqual([m.b, m.c, m.discordant], [7, 1, 8]);
  assert.ok(m.pLoss > 0.9, 'the other direction is near 1');
});

test('the exact tail is exact for large counts (no overflow, no float drift)', () => {
  const p = upperTail(200, 100);
  assert.ok(p > 0.5 && p < 0.6, String(p));
  assert.equal(upperTail(1000, 1000), 0, 'rounds to zero below 1e-17 rather than overflowing');
  // an independent computation: Pascal's triangle in floats, summed from k to m
  let row = [1];
  for (let i = 1; i <= 60; i += 1) row = Array.from({ length: i + 1 }, (_, j) => (j === 0 || j === i ? 1 : row[j - 1] + row[j]));
  const direct = row.slice(40).reduce((a, x) => a + x, 0) / 2 ** 60;
  assert.ok(Math.abs(upperTail(60, 40) - direct) < 1e-12, `${upperTail(60, 40)} ${direct}`);
});

test('power and the detectable gap: more pairs detect smaller gaps, fewer discordant pairs detect less, and the 12-pair set detects only a large one', () => {
  const g12 = detectableGap(12);
  const g30 = detectableGap(30);
  const g100 = detectableGap(100);
  assert.ok(g12 !== null && g30 !== null && g100 !== null);
  assert.ok(g12 > g30 && g30 > g100, `${g12} ${g30} ${g100}`);
  assert.equal(g12, 0.5, 'with 12 pairs, even when every discordant pair favours the candidate, a gain of half the tasks is needed for 80% power');
  assert.equal(detectableGap(12, 0.2), null, 'a task set where at most one pair in five is discordant detects no gap up to that share at 80% power');
  assert.ok(power(12, 1, 0.9) > power(12, 1, 0.5));
  assert.throws(() => power(12, 0.2, 0.5), /cannot exceed/);
  assert.ok(Math.abs(power(12, 1, 1) - 1) < 1e-9, 'every pair won, every pair discordant: certain');
});

test('the noise floor of a recording is zero by construction and says it is not a measurement', () => {
  const same = { a: [PASS, PASS], b: [FAIL3, FAIL3] };
  const f = noiseFloor(same, { source: 'recording' });
  assert.equal(f.rate, 0);
  assert.equal(f.stageRate, 0);
  assert.equal(f.measured, false);
  assert.match(f.note, /zero by construction/);
  assert.match(f.note, /not a measurement/);
  assert.match(f.note, /E3\.9/);
  // a replay that differs is a defect, not noise
  assert.throws(() => noiseFloor({ a: [PASS, FAIL3] }, { source: 'recording' }), /defect of the replay/);
  assert.throws(() => noiseFloor({ a: [PASS, run(1, 0, 1)] }, { source: 'recording' }), /defect of the replay/);
  assert.throws(() => noiseFloor({ a: [PASS] }, { source: 'file' }), /recording.*live/);
});

test('the noise floor of a live set is measured from reruns with the model frozen, and needs at least two reruns', () => {
  const live = { a: [PASS, PASS], b: [PASS, FAIL3], c: [FAIL3, FAIL3], d: [run(1, 0, 1), run(1, 1, 1)] };
  const f = noiseFloor(live, { source: 'live' });
  assert.equal(f.measured, true);
  assert.equal(f.tasks, 4);
  assert.equal(f.disagreeing, 2, 'b and d differ between their reruns; a and c do not');
  assert.equal(f.rate, 0.5);
});

test('ACCEPT: a significant gain on discordant pairs and no regressed stage (recordings: the floor is stated as not measured)', () => {
  const t = table((i) => (i < 5 ? FAIL3 : PASS), () => PASS);
  const r = decide({ ...t, source: 'recording' });
  assert.equal(r.verdict, 'ACCEPT');
  assert.equal(r.instance.pairs.n, 12);
  assert.deepEqual([r.instance.pairs.better.length, r.instance.pairs.worse.length, r.instance.pairs.discordant], [5, 0, 5]);
  assert.ok(r.instance.pairs.pGain <= 0.05);
  assert.deepEqual(r.instance.regressions, []);
  assert.equal(r.instance.noise.base.measured, false);
  assert.ok(r.reasons.some((x) => /noise floor is not measured/.test(x) && /recordings evidence/.test(x)));
  assert.equal(r.instance.detectableGap, 0.5, 'the checked instance carries the detectable gap');
  assert.match(r.instance.detectableGapNote, /80% power/);
  // the verdict prints its checked instance (PT12.3a): source, alpha, tasks, pairs, regressions
  assert.deepEqual(Object.keys(r.instance).slice(0, 5), ['source', 'alpha', 'tasks', 'pairs', 'regressions']);
});

test('INCONCLUSIVE, never "no difference": too few discordant pairs for any outcome to reach alpha', () => {
  for (const gains of [0, 1, 4]) {
    const t = table((i) => (i < gains ? FAIL3 : PASS), () => PASS);
    const r = decide({ ...t, source: 'recording' });
    assert.equal(r.verdict, 'INCONCLUSIVE', `${gains} gains`);
    assert.match(r.reasons[0], /fewer than 5/);
    assert.match(r.reasons[0], /not "no difference"/);
  }
  // 5 of 5 is the first that is accepted
  assert.equal(decide({ ...table((i) => (i < 5 ? FAIL3 : PASS), () => PASS), source: 'recording' }).verdict, 'ACCEPT');
});

test('REFUSE: a gain with any regressed stage (HAC8: improves one stage, regresses another)', () => {
  // five tasks gain their last stage, and one task that was complete loses its first stage
  const t = table((i) => (i < 5 ? FAIL3 : PASS), (i) => (i === 11 ? run(0, 1, 1) : PASS));
  const r = decide({ ...t, source: 'recording' });
  assert.equal(r.verdict, 'REFUSE');
  assert.deepEqual(r.instance.regressions, [{ task: 't12', stage: 0 }]);
  assert.match(r.reasons[0], /regress/);
  assert.match(r.reasons[0], /HAC8/);
  // the seeded change of the acceptance criterion, in one task: stage 0 improves, stage 1 regresses
  const seeded = table(() => run(0, 1, 1), () => run(1, 0, 1));
  const s = decide({ ...seeded, source: 'recording' });
  assert.equal(s.verdict, 'REFUSE');
  assert.equal(s.instance.regressions.length, 12);
  // a regressed stage in a task that did not complete either way still refuses
  const quiet = table(() => run(1, 0, 0), () => run(0, 0, 0));
  assert.equal(decide({ ...quiet, source: 'recording' }).verdict, 'REFUSE');
});

test('REFUSE: 6 of 7 is not the statistic\'s fault: the one pair against the candidate is a regressed stage', () => {
  assert.ok(mcnemarExact(6, 1).pGain > 0.05);
  const t = table((i) => (i < 6 ? FAIL3 : i === 6 ? PASS : PASS), (i) => (i === 6 ? FAIL3 : PASS));
  const r = decide({ ...t, source: 'recording' });
  assert.equal(r.verdict, 'REFUSE');
  assert.equal(r.instance.pairs.worse.length, 1);
});

test('REFUSE: a cheaper candidate that completes fewer tasks fails, whatever it costs (HAC3, the seeded cheaper-and-worse table)', () => {
  const t = table(() => PASS, (i) => (i < 3 ? FAIL3 : PASS));
  const costs = { base: { usd: 10, tokens: 100000 }, candidate: { usd: 4, tokens: 40000 } };
  const r = decide({ ...t, source: 'recording', costs });
  assert.equal(r.verdict, 'REFUSE');
  assert.deepEqual(r.instance.costs, costs, 'the costs are reported beside the verdict');
  const same = decide({ ...table(() => PASS, () => PASS), source: 'recording', costs: { base: { usd: 10 }, candidate: { usd: 1 } } });
  assert.equal(same.verdict, 'INCONCLUSIVE', 'a much cheaper candidate with the same completions is not accepted on cost: no gain was shown');
});

test('a measured noise floor as large as the gain makes it INCONCLUSIVE; a small one does not', () => {
  // live: five tasks where the base passes one rerun and fails the other; the candidate passes both
  const flaky = table((i) => (i < 5 ? [FAIL3, PASS] : [PASS, PASS]), () => [PASS, PASS]);
  const r = decide({ ...flaky, source: 'live' });
  assert.equal(r.instance.noise.base.measured, true);
  assert.equal(r.instance.noise.base.rate, 5 / 12);
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.match(r.reasons[0], /not above the rerun spread/);
  // the same gain with stable reruns is accepted, and the floor is a measurement of zero
  const steady = table((i) => (i < 5 ? [FAIL3, FAIL3] : [PASS, PASS]), () => [PASS, PASS]);
  const a = decide({ ...steady, source: 'live' });
  assert.equal(a.verdict, 'ACCEPT');
  assert.equal(a.instance.noise.base.measured, true);
  assert.equal(a.instance.noise.base.rate, 0);
  assert.ok(!a.reasons.some((x) => /not measured/.test(x)));
  // a live set with one run per task has no floor and is refused as input
  assert.throws(() => decide({ ...table(() => [PASS], () => [PASS]), source: 'live' }), /at least two reruns/);
});

test('the change gate comes first: a change outside the editable surface is REFUSE before any statistic', () => {
  const t = table((i) => (i < 5 ? FAIL3 : PASS), () => PASS);
  const bad = decide({ ...t, source: 'recording', changed: ['editable/prompts/a.md', 'harness.poly'] });
  assert.equal(bad.verdict, 'REFUSE');
  assert.deepEqual(bad.instance.refusedFiles.map((x) => x.file), ['harness.poly']);
  assert.match(bad.reasons[0], /harness\.poly/);
  assert.equal(bad.instance.pairs, null, 'no pairs were counted');
  assert.equal(decide({ ...t, source: 'recording', changed: ['editable/prompts/a.md', 'editable/thresholds.json'] }).verdict, 'ACCEPT');
  assert.equal(decide({ ...t, source: 'recording', changed: ['harness.policy.poly'] }).verdict, 'REFUSE');
});

test('inputs that are not pairs are errors, not verdicts', () => {
  const t = table(() => PASS, () => PASS);
  const missing = { ...t, candidate: Object.fromEntries(Object.entries(t.candidate).slice(1)) };
  assert.throws(() => decide({ ...missing, source: 'recording' }), /different tasks/);
  const plan = table(() => PASS, (i) => (i === 0 ? run(1, 1) : PASS));
  assert.throws(() => decide({ ...plan, source: 'recording' }), /different plans/);
  assert.throws(() => decide({ base: {}, candidate: {}, source: 'recording' }), /no tasks/);
  assert.throws(() => decide({ base: { a: [] }, candidate: { a: [PASS] }, source: 'recording' }), /has no run/);
});

test('the decision is deterministic, reads no model and no clock, and imports only the change gate', () => {
  const t = table((i) => (i < 5 ? FAIL3 : PASS), () => PASS);
  assert.deepEqual(decide({ ...t, source: 'recording' }), decide({ ...t, source: 'recording' }));
  const src = readFileSync(join(ROOT, 'examples', 'harness', 'host', 'paired.mjs'), 'utf8');
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['./change-gate.mjs']);
  assert.ok(!/Math\.random|Date\.now|new Date|fetch\(|process\.env/.test(src));
});

test('the rule of the module answers each seeded table as the proposal says (HAC8, HAC3)', () => {
  const rows = [
    ['gain, no regression, 5 discordant', table((i) => (i < 5 ? FAIL3 : PASS), () => PASS), 'ACCEPT'],
    ['gain on 4 only', table((i) => (i < 4 ? FAIL3 : PASS), () => PASS), 'INCONCLUSIVE'],
    ['gain on 5, one regressed stage elsewhere', table((i) => (i < 5 ? FAIL3 : PASS), (i) => (i === 8 ? run(1, 0, 1) : PASS)), 'REFUSE'],
    ['cheaper and worse', table(() => PASS, (i) => (i < 2 ? FAIL3 : PASS)), 'REFUSE'],
    ['identical', table(() => PASS, () => PASS), 'INCONCLUSIVE'],
  ];
  for (const [name, t, expected] of rows) assert.equal(decide({ ...t, source: 'recording' }).verdict, expected, name);
});
