// plan-e3.md E3.7, HAC7 (light: no admission, no checker, no runtime): the scorer reads the journal rows of the Trial and names
// the failing stage from them. The rows here are built by hand in the shape JournalReader gives, with the Trial's own state in
// pre and post. The runtime half of HAC7 (a seeded fault in stage k of a real run is reported as stage k, and the scorer agrees
// with the machine's own failedAt field) is test/e3/e3-stages.test.mjs, which needs the admitted build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareStages, scoreRun } from '../../examples/harness/host/score.mjs';

/** The rows of a Trial that runs `plan` stages, `outcomes[k]` the check of stage k ('pass', 'fail' or undefined if never reached). */
function trialRows(plan, outcomes, { end = 'Done', why = 'PlanDone', noise = true } = {}) {
  const rows = [];
  let seq = 0;
  let state = { mode: 'Idle', step: 0, last: 1, failedAt: 4, capped: false, saved: false, why: 'None' };
  const push = (action, step_kind, next, extra = {}) => {
    rows.push({ seq: seq++, action, step_kind, reject_reason: step_kind === 'rejected' ? 'not-running' : null, pre: { ...state }, post: step_kind === 'accepted' ? { ...state, ...next } : { ...state }, data: {}, ...extra });
    if (step_kind === 'accepted') state = { ...state, ...next };
  };
  push('Begin', 'accepted', { mode: 'Running', last: plan - 1 });
  for (let k = 0; k < plan; k++) {
    if (outcomes[k] === undefined) break;
    push('Stored', 'accepted', { mode: 'Checking' });
    if (noise) push('Stored', 'rejected', {});
    if (outcomes[k] === 'pass') push('StagePassed', 'accepted', {});
    else push('StageFailed', 'accepted', state.failedAt === 4 ? { failedAt: k } : {});
    if (k < plan - 1) push('NextStep', 'accepted', { mode: 'Running', step: k + 1 });
  }
  if (end === 'Done') push('NextStep', 'accepted', { mode: 'Done', why });
  else if (end === 'Stopped') push('OverflowEnd', 'accepted', { mode: 'Stopped', why: 'Overflow' });
  return rows;
}

test('HF2.7: a run whose stages all pass scores each stage 1 and names no failing stage', () => {
  const r = scoreRun(trialRows(3, ['pass', 'pass', 'pass']));
  assert.deepEqual(r.stages.map((s) => [s.state, s.score]), [['passed', 1], ['passed', 1], ['passed', 1]]);
  assert.equal(r.failingStage, null);
  assert.deepEqual([r.passed, r.total], [3, 3]);
  assert.deepEqual(r.ended, { mode: 'Done', why: 'PlanDone' });
});

test('HAC7: a seeded fault in stage k is reported as stage k, for every k of plans of two to four stages', () => {
  for (let plan = 2; plan <= 4; plan++) {
    for (let k = 0; k < plan; k++) {
      const outcomes = Array.from({ length: plan }, (_, i) => (i === k ? 'fail' : 'pass'));
      const r = scoreRun(trialRows(plan, outcomes));
      assert.equal(r.failingStage, k, `plan ${plan}, fault in ${k}`);
      assert.equal(r.stages[k].state, 'failed');
      assert.equal(r.passed, plan - 1);
      // the machine's own field says the same, which the scorer did not read
      const last = trialRows(plan, outcomes).at(-1);
      assert.equal(last.post.failedAt, k);
    }
  }
});

test('Q-E3-6: the failing stage is the first failed one, and the stages after it are still scored', () => {
  const r = scoreRun(trialRows(4, ['pass', 'fail', 'pass', 'fail']));
  assert.equal(r.failingStage, 1);
  assert.deepEqual(r.stages.map((s) => s.state), ['passed', 'failed', 'passed', 'failed']);
  assert.deepEqual(r.stages.map((s) => s.score), [1, 0, 1, 0]);
});

test('HF2.7: a stage the run never reached scores 0 and is not-reached, which is not a failure', () => {
  const r = scoreRun(trialRows(4, ['pass', 'pass'], { end: 'Stopped' }));
  assert.deepEqual(r.stages.map((s) => s.state), ['passed', 'passed', 'not-reached', 'not-reached']);
  assert.equal(r.failingStage, null, 'no check failed, so no stage is named');
  assert.deepEqual([r.passed, r.total], [2, 4]);
  assert.deepEqual(r.ended, { mode: 'Stopped', why: 'Overflow' });
});

test('HF2.7: a rejected step is not a check, and a journal with two checks of one stage, or none of its trial, is refused', () => {
  const rows = trialRows(2, ['pass', 'pass']);
  const rejected = { ...rows.find((r) => r.action === 'StagePassed'), seq: 99, step_kind: 'rejected', action: 'StageFailed' };
  assert.equal(scoreRun([...rows, rejected]).failingStage, null, 'a rejected StageFailed does not fail the stage');
  const twice = [...rows, { ...rows.find((r) => r.action === 'StagePassed'), seq: 100 }];
  assert.throws(() => scoreRun(twice), /checked twice/);
  assert.throws(() => scoreRun(rows.filter((r) => r.action !== 'Begin')), /no Begin/);
});

test('HF2.7: the rows may be the stored form, with pre and post as JSON text', () => {
  const rows = trialRows(2, ['pass', 'fail']).map((r) => ({ ...r, pre: JSON.stringify(r.pre), post: JSON.stringify(r.post) }));
  assert.equal(scoreRun(rows).failingStage, 1);
});

test('HF2.8, Q-E3-6: two runs are compared stage by stage, and a regression is a stage that passed and now does not', () => {
  const before = scoreRun(trialRows(3, ['pass', 'fail', 'pass']));
  const after = scoreRun(trialRows(3, ['pass', 'pass', 'fail']));
  const c = compareStages(before, after);
  assert.deepEqual(c.regressions, [2]);
  assert.deepEqual(c.gains, [1]);
  assert.deepEqual([c.failingBefore, c.failingAfter], [1, 2]);
  // a change that improves one stage and regresses another is visible as both
  assert.ok(c.regressions.length === 1 && c.gains.length === 1);
  assert.throws(() => compareStages(before, scoreRun(trialRows(2, ['pass', 'pass']))), /different plans/);
  // identical runs: nothing moved
  assert.deepEqual(compareStages(before, before).regressions, []);
});
