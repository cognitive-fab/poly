// The stateful core: a pure transition function over a node's { role, term }.

export type Role = 'follower' | 'candidate' | 'leader' | 'shutdown';

export interface NodeState {
  role: Role;
  term: number;
}

export type Command =
  | { type: 'electionTimeout' }
  | { type: 'electionWon' }
  | { type: 'newerTermSeen'; term: number }
  | { type: 'quorumLost' }
  | { type: 'shutdown' };

export type Step = { ok: true; state: NodeState } | { ok: false; reason: string };

export const MIN_TERM = 0;
export const MAX_TERM = 3;

export const initialState: NodeState = { role: 'follower', term: MIN_TERM };

export function step(state: NodeState, cmd: Command): Step {
  if (state.role === 'shutdown') return { ok: false, reason: 'node is shut down' };
  switch (cmd.type) {
    case 'electionTimeout':
      if (state.role === 'leader') return { ok: false, reason: 'the leader does not time out' };
      if (state.term >= MAX_TERM) return { ok: false, reason: `no term after ${MAX_TERM}` };
      return { ok: true, state: { role: 'candidate', term: state.term + 1 } };
    case 'electionWon':
      if (state.role !== 'candidate') return { ok: false, reason: 'only a candidate can win an election' };
      return { ok: true, state: { role: 'leader', term: state.term } };
    case 'newerTermSeen': {
      const t = cmd.term;
      if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > MAX_TERM) {
        return { ok: false, reason: `term must be an integer from 1 to ${MAX_TERM}` };
      }
      if (t <= state.term) return { ok: false, reason: 'term is not newer' };
      return { ok: true, state: { role: 'follower', term: t } };
    }
    case 'quorumLost':
      if (state.role !== 'leader') return { ok: false, reason: 'only the leader can lose quorum' };
      return { ok: true, state: { role: 'follower', term: state.term } };
    case 'shutdown':
      return { ok: true, state: { role: 'shutdown', term: state.term } };
    default:
      return { ok: false, reason: 'unknown command' };
  }
}
