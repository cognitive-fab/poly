// Invariants for DeriveWorkflowRunStatus (see ../contract.json). Encode
// what the aggregate status SHOULD guarantee to a caller, not a
// transcription of the code's branch order.
export const stateInvariants = [
  {
    name: 'derived-is-a-known-status',
    // EVICTED belongs here too: when every task is uniformly EVICTED, the
    // real code's len(uniqueStatuses)==1 pass-through legitimately returns
    // EVICTED as the raw derived status -- ToProto() launders it to RUNNING
    // for the one current external caller, but the raw V1RunStatus value
    // really can be EVICTED. My first version of this invariant omitted it
    // and the checker correctly flagged that as a false violation.
    pred: (state) => ['QUEUED', 'RUNNING', 'EVICTED', 'FAILED', 'CANCELLED', 'COMPLETED'].includes(state.derived),
  },
  {
    name: 'completed-only-when-every-task-completed',
    // The workflow run must never report COMPLETED unless ALL of its tasks
    // actually completed -- the single most important guarantee a caller
    // relies on this function for.
    pred: (state) => state.derived !== 'COMPLETED' || state.taskStatuses.every((s) => s === 'COMPLETED'),
  },
  {
    name: 'failed-reported-whenever-any-task-failed',
    // The converse guarantee: FAILED dominates unconditionally (checked
    // before the in-flight/CANCELLED branches in the real code) -- if any
    // task actually failed, the workflow must report FAILED, full stop,
    // even while other tasks are still RUNNING.
    pred: (state) => !state.taskStatuses.includes('FAILED') || state.derived === 'FAILED',
  },
];

export const transitionInvariants = [
  {
    name: 'a-terminal-workflow-status-implies-no-inflight-tasks',
    // If the workflow is reported CANCELLED or COMPLETED, no task may still
    // be QUEUED, RUNNING, or EVICTED -- a "done" verdict must mean done.
    pred: (pre, action, data, post) => {
      if (post.derived !== 'CANCELLED' && post.derived !== 'COMPLETED') return true;
      return !post.taskStatuses.some((s) => s === 'QUEUED' || s === 'RUNNING' || s === 'EVICTED');
    },
  },
];
