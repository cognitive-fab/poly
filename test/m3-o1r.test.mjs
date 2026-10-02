// M3-10: O1-R, the out-of-range refusals the amended briefs state, generated mechanically from the M3-8 list and
// run through the host interface, the same in every arm. It passes on every reference, catches a reference that
// takes an out-of-range value, and is scored and reported as a secondary measure beside O1, never added into the
// primary count of escaped defects (S96).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { M3, POLYRUN, mapOf, moduleOf, taskIds, versions } from '../experiments/m3/lib/task.mjs';
import { generate } from '../experiments/m3/adapter/generate.mjs';
import { RANGES, rangesOf } from '../experiments/m3/o1r/ranges.mjs';
import { runO1R } from '../experiments/m3/runner/score.mjs';
import { analyse, runMeasures } from '../experiments/m3/analysis/analyse.mjs';

/** The generated adapter of a version's reference or mutant, built from `moduleFile`, as an implementation path. */
function impl(v, which, moduleFile = moduleOf(join(v.dir, which)), tag = which) {
  const out = join(tmpdir(), 'poly-m3-o1r-test', `${v.task}-v${v.n}-${tag}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const r = generate({ mapFile: mapOf(v, which), hostFile: v.hostFile, moduleFile, out, polyrun: POLYRUN });
  if (r.errors) throw new Error(r.errors.join('\n'));
  return join(out, 'host.gen.ts');
}

test('M3-10: O1-R holds every entry of the M3-8 list, and none for a version no entry applies to', () => {
  assert.equal(new Set(RANGES.map((r) => `${r.task} ${r.method}`)).size, RANGES.length);
  assert.deepEqual(rangesOf('T1', 0), []);
  assert.deepEqual(rangesOf('T6', 2).map((r) => r.method), ['submit']);
  assert.deepEqual(rangesOf('T3', 0).map((r) => r.method), ['authorize', 'capture', 'refund']);
  assert.deepEqual(rangesOf('T8', 0).map((r) => r.method), ['newerTermSeen']);
});

test('M3-10: O1-R passes on the reference of every version, and runs no test where no entry applies', () => {
  for (const id of taskIds()) {
    for (const v of versions(id)) {
      const r = runO1R(id, v.n, impl(v, 'reference'), 10 * 60 * 1000);
      assert.equal(r.ran, true, `${id} v${v.n}: ${r.reason}`);
      assert.equal(r.failed, 0, `${id} v${v.n}: ${r.failing?.join('; ')}`);
      assert.equal(r.skipped, 0, `${id} v${v.n}`);
      assert.equal(r.tests, rangesOf(id, v.n).reduce((n, e) => n + e.outside.length, 0), `${id} v${v.n}`);
    }
  }
});

test('M3-10: O1-R fails on a reference that takes an out-of-range value', () => {
  // T6 v0 with maxTries back to a disclosed range type: submit(j, 4) is accepted.
  const v = versions('T6')[0];
  const dir = join(tmpdir(), 'poly-m3-o1r-test', 'T6-v0-disclosed-source');
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(v.dir, 'reference'), dir, { recursive: true });
  const file = moduleOf(dir);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes('maxTries: int check { 1, 2, 3 } strict'));
  writeFileSync(file, text.replace('maxTries: int check { 1, 2, 3 } strict', 'maxTries: 1..3'));
  const r = runO1R('T6', 0, impl(v, 'reference', file, 'disclosed'), 10 * 60 * 1000);
  assert.equal(r.ran, true);
  assert.equal(r.failed, 3);
  assert.deepEqual(r.failing, ['submit(-1) is refused and changes nothing', 'submit(0) is refused and changes nothing', 'submit(4) is refused and changes nothing']);
});

const TASKS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10'];
function run(arm, task, i, { escaped, o1r }) {
  return {
    id: `${task}-arm${arm}-run${i}`, arm, task, run: i, spent: { tokens: 100_000, wallMs: 1000 },
    scores: [escaped, 0, 0, 0].map((f, n) => ({ n, delivered: true, withinBudget: true, admitted: arm >= 3 ? true : null, o1: { ran: true, tests: 20, failed: f }, ...(o1r === undefined ? {} : { o1r: { ran: true, tests: 3, failed: n === 0 ? o1r : 0 } }), o2: { violated: [] }, o3: { traces: 10, failed: 0 } })),
  };
}
const records = (f) => [1, 2, 3, 4].flatMap((arm) => TASKS.flatMap((t, k) => [1, 2, 3, 4, 5].map((i) => run(arm, t, i, f(arm, k)))));

test('M3-10: the analysis reports O1-R as a secondary measure and never adds it into the escaped defects of S96', () => {
  const r = run(3, 'T6', 1, { escaped: 2, o1r: 3 });
  assert.equal(runMeasures(r).escaped, 2);
  assert.equal(runMeasures(r).o1r, 3);
  assert.equal(runMeasures(run(3, 'T6', 1, { escaped: 2 })).o1r, null);
  // Arm 1 fails every O1-R test it could; the primary analysis is the same as with no O1-R at all.
  const withR = analyse(records((arm) => ({ escaped: arm === 3 ? 2 : 10, o1r: arm === 1 ? 3 : 0 })));
  const without = analyse(records((arm) => ({ escaped: arm === 3 ? 2 : 10 })));
  assert.deepEqual(withR.comparisons, without.comparisons);
  assert.deepEqual(withR.rules, without.rules);
  assert.deepEqual(withR.reported, without.reported);
  assert.equal(withR.table[1].T1.escapedPerDelivered, 10);
  assert.equal(withR.table[1].T1.o1rPerDelivered, 3);
  const c31 = withR.secondary.o1r.find((c) => c.arms[0] === 3 && c.arms[1] === 1);
  assert.deepEqual([c31.meanA, c31.meanB, c31.tasks], [0, 3, 10]);
  assert.equal(without.secondary.o1r.find((c) => c.arms[0] === 3 && c.arms[1] === 1).tasks, 0);
});
