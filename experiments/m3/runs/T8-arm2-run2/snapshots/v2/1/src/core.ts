// The stateful core: a pure transition function over a node's { role, term, votedFor }.

export type Role = 'follower' | 'candidate' | 'leader' | 'shutdown';
export type Vote = 'nobody' | 'itself' | 'n1' | 'n2';

export interface NodeState {
  role: Role;
  term: number;
  votedFor: Vote;
}

export type Command =
  | { type: 'electionTimeout' }
  | { type: 'electionWon' }
  | { type: 'newerTermSeen'; term: number }
  | { type: 'quorumLost' }
  | { type: 'shutdown' }
  | { type: 'voteRequested'; candidate: string; term: number };

export type Step = { ok: true; state: NodeState } | { ok: false; reason: string };

export const MIN_TERM = 0;
export const MAX_TERM = 3;
export const PEERS: readonly string[] = ['n1', 'n2'];

export const initialState: NodeState = { role: 'follower', term: MIN_TERM, votedFor: 'nobody' };

const validTerm = (t: unknown): t is number =>
  typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= MAX_TERM;

export function step(state: NodeState, cmd: Command): Step {
  if (state.role === 'shutdown') return { ok: false, reason: 'node is shut down' };
  switch (cmd.type) {
    case 'electionTimeout':
      if (state.role === 'leader') return { ok: false, reason: 'the leader does not time out' };
      if (state.term >= MAX_TERM) return { ok: false, reason: `no term after ${MAX_TERM}` };
      return { ok: true, state: { role: 'candidate', term: state.term + 1, votedFor: 'itself' } };
    case 'electionWon':
      if (state.role !== 'candidate') return { ok: false, reason: 'only a candidate can win an election' };
      return { ok: true, state: { ...state, role: 'leader' } };
    case 'electionLost':
      if (state.role !== 'candidate') return { ok: false, reason: 'only a candidate can lose an election' };
      return { ok: true, state: { ...state, role: 'follower' } };
    case 'newerTermSeen': {
      const t = cmd.term;
      if (!validTerm(t)) return { ok: false, reason: `term must be an integer from 1 to ${MAX_TERM}` };
      if (t <= state.term) return { ok: false, reason: 'term is not newer' };
      return { ok: true, state: { role: 'follower', term: t, votedFor: 'nobody' } };
    }
    case 'quorumLost':
      if (state.role !== 'leader') return { ok: false, reason: 'only the leader can lose quorum' };
      return { ok: true, state: { ...state, role: 'follower' } };
    case 'shutdown':
      return { ok: true, state: { ...state, role: 'shutdown' } };
    case 'voteRequested': {
      const { candidate, term: t } = cmd;
      if (typeof candidate !== 'string' || !PEERS.includes(candidate)) return { ok: false, reason: 'unknown candidate' };
      if (!validTerm(t)) return { ok: false, reason: `term must be an integer from 1 to ${MAX_TERM}` };
      const vote = candidate as Vote;
      if (t > state.term) return { ok: true, state: { role: 'follower', term: t, votedFor: vote } };
      if (t < state.term) return { ok: false, reason: 'vote request from an older term' };
      if (state.role !== 'follower') return { ok: false, reason: 'only a follower grants its vote in its own term' };
      if (state.votedFor !== 'nobody' && state.votedFor !== vote) return { ok: false, reason: 'already voted in this term' };
      return { ok: true, state: { ...state, votedFor: vote } };
    }
    default:
      return { ok: false, reason: 'unknown command' };
  }
}
