import type { CreateHost, Host, NodeView, Outcome } from '../host.ts';
import { initialState, step } from './core.ts';
import type { Command, NodeState } from './core.ts';

const createHost: CreateHost = async () => {
  let state: NodeState = { ...initialState };

  const run = async (cmd: Command): Promise<Outcome> => {
    const r = step(state, cmd);
    if (!r.ok) return { ok: false, reason: r.reason };
    state = r.state;
    return { ok: true };
  };

  const host: Host = {
    electionTimeout: () => run({ type: 'electionTimeout' }),
    electionWon: () => run({ type: 'electionWon' }),
    newerTermSeen: (term: number) => run({ type: 'newerTermSeen', term }),
    quorumLost: () => run({ type: 'quorumLost' }),
    shutdown: () => run({ type: 'shutdown' }),
    node: async (): Promise<NodeView> => ({ role: state.role, term: state.term }),
  };
  return host;
};

export default createHost;
