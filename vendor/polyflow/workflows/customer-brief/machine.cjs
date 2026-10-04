// customer-brief — SAM v2 strict-profile module.
//
// Every not-applicable action is an observable reject(reason): a duplicate
// report from the agent, a tool result for a step that already resolved, or a
// stale completion after a restart all land as rejects, never as faults.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'customerBrief' });

const INITIAL_STATE = { briefState: 'idle', ticketCount: 0, reason: '' };

// NOTE: each action needs its OWN function — the library stamps __actionName
// onto the function object, so a shared reference would alias every intent to
// the last-declared name.
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      briefState: { type: 'string' },
      ticketCount: { type: 'number' },
      reason: { type: 'string' },
    },
    actions: {
      START: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      TICKETS_READY: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ count: 0 }, { count: 3 }] },
      TICKETS_FAILED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ reason: 'api-error' }] },
      DRAFT_READY: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      APPROVED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      DENIED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ reason: 'not-ready' }] },
      POST_DONE: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      POST_FAILED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ reason: 'channel-unavailable' }] },
    },
    acceptors: {
      START: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.briefState !== 'idle') return reject('already-started');
        next.briefState = 'gathering';
        unchanged('ticketCount', 'reason');
      },
      TICKETS_READY: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.briefState !== 'gathering') return reject('stale-completion');
        const count = Number.isInteger(proposal.count) ? proposal.count : 0;
        if (count === 0) {
          // Contract-anchored reason: the specialRule's name.
          next.briefState = 'denied';
          next.ticketCount = 0;
          next.reason = 'no-empty-brief';
          return;
        }
        next.briefState = 'drafting';
        next.ticketCount = count;
        unchanged('reason');
      },
      TICKETS_FAILED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.briefState !== 'gathering') return reject('stale-completion');
        next.briefState = 'failed';
        next.reason = String(proposal.reason || 'tickets-failed');
        unchanged('ticketCount');
      },
      DRAFT_READY: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.briefState !== 'drafting') return reject('stale-completion');
        next.briefState = 'review';
        unchanged('ticketCount', 'reason');
      },
      APPROVED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.briefState !== 'review') return reject('nothing-awaiting-approval');
        next.briefState = 'posting';
        unchanged('ticketCount', 'reason');
      },
      DENIED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.briefState !== 'review') return reject('nothing-awaiting-approval');
        next.briefState = 'denied';
        next.reason = String(proposal.reason || 'denied');
        unchanged('ticketCount');
      },
      POST_DONE: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.briefState !== 'posting') return reject('stale-completion');
        next.briefState = 'posted';
        unchanged('ticketCount', 'reason');
      },
      POST_FAILED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.briefState !== 'posting') return reject('stale-completion');
        next.briefState = 'failed';
        next.reason = String(proposal.reason || 'post-failed');
        unchanged('ticketCount');
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
  } catch { /* best-effort; strict-profile errors throw at the caller anyway */ }
  setState(INITIAL_STATE);
};

const actions = Object.fromEntries(
  Object.keys(intents).map((name) => [name, (data = {}) => intents[name](data)])
);

module.exports = { instance, init, actions, getState, setState };
