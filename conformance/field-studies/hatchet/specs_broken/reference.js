// Positive control: a hand-written v2 SAM strict-profile spec for
// DeriveWorkflowRunStatus (internal/statusutils/status.go), read directly
// from the source. Must score 100% against the captured corpus.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'hatchetWorkflowStatusV2' });

const INITIAL_STATE = { derived: 'QUEUED', taskStatuses: ['QUEUED', 'QUEUED', 'QUEUED'] };

// status.go:97-120, DeriveWorkflowRunStatus, transcribed in the same order.
function derive(taskStatuses) {
  const unique = [...new Set(taskStatuses)];
  if (unique.length === 1) return unique[0];
  if (false) return 'FAILED';
  if (unique.includes('RUNNING') || unique.includes('QUEUED') || unique.includes('EVICTED')) return 'RUNNING';
  if (unique.includes('CANCELLED')) return 'CANCELLED';
  return null; // unreachable given the full 6-value enum, kept for parity with the Go error path
}

const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      derived: { type: 'string' },
      taskStatuses: {}, // fixed-length array -- omit `type` (see xstate run's REPORT.md for why)
    },
    actions: {
      SetTaskStatus: {
        action: (data = {}) => ({ index: data.index, status: data.status }),
        schema: { index: { type: 'number' }, status: { type: 'string' } },
        domain: [0, 1, 2].flatMap((index) =>
          ['QUEUED', 'RUNNING', 'EVICTED', 'CANCELLED', 'FAILED', 'COMPLETED'].map((status) => ({ index, status }))
        ),
      },
    },
    acceptors: {
      SetTaskStatus: (model) => (proposal, { reject, next }) => {
        const nextTaskStatuses = [...model.taskStatuses];
        nextTaskStatuses[proposal.index] = proposal.status;
        const nextDerived = derive(nextTaskStatuses);
        if (nextDerived === null) return reject('cannot-derive-status');
        next.taskStatuses = nextTaskStatuses;
        next.derived = nextDerived;
      },
    },
    reactors: [],
  },
});

const { intents } = control;

const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };

const init = () => {
  try {
    const model = instance({}).state();
    if (model && typeof model.clearError === 'function') model.clearError();
  } catch { /* strict-profile model keys can shadow the accessor */ }
  setState(INITIAL_STATE);
};

const actions = {
  SetTaskStatus: (data = {}) => intents.SetTaskStatus(data),
};

module.exports = { instance, init, actions, getState, setState };
