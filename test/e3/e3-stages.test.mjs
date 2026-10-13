// plan-e3.md E3.7, HAC7 (the runtime half): in a real run through the admitted harness, a stage check that fails at stage k is
// reported as a failure of stage k by the scorer, which reads the journal rows of the Trial and nothing else; the Trial's own
// field failedAt agrees; a stage the run never reached is not-reached; and two runs of one task are compared stage by stage.
// Written with the light work of E3.7 and not yet run: it needs the admitted build, so it waits for the go (decisions-e3.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, recording } from './e3-loop-helpers.mjs';
import { ALL_OFF } from '../../examples/harness/host/loop.mjs';
import { step } from '../fixtures/harness/trajectories.mjs';
import { compareStages, scoreRun } from '../../examples/harness/host/score.mjs';

const plan = (n, failAt) => {
  const rec = recording({ steps: Array.from({ length: n }, (_, i) => step.fuse(i + 1)).map(({ spec, receipt, ...s }) => s) });
  rec.steps.forEach((s, i) => { s.stage = { passed: i !== failAt }; });
  rec.receipts = [];
  return rec;
};
const journalOf = async (rt, result) => rt.getJournal(result.ids.trial);

test('HAC7: a seeded fault in stage k of a real run is reported as stage k, whatever the length of the plan (2 to 4)', { timeout: 1_800_000 }, async () => {
  for (let n = 2; n <= 4; n++) {
    for (let k = 0; k < n; k++) {
      const { rt, result } = await run(`e3-stages-${n}-${k}`, plan(n, k), { mechanisms: ALL_OFF });
      try {
        const s = scoreRun(await journalOf(rt, result));
        assert.equal(s.failingStage, k, `plan ${n}, fault in ${k}`);
        assert.equal(s.stages[k].state, 'failed');
        assert.equal(s.passed, n - 1);
        assert.equal(result.trial.failedAt, k, 'the machine\'s own field says the same, and the scorer did not read it');
        assert.deepEqual(s.ended, { mode: 'Done', why: 'PlanDone' });
      } finally {
        await rt.close();
      }
    }
  }
});

test('HAC7: a run with no fault scores every stage 1, and a run that ends early leaves the later stages not-reached', { timeout: 1_800_000 }, async () => {
  const clean = await run('e3-stages-clean', plan(3, -1), { mechanisms: ALL_OFF });
  try {
    const s = scoreRun(await journalOf(clean.rt, clean.result));
    assert.deepEqual(s.stages.map((x) => x.score), [1, 1, 1]);
    assert.equal(s.failingStage, null);
    assert.equal(clean.result.trial.failedAt, 4, 'the machine\'s none');
  } finally {
    await clean.rt.close();
  }
  const capped = plan(3, -1);
  capped.steps[1].cap = true;
  const stopped = await run('e3-stages-capped', capped, { mechanisms: ALL_OFF });
  try {
    const s = scoreRun(await journalOf(stopped.rt, stopped.result));
    assert.equal(s.stages[0].state, 'passed');
    assert.equal(s.stages[2].state, 'not-reached');
    assert.equal(s.failingStage, null);
    assert.deepEqual(s.ended, { mode: 'Stopped', why: 'Cap' });
  } finally {
    await stopped.rt.close();
  }
});

test('HF2.8: two real runs of one plan, one with a fault in stage 2, compare stage by stage', { timeout: 1_800_000 }, async () => {
  const a = await run('e3-stages-cmp-a', plan(3, 1), { mechanisms: ALL_OFF });
  const b = await run('e3-stages-cmp-b', plan(3, 2), { mechanisms: ALL_OFF });
  try {
    const c = compareStages(scoreRun(await journalOf(a.rt, a.result)), scoreRun(await journalOf(b.rt, b.result)));
    assert.deepEqual([c.regressions, c.gains, c.failingBefore, c.failingAfter], [[2], [1], 1, 2]);
  } finally {
    await a.rt.close();
    await b.rt.close();
  }
});
