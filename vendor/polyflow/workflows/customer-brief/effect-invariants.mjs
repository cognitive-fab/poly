// What this workflow may EMIT, on every reachable path — the admission gate.
//
// These are the sentences a user can actually approve. "Allow slack_send to
// #cs" (OpenWorker's standing-grant model) approves a verb forever. The rules
// below approve a *plan*: they say what the run can do with that verb, and the
// check enumerates every path over the contract's declared domain to prove it.
'use strict';

export const effectInvariants = [
  {
    // The double-post class, pre-deploy: no path may post twice.
    name: 'at-most-one-post-per-path',
    pred: (path) => path.count('post_brief') <= 1,
  },
  {
    // The rule the standing grant cannot express: a public post is only ever
    // emitted on a path where a human said yes first.
    name: 'no-post-without-prior-approval',
    pred: (path) => path.emitted.every((e, i) =>
      e.kind !== 'post_brief' || path.actionBefore('APPROVED', i)),
  },
  {
    // ...and the approval must have been asked for, not assumed.
    name: 'post-implies-approval-was-requested',
    pred: (path) => path.emitted.every((e) =>
      e.kind !== 'post_brief' ||
      path.emitted.some((r) => r.kind === 'request_approval' && r.step < e.step)),
  },
  {
    // Nothing is drafted from tickets that were never gathered.
    name: 'draft-implies-prior-fetch',
    pred: (path) => path.emitted.every((e) =>
      e.kind !== 'draft_brief' ||
      path.emitted.some((f) => f.kind === 'fetch_tickets' && f.step < e.step)),
  },
  {
    // Exactly one gather per started run — no re-fetch loops.
    name: 'exactly-one-fetch-when-started',
    pred: (path) => {
      const started = path.actions.some((a) => a.action === 'START');
      const n = path.count('fetch_tickets');
      return started ? n === 1 : n === 0;
    },
  },
];
