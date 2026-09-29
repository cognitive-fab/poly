// Positive control: a hand-written v2 SAM strict-profile spec for the
// hashicorp/raft role-transition machine, written by reading raft.go
// directly (not derived by a model). Must score 100% against the captured
// corpus. See ../contract.json and ../REPORT.md for the call-site mapping.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'raftRoleV2' });

const INITIAL_STATE = { role: 'Follower', term: 0 };

const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      role: { type: 'string' },
      term: { type: 'number' },
    },
    actions: {
      ElectionTimeout: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      ElectionWon: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      NewerTermSeen: {
        action: (data = {}) => ({ term: data.term }),
        schema: { term: { type: 'number' } },
        domain: [{ term: 1 }, { term: 2 }, { term: 3 }, { term: 5 }, { term: 8 }],
      },
      QuorumLost: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      ShutdownRequested: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
    },
    acceptors: {
      // raft.go ~245: heartbeat/election timer fires in runFollower ->
      // setState(Candidate), term += 1. Only reachable from Follower.
      ElectionTimeout: (model) => (proposal, { reject, next }) => {
        if (model.role !== 'Follower') return reject('election-timeout-only-from-follower');
        next.role = 'Candidate';
        next.term = model.term + 1;
      },
      // raft.go ~383: runCandidate, grantedVotes >= quorum -> setState(Leader).
      // Term does not change at the moment of winning.
      ElectionWon: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.role !== 'Candidate') return reject('election-won-only-from-candidate');
        next.role = 'Leader';
        unchanged('term');
      },
      // raft.go ~690/845/857/1078/1275: leader loses its ability to reach a
      // quorum (lease timeout, stepDown signal, removed self, lost verify,
      // local log-write failure) -> setState(Follower), term unchanged.
      QuorumLost: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.role !== 'Leader') return reject('quorum-lost-only-from-leader');
        next.role = 'Follower';
        unchanged('term');
      },
      // raft.go ~334/369/1482/1690/1868: any role sees an RPC or vote/pre-vote
      // response carrying a term strictly greater than the current one ->
      // setState(Follower), term updated. A non-greater term is stale and
      // must be ignored (raft.go guards every one of these sites with
      // `> r.getCurrentTerm()`, never `>=`).
      NewerTermSeen: (model) => (proposal, { reject, next }) => {
        if (model.role === 'Shutdown') return reject('shutdown-is-terminal');
        if (!(proposal.term > model.term)) return reject('stale-term-ignored');
        next.role = 'Follower';
        next.term = model.term;
      },
      // api.go Shutdown(): setState(Shutdown), term unchanged. Idempotent —
      // a second Shutdown while already Shutdown is a guarded no-op in the
      // real code (the `if !r.shutdown` check), never re-observed.
      ShutdownRequested: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.role === 'Shutdown') return reject('already-shutdown');
        next.role = 'Shutdown';
        unchanged('term');
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
  } catch { /* model key 'role'/'term' may shadow the accessor, as in the turnstile-v2 example */ }
  setState(INITIAL_STATE);
};

const actions = {
  ElectionTimeout: (data = {}) => intents.ElectionTimeout(data),
  ElectionWon: (data = {}) => intents.ElectionWon(data),
  NewerTermSeen: (data = {}) => intents.NewerTermSeen(data),
  QuorumLost: (data = {}) => intents.QuorumLost(data),
  ShutdownRequested: (data = {}) => intents.ShutdownRequested(data),
};

module.exports = { instance, init, actions, getState, setState };
