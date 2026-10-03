import { initialState, step } from './node.ts';
import type { Command, NodeState, Role } from './node.ts';

// Structurally identical to the types in host.ts (kept local: src/ imports only src/).
type Outcome = { ok: true } | { ok: false; reason: string };
interface NodeView { role: Role; term: number }
interface Host {
  electionTimeout(): Promise<Outcome>;
  electionWon(): Promise<Outcome>;
  newerTermSeen(term: number): Promise<Outcome>;
  quorumLost(): Promise<Outcome>;
  shutdown(): Promise<Outcome>;
  node(): Promise<NodeView>;
}
type CreateHost = () => Promise<Host>;

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
