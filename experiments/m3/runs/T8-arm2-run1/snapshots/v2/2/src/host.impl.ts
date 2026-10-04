import type { CreateHost, Host, NodeView, Outcome } from '../host.ts';
import { INITIAL_STATE, step } from './node-machine.ts';
import type { Command, NodeState } from './node-machine.ts';

const createHost: CreateHost = async () => {
  let state: NodeState = { ...INITIAL_STATE };
  const apply = async (c: Command): Promise<Outcome> => {
    const r = step(state, c);
    if (!r.ok) return { ok: false, reason: r.reason };
    state = r.state;
    return { ok: true };
  };
  const host: Host = {
    electionTimeout: () => apply({ type: 'electionTimeout' }),
    electionWon: () => apply({ type: 'electionWon' }),
    newerTermSeen: (term: number) => apply({ type: 'newerTermSeen', term }),
    quorumLost: () => apply({ type: 'quorumLost' }),
    shutdown: () => apply({ type: 'shutdown' }),
    voteRequested: (candidate: string, term: number) => apply({ type: 'voteRequested', candidate, term }),
    node: async (): Promise<NodeView> => ({ role: state.role, term: state.term, votedFor: state.votedFor }),
  };
  return host;
};

export default createHost;
