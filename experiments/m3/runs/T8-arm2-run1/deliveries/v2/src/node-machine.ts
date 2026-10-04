// The stateful core of a consensus node: a pure transition function.

export type Role = 'follower' | 'candidate' | 'leader' | 'shutdown';
export type Vote = 'nobody' | 'itself' | 'n1' | 'n2';
export interface NodeState { role: Role; term: number; votedFor: Vote }

export const MAX_TERM = 3;
export const PEERS: readonly string[] = ['n1', 'n2'];
export const INITIAL_STATE: NodeState = { role: 'follower', term: 0, votedFor: 'nobody' };

export type Command =
  | { type: 'electionTimeout' }
  | { type: 'electionWon' }
  | { type: 'electionLost' }
  | { type: 'newerTermSeen'; term: number }
  | { type: 'quorumLost' }
  | { type: 'shutdown' }
  | { type: 'voteRequested'; candidate: string; term: number };

export type Step = { ok: true; state: NodeState } | { ok: false; reason: string };

const validTerm = (t: unknown): t is number =>
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
      if (s.role !== 'candidate') return { ok: false, reason: 'only a candidate can lose an election' };
      return { ok: true, state: { ...s, role: 'follower' } };
    case 'newerTermSeen': {
      const t = c.term;
      if (!validTerm(t)) return { ok: false, reason: `term must be an integer from 1 to ${MAX_TERM}` };
      if (t <= s.term) return { ok: false, reason: 'term is not newer' };
      return { ok: true, state: { role: 'follower', term: t, votedFor: 'nobody' } };
    }
    case 'quorumLost':
      if (s.role !== 'leader') return { ok: false, reason: 'only the leader can lose its quorum' };
      return { ok: true, state: { ...s, role: 'follower' } };
    case 'shutdown':
      return { ok: true, state: { ...s, role: 'shutdown' } };
    case 'voteRequested': {
      const { candidate, term: t } = c;
      if (typeof candidate !== 'string' || !PEERS.includes(candidate)) {
        return { ok: false, reason: `candidate must be one of ${PEERS.join(', ')}` };
      }
      if (!validTerm(t)) return { ok: false, reason: `term must be an integer from 1 to ${MAX_TERM}` };
      const vote = candidate as Vote;
      if (t > s.term) return { ok: true, state: { role: 'follower', term: t, votedFor: vote } };
      if (t < s.term) return { ok: false, reason: 'vote requested for an older term' };
      if (s.role !== 'follower') return { ok: false, reason: `a ${s.role} does not grant its vote in its own term` };
      if (s.votedFor === 'nobody' || s.votedFor === vote) return { ok: true, state: { ...s, votedFor: vote } };
      return { ok: false, reason: 'already voted for another candidate in this term' };
    }
    default:
      return { ok: false, reason: 'unknown command' };
  }
}
