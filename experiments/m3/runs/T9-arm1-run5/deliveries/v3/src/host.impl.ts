import type { CreateHost, Host, Message, NodeView, Outcome } from '../host.ts';

const NODE_IDS = ['n0', 'n1', 'n2'] as const;
const MAJORITY = 2;

interface NodeState {
  role: NodeView['role'];
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
  const inFlight = new Map<string, Message>();
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${nextId++}`;
    inFlight.set(id, { id, from, to, action, data });
  }

  function onRequestVote(self: string, msg: Message): void {
    const node = nodes.get(self)!;
    const candidate = msg.data.from;
    if (typeof candidate !== 'string' || msg.data.term !== 1) return;
    let granted = false;
    if (node.term === 0) {
      node.term = 1;
      node.role = 'follower';
      node.votedFor = candidate;
      granted = true;
    } else if (node.term === 1) {
      if (node.role === 'follower' && (node.votedFor === null || node.votedFor === candidate)) {
        node.votedFor = candidate;
        granted = true;
      }
    }
    send(self, candidate, 'VoteReply', { term: 1, granted });
  }

  function onVoteReply(self: string, msg: Message): void {
    const node = nodes.get(self)!;
    if (node.role !== 'candidate' || msg.data.term !== node.term || msg.data.granted !== true) return;
    node.votes.add(msg.from);
    if (node.votes.size >= MAJORITY) {
      node.role = 'leader';
      node.leader = self;
      for (const peer of NODE_IDS) {
        if (peer !== self) send(self, peer, 'Leader', { from: self, term: node.term });
      }
    }
  }

  function onLeader(self: string, msg: Message): void {
    const node = nodes.get(self)!;
    const leader = msg.data.from;
    if (typeof leader !== 'string' || msg.data.term !== 1 || node.role === 'leader') return;
    if (node.term === 0) node.term = 1;
    node.role = 'follower';
    node.leader = leader;
  }

  async function deliver(id: string): Promise<void> {
    const msg = inFlight.get(id);
    if (!msg) return;
    inFlight.delete(id);
    const target = nodes.get(msg.to);
    if (!target || target.role === 'down') return;
    if (msg.action === 'RequestVote') onRequestVote(msg.to, msg);
    else if (msg.action === 'VoteReply') onVoteReply(msg.to, msg);
    else if (msg.action === 'Leader') onLeader(msg.to, msg);
  }

  const host: Host = {
    async inFlight() {
      return [...inFlight.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    deliver,
    async deliverAll() {
      while (inFlight.size > 0) {
        const id = inFlight.keys().next().value as string;
        await deliver(id);
      }
    },
    async timeout(id: string): Promise<Outcome> {
      const node = nodes.get(id);
      if (!node) return { ok: false, reason: `unknown node: ${id}` };
      if (node.role !== 'follower' || node.term !== 0) {
        return { ok: false, reason: `${id} cannot start an election: it is a ${node.role} in term ${node.term}` };
      }
      node.role = 'candidate';
      node.term = 1;
      node.votedFor = id;
      node.votes = new Set([id]);
      for (const peer of NODE_IDS) {
        if (peer !== id) send(id, peer, 'RequestVote', { from: id, term: 1 });
      }
      return { ok: true };
    },
    async giveUp(id: string): Promise<Outcome> {
      const node = nodes.get(id);
      if (!node) return { ok: false, reason: `unknown node: ${id}` };
      if (node.role !== 'candidate') {
        return { ok: false, reason: `${id} cannot give up: it is a ${node.role}, not a candidate` };
      }
      // Stays in its term and keeps its vote for itself; later VoteReplies are ignored since it is no candidate.
      node.role = 'follower';
      node.votes = new Set();
      return { ok: true };
    },
    async crash(id: string): Promise<Outcome> {
      const node = nodes.get(id);
      if (!node) return { ok: false, reason: `unknown node: ${id}` };
      if (node.role === 'down') return { ok: false, reason: `${id} is already down` };
      // Term, vote and known leader are durable; the vote count of a candidacy is not.
      node.role = 'down';
      node.votes = new Set();
      return { ok: true };
    },
    async recover(id: string): Promise<Outcome> {
      const node = nodes.get(id);
      if (!node) return { ok: false, reason: `unknown node: ${id}` };
      if (node.role !== 'down') return { ok: false, reason: `${id} is not down` };
      node.role = 'follower';
      return { ok: true };
    },
    async node(id: string): Promise<NodeView | null> {
      const node = nodes.get(id);
      if (!node) return null;
      return { role: node.role, term: node.term, votedFor: node.votedFor, leader: node.leader };
    },
  };
  return host;
};

export default createHost;
