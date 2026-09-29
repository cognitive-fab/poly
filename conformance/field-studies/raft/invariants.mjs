// Invariants for the hashicorp/raft role-transition machine (see
// ../contract.json). These encode intent -- what the Raft algorithm's safety
// properties require -- not a transcription of what the code happens to do.
export const stateInvariants = [
  {
    name: 'role-is-valid',
    pred: (state) => ['Follower', 'Candidate', 'Leader', 'Shutdown'].includes(state.role),
  },
  {
    name: 'term-is-non-negative',
    pred: (state) => Number.isInteger(state.term) && state.term >= 0,
  },
];

export const transitionInvariants = [
  {
    name: 'term-never-decreases',
    pred: (pre, action, data, post) => post.term >= pre.term,
  },
  {
    name: 'shutdown-is-a-true-terminal-state',
    pred: (pre, action, data, post) => pre.role !== 'Shutdown' || post.role === 'Shutdown',
  },
  {
    name: 'only-newer-term-seen-can-change-term',
    // Raft's term only advances on: starting a new election (self bump) or
    // observing a strictly newer term from a peer. No other event may move it.
    pred: (pre, action, data, post) =>
      post.term === pre.term || action === 'ElectionTimeout' || action === 'NewerTermSeen',
  },
  {
    name: 'election-won-cannot-skip-candidate',
    // A node can only ARRIVE at Leader by having been Candidate immediately
    // before -- but a no-op (identity) step that merely stays Leader must
    // not trip this: gate on the role actually changing.
    pred: (pre, action, data, post) => post.role !== 'Leader' || pre.role === post.role || pre.role === 'Candidate',
  },
];
