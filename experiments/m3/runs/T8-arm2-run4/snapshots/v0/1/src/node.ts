// The stateful core: a pure transition function over a node's role and term.
import type { NodeView } from '../host.ts';

export const MAX_TERM = 3;

export type Command =
  | { type: 'electionTimeout' }
  | { type: 'electionWon' }
  | { type: 'newerTermSeen'; term: number }
  | { type: 'quorumLost' }
  | { type: 'shutdown' };

export type Step = { ok: true; next: NodeView } | { ok: false; reason: string };

export const initialNode = (): NodeView => ({ role: 'follower', term: 0 });

export function step(s: NodeView, c: Command): Step {
  if (s.role === 'shutdown') return { ok: false, reason: 'node is shut down' };
  switch (c.type) {
    case 'electionTimeout':
      if (s.role === 'leader') return { ok: false, reason: 'the leader does not time out' };
      if (s.term >= MAX_TERM) return { ok: false, reason: `no term after ${MAX_TERM}` };
      return { ok: true, next: { role: 'candidate', term: s.term + 1 } };
    case 'electionWon':
      if (s.role !== 'candidate') return { ok: false, reason: 'only a candidate can win an election' };
      return { ok: true, next: { role: 'leader', term: s.term } };
    case 'newerTermSeen': {
      const t = c.term;
      if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > MAX_TERM)
        return { ok: false, reason: `term must be an integer from 1 to ${MAX_TERM}` };
      if (t <= s.term) return { ok: false, reason: 'term is not newer' };
      return { ok: true, next: { role: 'follower', term: t } };
    }
    case 'quorumLost':
      if (s.role !== 'leader') return { ok: false, reason: 'only the leader can lose its quorum' };
      return { ok: true, next: { role: 'follower', term: s.term } };
    case 'shutdown':
      return { ok: true, next: { role: 'shutdown', term: s.term } };
    default:
      return { ok: false, reason: 'unknown command' };
  }
}
