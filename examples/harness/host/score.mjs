// plan-e3.md E3.7, HF2.7 and HAC7: the score of a run, per stage, read from the journal, and the failing stage named from it.
//
// A stage is a plan step of the trial. Its check is the effect `tool.stage-check`, whose completion is the action StagePassed
// or StageFailed on the Trial instance, so the check is journaled in the state it ran in: the row's `pre.step` is the stage.
// The score is computed from those rows alone, never from a field of the final state and never by a model. (The Trial machine
// keeps a field, failedAt, for the same fact; the scorer does not read it, and the tests check the two agree.)
//
// A stage has one check, the conjunction of the commands its task lists, so a stage scores 1 (passed) or 0 (failed); a stage
// the run never reached scores 0 and is marked `not-reached`, which is not the same as failed. The failing stage of a run is
// the first stage whose check failed (Q-E3-6, owner 2026-10-11); the stages after it are still scored, so a regression is
// reported per stage when two runs are compared.
//
// A stage is up to N turns (HF2.9, amendment A1, HAC9). The check's row holds the Trial's state as the stage ended, so the scorer
// also reports, from the same row and no other source, how many turns the stage took (`turns`) and what ended it (`endedBy`: Done,
// Bound or Budget). Both are null for a stage never reached.
//
// Input: the journal rows of the Trial instance, oldest first, as `JournalReader.journal(instance)` gives them:
//   { seq, action, step_kind, reject_reason, pre, post, data }, with pre and post the Trial's state.

const CHECKS = new Set(['StagePassed', 'StageFailed']);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/**
 * @param {{ seq: number, action: string, step_kind: string, pre: object|string, post: object|string }[]} rows
 * @returns {{ stages: { stage: number, state: 'passed'|'failed'|'not-reached', score: 0|1, seq: number|null }[],
 *   failingStage: number|null, passed: number, total: number, ended: { mode: string, why: string } | null }}
 */
export function scoreRun(rows) {
  const accepted = rows.filter((r) => r.step_kind === 'accepted').map((r) => ({ ...r, pre: parse(r.pre), post: parse(r.post) }));
  const begin = accepted.find((r) => r.action === 'Begin');
  if (!begin) throw new Error('the journal holds no Begin of the trial, so the plan\'s length is not known');
  const total = begin.post.last + 1;
  const stages = Array.from({ length: total }, (_, stage) => ({ stage, state: 'not-reached', score: 0, seq: null, turns: null, endedBy: null }));
  for (const r of accepted) {
    if (!CHECKS.has(r.action)) continue;
    const s = stages[r.pre.step];
    if (!s) throw new Error(`a check at stage ${r.pre.step} of a plan of ${total}`);
    if (s.state !== 'not-reached') throw new Error(`stage ${r.pre.step} was checked twice (seq ${s.seq} and ${r.seq})`);
    Object.assign(s, { state: r.action === 'StagePassed' ? 'passed' : 'failed', score: r.action === 'StagePassed' ? 1 : 0, seq: r.seq, turns: r.pre.turns ?? null, endedBy: r.pre.ended ?? null });
  }
  const failing = stages.find((s) => s.state === 'failed');
  const last = accepted[accepted.length - 1];
  return {
    stages,
    failingStage: failing ? failing.stage : null,
    passed: stages.filter((s) => s.state === 'passed').length,
    total,
    ended: last && ['Done', 'Stopped'].includes(last.post.mode) ? { mode: last.post.mode, why: last.post.why } : null,
  };
}

/**
 * Two runs of the same task compared stage by stage (HF2.8, Q-E3-6): a stage that passed in the first and did not pass in the
 * second is a regression; one that did not pass and now does is a gain. The failing stage is reported for each run.
 */
export function compareStages(a, b) {
  if (a.total !== b.total) throw new Error(`two runs of different plans (${a.total} and ${b.total} stages)`);
  const stages = a.stages.map((s, i) => {
    const t = b.stages[i];
    const delta = t.score - s.score;
    return { stage: i, before: s.state, after: t.state, delta, regression: delta < 0, gain: delta > 0 };
  });
  return { stages, regressions: stages.filter((s) => s.regression).map((s) => s.stage), gains: stages.filter((s) => s.gain).map((s) => s.stage), failingBefore: a.failingStage, failingAfter: b.failingStage };
}
