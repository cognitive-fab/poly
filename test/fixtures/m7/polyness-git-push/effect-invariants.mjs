// What this workflow may EMIT, on every reachable path — the admission gate.
//
// Every rule here was MINED, not chosen. Each carries the support that
// produced it, because a proposal is only legitimate while the standard is
// the user's own (spec §4.4.1). "You did this 12 of 14 times" is a rule.
// "This is good practice" is somebody else's opinion wearing a finding's
// clothes.
//
// Mined from project, 16 instances of
// `git push`, on 2026-10-12.
'use strict';

export const effectInvariants = [
  {
    // own evidence: 16 of 16 per run.
    // git add came first every time it mattered
    name: 'git-push-implies-a-prior-git-add',
    pred: (path) => path.emitted.every((e) => e.kind !== 'git-push' || path.emitted.some((s) => s.kind === 'git-add' && s.step < e.step)),
  },
  {
    // own evidence: 16 of 16 per run.
    // git commit came first every time it mattered
    name: 'git-push-implies-a-prior-git-commit',
    pred: (path) => path.emitted.every((e) => e.kind !== 'git-push' || path.emitted.some((s) => s.kind === 'git-commit' && s.step < e.step)),
  },
  {
    // own evidence: 15 of 15 per run.
    // git add happened once per run, never twice
    name: 'exactly-one-git-add-per-git-push-run',
    pred: (path) => !path.emitted.some((e) => e.kind === 'git-push') || path.count('git-add') === 1,
  },
  {
    // own evidence: 15 of 15 per run.
    // git commit happened once per run, never twice
    name: 'exactly-one-git-commit-per-git-push-run',
    pred: (path) => !path.emitted.some((e) => e.kind === 'git-push') || path.count('git-commit') === 1,
  },
  {
    // own evidence: 14 of 15 per run.
    // a second git push in one run is the shape of a retry that was really a duplicate
    name: 'at-most-one-git-push-per-run',
    pred: (path) => path.count('git-push') <= 1,
  },
  {
    // own evidence: 14 of 16 across the session; 14 of 16 already inside one run.
    // the rule your own majority already keeps
    name: 'no-git-push-without-a-passing-verify',
    pred: (path) => path.emitted.every((e, i) => e.kind !== 'git-push' || path.actionBefore('VERIFY_PASSED', i)),
  },
];
