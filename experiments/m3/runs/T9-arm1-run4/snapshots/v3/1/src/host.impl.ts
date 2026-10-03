import type { CreateHost, Host, Message, NodeView, Outcome } from '../host.ts';

const NODE_IDS = ['n0', 'n1', 'n2'];
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
  const inTransit = new Map<string, Message>();
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${nextId++}`;
    inTransit.set(id, { id, from, to, action, data });
  }

  function handle(msg: Message): void {
    const self = nodes.get(msg.to);
    if (!self || self.role === 'down') return;
    if (msg.action === 'RequestVote') {
      const candidate = msg.data.from;
      const term = msg.data.term;
      if (typeof candidate !== 'string' || term !== 1 || !nodes.has(candidate) || candidate === msg.to) return;
      let granted = false;
      if (self.term === 0) {
        self.term = 1;
        self.role = 'follower';
        self.votedFor = candidate;
        granted = true;
      } else if (self.term === 1) {
        granted = self.role === 'follower' && (self.votedFor === null || self.votedFor === candidate);
        if (granted) self.votedFor = candidate;
      }
      send(msg.to, candidate, 'VoteReply', { term: 1, granted });
    } else if (msg.action === 'VoteReply') {
      if (self.role !== 'candidate' || msg.data.term !== self.term || msg.data.granted !== true) return;
      self.votes.add(msg.from);
      if (self.votes.size >= MAJORITY) {
        self.role = 'leader';
        self.leader = msg.to;
        for (const other of NODE_IDS) {
          if (other !== msg.to) send(msg.to, other, 'Leader', { from: msg.to, term: 1 });
        }
      }
    } else if (msg.action === 'Leader') {
      const leader = msg.data.from;
      if (typeof leader !== 'string' || msg.data.term !== 1 || !nodes.has(leader) || leader === msg.to) return;
      if (self.role === 'leader') return;
      if (self.term === 0) {
        self.term = 1;
        self.role = 'follower';
        self.votedFor = null;
      } else if (self.role === 'candidate') {
        self.role = 'follower';
      }
      self.leader = leader;
    }
  }

  const host: Host = {
    async inFlight() {
      return [...inTransit.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id: string) {
      const msg = inTransit.get(id);
      if (!msg) return;
      inTransit.delete(id);
      handle(msg);
    },
    async deliverAll() {
      while (inTransit.size > 0) {
        const [id, msg] = inTransit.entries().next().value as [string, Message];
        inTransit.delete(id);
        handle(msg);
      }
    },
    async timeout(node: string): Promise<Outcome> {
      const self = nodes.get(node);
      if (!self) return { ok: false, reason: `unknown node: ${node}` };
      if (self.role !== 'follower' || self.term !== 0) {
        return { ok: false, reason: `${node} cannot start an election: it is a ${self.role} in term ${self.term}` };
      }
      self.role = 'candidate';
      self.term = 1;
      self.votedFor = node;
      self.votes = new Set([node]);
      for (const other of NODE_IDS) {
        if (other !== node) send(node, other, 'RequestVote', { from: node, term: 1 });
      }
      return { ok: true };
    },
    async giveUp(node: string): Promise<Outcome> {
      const self = nodes.get(node);
      if (!self) return { ok: false, reason: `unknown node: ${node}` };
      if (self.role !== 'candidate') {
        return { ok: false, reason: `${node} cannot give up: it is a ${self.role} in term ${self.term}` };
      }
      // Keeps its vote for itself, so it grants no other vote this term; later VoteReplies are ignored.
      self.role = 'follower';
      return { ok: true };
    },
    async node(node: string) {
      const self = nodes.get(node);
      if (!self) return null;
      return { role: self.role, term: self.term, votedFor: self.votedFor, leader: self.leader };
    },
  };
  return host;
};

export default createHost;
