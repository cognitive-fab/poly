import type { CreateHost, Host, NodeView, Outcome } from '../host.ts';
import { initialState, step } from './node.ts';
import type { Command, NodeState } from './node.ts';

const createHost: CreateHost = async (): Promise<Host> => {
  let state: NodeState = initialState();

  const run = async (c: Command): Promise<Outcome> => {
    const r = step(state, c);
    if (!r.ok) return { ok: false, reason: r.reason };
    state = r.state;
    return { ok: true };
  };

  return {
    electionTimeout: () => run({ type: 'electionTimeout' }),
    electionWon: () => run({ type: 'electionWon' }),
    newerTermSeen: (term: number) => run({ type: 'newerTermSeen', term }),
    quorumLost: () => run({ type: 'quorumLost' }),
    shutdown: () => run({ type: 'shutdown' }),
    node: async (): Promise<NodeView> => ({ role: state.role, term: state.term }),
  };
};

export default createHost;
