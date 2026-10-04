// The stateful core: a pure transition function over a node's role, term and vote.

export type Role = 'follower' | 'candidate' | 'leader' | 'shutdown';
export type Peer = 'n1' | 'n2';
export type Vote = 'nobody' | 'itself' | Peer;

export interface NodeState {
  role: Role;
  term: number;
  /** The node's vote in its current term. */
  votedFor: Vote;
}

export const MIN_TERM = 0;
export const MAX_TERM = 3;
export const PEERS: readonly string[] = ['n1', 'n2'];

export const initialState = (): NodeState => ({ role: 'follower', term: MIN_TERM, votedFor: 'nobody' });

export type Command =
  | { type: 'electionTimeout' }
  | { type: 'electionWon' }
  | { type: 'newerTermSeen'; term: number }
  | { type: 'quorumLost' }
  | { type: 'shutdown' }
  | { type: 'voteRequested'; candidate: string; term: number };

export type Step = { ok: true; state: NodeState } | { ok: false; reason: string };

const isTerm = (t: unknown): t is number =>
  typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= MAX_TERM;

export function step(s: NodeState, c: Command): Step {
  if (s.role === 'shutdown') return { ok: false, reason: 'node is shut down' };
  switch (c.type) {
    case 'electionTimeout':
      if (s.role === 'leader') return { ok: false, reason: 'the leader does not time out' };
      if (s.term >= MAX_TERM) return { ok: false, reason: `no term after ${MAX_TERM}` };
      return { ok: true, state: { role: 'candidate', term: s.term + 1, votedFor: 'itself' } };
    case 'electionWon':
      if (s.role !== 'candidate') return { ok: false, reason: 'only a candidate can win an election' };
      return { ok: true, state: { ...s, role: 'leader' } };
    case 'electionLost':
      // Keeps its vote for itself, so it grants no other vote in this term.
      if (s.role !== 'candidate') return { ok: false, reason: 'only a candidate can lose an election' };
      return { ok: true, state: { ...s, role: 'follower' } };
    case 'newerTermSeen': {
      if (!isTerm(c.term)) return { ok: false, reason: `term must be an integer from 1 to ${MAX_TERM}` };
      if (c.term <= s.term) return { ok: false, reason: 'term is not newer' };
      return { ok: true, state: { role: 'follower', term: c.term, votedFor: 'nobody' } };
    }
    case 'quorumLost':
      if (s.role !== 'leader') return { ok: false, reason: 'only the leader can lose its quorum' };
      return { ok: true, state: { ...s, role: 'follower' } };
    case 'shutdown':
      return { ok: true, state: { ...s, role: 'shutdown' } };
    case 'voteRequested': {
      const { candidate, term } = c;
      if (typeof candidate !== 'string' || !PEERS.includes(candidate)) {
        return { ok: false, reason: 'candidate must be n1 or n2' };
      }
      if (!isTerm(term)) return { ok: false, reason: `term must be an integer from 1 to ${MAX_TERM}` };
      const peer = candidate as Peer;
      if (term > s.term) return { ok: true, state: { role: 'follower', term, votedFor: peer } };
      if (term < s.term) return { ok: false, reason: 'term is older than the node\'s term' };
      if (s.role !== 'follower') return { ok: false, reason: 'only a follower grants a vote in its own term' };
      if (s.votedFor !== 'nobody' && s.votedFor !== peer) return { ok: false, reason: 'already voted in this term' };
      return { ok: true, state: { ...s, votedFor: peer } };
    }
    default:
      return { ok: false, reason: 'unknown command' };
  }
}
