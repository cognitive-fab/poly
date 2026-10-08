// SR-AC3: the SR3 analysis's test, written before the runs. The one-sided Fisher exact test gives the values the
// pre-registration states (zero of 20 against 5 of 20 is p = 0.024; one of 20 is p = 0.09), and on M3's own records
// of the 20 cells the primary measure counts the five runs SR3 compares with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { analyseSr3, CELLS, fisherLess } from '../experiments/sr/sr3-analysis.mjs';

test('SR-AC3: the one-sided Fisher test gives the pre-registered p values', () => {
  assert.equal(fisherLess(0, 20, 5, 20).toFixed(3), '0.024');
  assert.equal(fisherLess(1, 20, 5, 20).toFixed(2), '0.09');
  assert.equal(fisherLess(5, 20, 5, 20) > 0.5, true);
  assert.equal(CELLS.length, 20);
});

test('SR-AC3: on M3\'s records of the 20 cells, five runs have an escaped O1 defect, as the comparison says', () => {
  const m3 = join(ROOT, 'experiments', 'm3', 'runs');
  const a = analyseSr3(m3, m3);
  assert.deepEqual(a.m3.withDefects.sort(), ['T3-arm3-run2', 'T3-arm3-run4', 'T3-arm4-run2', 'T3-arm4-run5', 'T7-arm4-run1']);
  assert.equal(a.m3.runs, 20);
});
