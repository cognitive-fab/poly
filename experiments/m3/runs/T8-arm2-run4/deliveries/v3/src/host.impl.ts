import type { CreateHost, Host, NodeView, Outcome } from '../host.ts';
import { initialNode, step, type Command } from './node.ts';

const createHost: CreateHost = async () => {
  let state: NodeView = initialNode();
  const run = async (c: Command): Promise<Outcome> => {
    const r = step(state, c);
    if (!r.ok) return { ok: false, reason: r.reason };
    state = r.next;
    return { ok: true };
  };
  const host: Host = {
    electionTimeout: () => run({ type: 'electionTimeout' }),
    electionWon: () => run({ type: 'electionWon' }),
    electionLost: () => run({ type: 'electionLost' }),
    newerTermSeen: (term: number) => run({ type: 'newerTermSeen', term }),
    quorumLost: () => run({ type: 'quorumLost' }),
    shutdown: () => run({ type: 'shutdown' }),
    pause: () => run({ type: 'pause' }),
    resume: () => run({ type: 'resume' }),
    voteRequested: (candidate: string, term: number) => run({ type: 'voteRequested', candidate, term }),
    node: async () => ({ role: state.role, term: state.term, votedFor: state.votedFor, paused: state.paused }),
  };
  return host;
};

export default createHost;
