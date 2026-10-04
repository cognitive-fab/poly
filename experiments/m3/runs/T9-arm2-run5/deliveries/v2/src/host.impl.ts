import type { CreateHost, Host, Message, NodeView, Outcome } from '../host.ts';

const NODE_IDS = ['n0', 'n1', 'n2'] as const;
const ELECTION_TERM = 1;
const MAJORITY = 2;

interface NodeState {
  role: 'follower' | 'candidate' | 'leader';
  term: number;
  votedFor: string | null;
  leader: string | null;
  votes: Set<string>;
}

const createHost: CreateHost = async () => {
  const nodes = new Map<string, NodeState>();
  for (const id of NODE_IDS) {
    nodes.set(id, { role: 'follower', term: 0, votedFor: null, leader: null, votes: new Set() });
  }
  const inTransit = new Map<string, Message>();
  let nextId = 1;

  const send = (from: string, to: string, action: string, data: Record<string, unknown>): void => {
    const id = `m${nextId++}`;
    inTransit.set(id, { id, from, to, action, data });
  };

  const onRequestVote = (self: string, n: NodeState, data: Record<string, unknown>): void => {
    const candidate = data.from;
    if (typeof candidate !== 'string' || data.term !== ELECTION_TERM) return;
    let granted: boolean;
    if (n.term < ELECTION_TERM) {
      n.term = ELECTION_TERM;
      n.role = 'follower';
      n.votedFor = candidate;
      n.votes = new Set();
      granted = true;
    } else {
      granted = (n.role === 'follower' && n.votedFor === null) || n.votedFor === candidate;
      if (granted) n.votedFor = candidate;
    }
    send(self, candidate, 'VoteReply', { term: ELECTION_TERM, granted });
  };

  const onVoteReply = (self: string, from: string, n: NodeState, data: Record<string, unknown>): void => {
    if (n.role !== 'candidate' || data.term !== n.term || data.granted !== true) return;
    n.votes.add(from);
    if (n.votes.size < MAJORITY) return;
    n.role = 'leader';
    n.leader = self;
    for (const other of NODE_IDS) {
      if (other !== self) send(self, other, 'Leader', { from: self, term: ELECTION_TERM });
    }
  };

  const onLeader = (n: NodeState, data: Record<string, unknown>): void => {
    const leader = data.from;
    if (typeof leader !== 'string' || data.term !== ELECTION_TERM) return;
    // Only one node leads in a term, so a leader never receives Leader.
    if (n.role === 'leader') return;
    if (n.term < ELECTION_TERM) {
      n.term = ELECTION_TERM;
      n.votedFor = null;
      n.votes = new Set();
    }
    // A candidate steps down and keeps its vote for itself.
    n.role = 'follower';
    n.leader = leader;
  };

  const receive = (m: Message): void => {
    const n = nodes.get(m.to);
    if (!n) return;
    if (m.action === 'RequestVote') onRequestVote(m.to, n, m.data);
    else if (m.action === 'VoteReply') onVoteReply(m.to, m.from, n, m.data);
    else if (m.action === 'Leader') onLeader(n, m.data);
  };

  const host: Host = {
    async inFlight() {
      return [...inTransit.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },

    async deliver(id: string) {
      const m = inTransit.get(id);
      if (!m) return;
      inTransit.delete(id);
      receive(m);
    },

    async deliverAll() {
      while (inTransit.size > 0) {
        const [id, m] = inTransit.entries().next().value as [string, Message];
        inTransit.delete(id);
        receive(m);
      }
    },

    async timeout(node: string): Promise<Outcome> {
      const n = nodes.get(node);
      if (!n) return { ok: false, reason: `unknown node: ${node}` };
      if (n.role !== 'follower' || n.term !== 0) {
        return { ok: false, reason: `${node} cannot start an election (role ${n.role}, term ${n.term})` };
      }
      n.role = 'candidate';
      n.term = ELECTION_TERM;
      n.votedFor = node;
      n.votes = new Set([node]);
      for (const other of NODE_IDS) {
        if (other !== node) send(node, other, 'RequestVote', { from: node, term: ELECTION_TERM });
      }
      return { ok: true };
    },

    async giveUp(node: string): Promise<Outcome> {
      const n = nodes.get(node);
      if (!n) return { ok: false, reason: `unknown node: ${node}` };
      if (n.role !== 'candidate') {
        return { ok: false, reason: `${node} is not a candidate (role ${n.role})` };
      }
      // Same term, and the vote for itself stays: it grants no other vote this term,
      // and as a follower it ignores any VoteReply that arrives later.
      n.role = 'follower';
      return { ok: true };
    },

    async node(node: string): Promise<NodeView | null> {
      const n = nodes.get(node);
      if (!n) return null;
      return { role: n.role, term: n.term, votedFor: n.votedFor, leader: n.leader };
    },
  };
  return host;
};

export default createHost;
