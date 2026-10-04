// The stateful core: a pure transition function over a node's role, term, vote and pause.
import type { NodeView } from '../host.ts';

export const MAX_TERM = 3;
export const PEERS = ['n1', 'n2'] as const;

export type Command =
  | { type: 'electionTimeout' }
  | { type: 'electionWon' }
  | { type: 'electionLost' }
  | { type: 'newerTermSeen'; term: number }
  | { type: 'quorumLost' }
  | { type: 'shutdown' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'voteRequested'; candidate: string; term: number };

export type Step = { ok: true; next: NodeView } | { ok: false; reason: string };

export const initialNode = (): NodeView => ({ role: 'follower', term: 0, votedFor: 'nobody', paused: false });

const validTerm = (t: unknown): t is number =>
  typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= MAX_TERM;

export function step(s: NodeView, c: Command): Step {
  if (s.role === 'shutdown') return { ok: false, reason: 'node is shut down' };
  switch (c.type) {
    case 'electionTimeout':
      if (s.role === 'leader') return { ok: false, reason: 'the leader does not time out' };
      if (s.paused) return { ok: false, reason: 'a paused node starts no election' };
      if (s.term >= MAX_TERM) return { ok: false, reason: `no term after ${MAX_TERM}` };
      return { ok: true, next: { ...s, role: 'candidate', term: s.term + 1, votedFor: 'itself' } };
    case 'electionWon':
      if (s.role !== 'candidate') return { ok: false, reason: 'only a candidate can win an election' };
      return { ok: true, next: { ...s, role: 'leader' } };
    case 'electionLost':
      if (s.role !== 'candidate') return { ok: false, reason: 'only a candidate can lose an election' };
      return { ok: true, next: { ...s, role: 'follower' } };
    case 'newerTermSeen': {
      const t = c.term;
      if (!validTerm(t)) return { ok: false, reason: `term must be an integer from 1 to ${MAX_TERM}` };
      if (t <= s.term) return { ok: false, reason: 'term is not newer' };
      return { ok: true, next: { ...s, role: 'follower', term: t, votedFor: 'nobody' } };
    }
    case 'quorumLost':
      if (s.role !== 'leader') return { ok: false, reason: 'only the leader can lose its quorum' };
      return { ok: true, next: { ...s, role: 'follower' } };
    case 'shutdown':
      return { ok: true, next: { ...s, role: 'shutdown' } };
    case 'pause':
      if (s.role !== 'follower') return { ok: false, reason: 'only a follower can be paused' };
      if (s.paused) return { ok: false, reason: 'already paused' };
      return { ok: true, next: { ...s, paused: true } };
    case 'resume':
      if (!s.paused) return { ok: false, reason: 'not paused' };
      return { ok: true, next: { ...s, paused: false } };
    case 'voteRequested': {
      const { candidate, term: t } = c;
      if (candidate !== 'n1' && candidate !== 'n2') return { ok: false, reason: 'candidate must be n1 or n2' };
      if (!validTerm(t)) return { ok: false, reason: `term must be an integer from 1 to ${MAX_TERM}` };
      if (t > s.term) return { ok: true, next: { ...s, role: 'follower', term: t, votedFor: candidate } };
      if (t < s.term) return { ok: false, reason: 'vote requested for an older term' };
      if (s.votedFor === candidate) return { ok: true, next: s };
      if (s.role !== 'follower') return { ok: false, reason: `a ${s.role} does not grant its vote` };
      if (s.votedFor !== 'nobody') return { ok: false, reason: 'already voted in this term' };
      return { ok: true, next: { ...s, votedFor: candidate } };
    }
    default:
      return { ok: false, reason: 'unknown command' };
  }
}
