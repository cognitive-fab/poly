// S115: the material each arm receives holds worked examples, and some model a task family (the manual's Order,
// checkout and OutboxIntent). The analysis is pre-registered with a sensitivity analysis: the primary comparison
// over all ten tasks, and the same comparison over the tasks no arm's material models. Both are reported, and a
// win that holds only with the modelled tasks is reported as such, never as a win. Synthetic records where the
// two answers differ show it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyse, MODELLED, modelledTasks } from '../experiments/m3/analysis/analyse.mjs';
import { M3 } from '../experiments/m3/lib/task.mjs';

const TASKS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10'];

function run(arm, task, i, { escaped, tokens }) {
  return {
    id: `${task}-arm${arm}-run${i}`, arm, task, run: i, spent: { tokens, wallMs: 1000 },
    scores: [escaped, 0, 0, 0].map((f, n) => ({ n, delivered: true, withinBudget: true, admitted: arm >= 3 ? true : null, o1: { ran: true, tests: 20, failed: f }, o2: { violated: [] }, o3: { traces: 10, failed: 0 } })),
  };
}

function records(f) {
  const out = [];
  for (const arm of [1, 2, 3, 4]) TASKS.forEach((t, k) => { for (let i = 1; i <= 5; i++) out.push(run(arm, t, i, f(arm, t, k))); });
  return out;
}

test('S115: every worked example is listed with the arms that receive it, and the modelled tasks follow from the list', () => {
  assert.ok(MODELLED.length > 0);
  for (const e of MODELLED) {
    assert.ok(e.example && e.where && Array.isArray(e.arms) && e.arms.length && Array.isArray(e.tasks), JSON.stringify(e));
    for (const t of e.tasks) assert.ok(TASKS.includes(t), `${e.example}: ${t}`);
  }
  // The manual's Order (T1), checkout (T2, T4) and OutboxIntent (T3, T6) model task families; arm 2's archive models none.
  assert.deepEqual(modelledTasks(), ['T1', 'T2', 'T3', 'T4', 'T6']);
  assert.deepEqual(MODELLED.filter((e) => e.arms.includes(2)).flatMap((e) => e.tasks), []);
  // plan-m3.md records the same list.
  const plan = readFileSync(join(M3, '..', '..', 'docs', 'plan-m3.md'), 'utf8');
  for (const e of MODELLED) assert.ok(plan.includes(e.example), `plan-m3.md does not list ${e.example}`);
});


// S117: significance is decided once, by the primary comparison over all ten tasks (S96). On the unmodelled tasks the
// check is an effect check: the arm's mean escaped defects is at least 30% below each comparator's (arms 1 and 2),
// or the win is reported as holding only with the modelled tasks. The subset's p is descriptive, never a gate.

test('S117: a win that holds on both, all tasks and the unmodelled ones, is reported as a win', () => {
  const a = analyse(records((arm) => ({ escaped: arm === 3 ? 2 : 10, tokens: 100_000 })));
  assert.equal(a.rules.verdict, 'win');
  assert.deepEqual(a.sensitivity.holds, { 3: true, 4: false });
  assert.equal(a.reported.verdict, 'win');
  assert.deepEqual(a.reported.win, { 3: 'win', 4: 'no win' });
  // The subset's p is reported as descriptive, with the note that five tasks cannot reach 0.05.
  assert.equal(a.sensitivity.descriptive, true);
  assert.match(a.sensitivity.note, /5 tasks.*0\.0625.*cannot reach 0\.05/);
});

test('S117: a win carried by the modelled tasks only is reported as a win only with the modelled tasks, never as a win', () => {
  // Arm 3 is far better on the modelled tasks and 10% better on the others: the primary comparison wins, and the
  // unmodelled tasks fall short of the 30% reduction.
  const big = new Set(modelledTasks());
  const a = analyse(records((arm, t) => ({ escaped: arm === 3 ? (big.has(t) ? 1 : 9) : 10, tokens: 100_000 })));
  assert.equal(a.rules.verdict, 'win');
  assert.deepEqual(a.sensitivity.tasks, ['T10', 'T5', 'T7', 'T8', 'T9']);
  assert.deepEqual(a.sensitivity.holds, { 3: false, 4: false });
  assert.equal(a.reported.verdict, 'win only with the modelled tasks');
  assert.deepEqual(a.reported.win, { 3: 'only with the modelled tasks', 4: 'no win' });
});

test('S117: a reduction on the unmodelled tasks just under 30% does not hold, and one of exactly 30% does', () => {
  const big = new Set(modelledTasks());
  // 71 against 100 is a 29% reduction; 70 against 100 is 30%.
  for (const [subset, holds] of [[71, false], [70, true]]) {
    const a = analyse(records((arm, t) => ({ escaped: arm === 3 ? (big.has(t) ? 1 : subset) : 100, tokens: 100_000 })));
    assert.equal(a.rules.verdict, 'win', `subset ${subset}`);
    assert.equal(a.sensitivity.holds[3], holds, `subset ${subset}`);
    assert.equal(a.reported.verdict, holds ? 'win' : 'win only with the modelled tasks', `subset ${subset}`);
  }
});

test('S115: with the five unmodelled tasks of the plan, the subset comparison cannot reject (documentation)', () => {
  // Over five tasks the smallest two-sided exact p is 2/32 = 0.0625, so the subset never reaches 0.05, even before
  // Holm: why S117 makes it an effect check.
  const a = analyse(records((arm) => ({ escaped: arm === 3 ? 2 : 10, tokens: 100_000 })));
  const c31 = a.sensitivity.comparisons.escapedDefects.find((c) => c.arms[0] === 3 && c.arms[1] === 1);
  assert.equal(c31.tasks, 5);
  assert.equal(c31.p, 2 / 32);
  assert.equal(a.sensitivity.rules.win[3].significant, false);
});

test('S115: a stop or a result between is reported unchanged', () => {
  const a = analyse(records(() => ({ escaped: 5, tokens: 100_000 })));
  assert.equal(a.rules.verdict, 'between');
  assert.equal(a.reported.verdict, 'between');
});
