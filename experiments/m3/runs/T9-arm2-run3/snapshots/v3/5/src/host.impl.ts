// Leader election among three nodes, one round (term 1), over a held network;
// the winner announces itself to the others.

interface Message {
  id: string;
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

type Outcome = { ok: true } | { ok: false; reason: string };

type Role = 'follower' | 'candidate' | 'leader' | 'down';

interface NodeView {
  role: Role;
  term: number;
  votedFor: string | null;
  leader: string | null;
}

interface Host {
  inFlight(): Promise<Message[]>;
  deliver(id: string): Promise<void>;
  deliverAll(): Promise<void>;
  timeout(node: string): Promise<Outcome>;
  giveUp(node: string): Promise<Outcome>;
  crash(node: string): Promise<Outcome>;
  recover(node: string): Promise<Outcome>;
  node(node: string): Promise<NodeView | null>;
}

// term, votedFor and leader are written down and survive a crash; votes is volatile.
interface NodeState {
  role: Role;
  term: number;
  votedFor: string | null;
  leader: string | null;
  votes: Set<string>;
}

const NODES = ['n0', 'n1', 'n2'];
const ELECTION_TERM = 1;
const MAJORITY = 2;

export default async function createHost(): Promise<Host> {
  const nodes = new Map<string, NodeState>();
  for (const id of NODES) nodes.set(id, { role: 'follower', term: 0, votedFor: null, leader: null, votes: new Set() });

  const network = new Map<string, Message>();
  let nextId = 1;

  const send = (from: string, to: string, action: string, data: Record<string, unknown>): void => {
    const id = `m${nextId++}`;
    network.set(id, { id, from, to, action, data });
  };

  const onRequestVote = (self: string, n: NodeState, msg: Message): void => {
    const candidate = msg.data.from as string;
    const term = msg.data.term as number;
    if (term !== ELECTION_TERM || !nodes.has(candidate)) return;
    let granted: boolean;
    if (n.term === 0) {
      n.term = ELECTION_TERM;
      n.role = 'follower';
      n.votedFor = candidate;
      granted = true;
    } else {
      granted = n.role === 'follower' && (n.votedFor === null || n.votedFor === candidate);
      if (granted) n.votedFor = candidate;
    }
    send(self, candidate, 'VoteReply', { term: ELECTION_TERM, granted });
  };

  const onVoteReply = (self: string, n: NodeState, msg: Message): void => {
    if (n.role !== 'candidate' || msg.data.term !== n.term || msg.data.granted !== true) return;
    n.votes.add(msg.from);
    if (n.votes.size >= MAJORITY) {
      n.role = 'leader';
      n.leader = self;
      for (const other of NODES) if (other !== self) send(self, other, 'Leader', { from: self, term: ELECTION_TERM });
    }
  };

  const onLeader = (n: NodeState, msg: Message): void => {
    const leader = msg.data.from as string;
    if (msg.data.term !== ELECTION_TERM || !nodes.has(leader) || n.role === 'leader') return;
    if (n.term === 0) {
      n.term = ELECTION_TERM;
      n.votedFor = null;
    }
    // A candidate steps down and keeps its vote for itself.
    n.role = 'follower';
    n.leader = leader;
  };

  const deliverOne = (id: string): void => {
    const msg = network.get(id);
    if (!msg) return;
    network.delete(id);
    const n = nodes.get(msg.to);
    if (!n || n.role === 'down') return;
    if (msg.action === 'RequestVote') onRequestVote(msg.to, n, msg);
    else if (msg.action === 'VoteReply') onVoteReply(msg.to, n, msg);
    else if (msg.action === 'Leader') onLeader(n, msg);
  };

  return {
    async inFlight() {
      return [...network.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id: string) {
      deliverOne(id);
    },
    async deliverAll() {
      while (network.size > 0) deliverOne(network.keys().next().value as string);
    },
    async timeout(id: string): Promise<Outcome> {
      const n = nodes.get(id);
      if (!n) return { ok: false, reason: `unknown node ${id}` };
      if (n.role !== 'follower' || n.term !== 0) {
        return { ok: false, reason: `${id} is a ${n.role} in term ${n.term}; only a follower in term 0 can start the election` };
      }
      n.role = 'candidate';
      n.term = ELECTION_TERM;
      n.votedFor = id;
      n.votes = new Set([id]);
      for (const other of NODES) if (other !== id) send(id, other, 'RequestVote', { from: id, term: ELECTION_TERM });
      return { ok: true };
    },
    async giveUp(id: string): Promise<Outcome> {
      const n = nodes.get(id);
      if (!n) return { ok: false, reason: `unknown node ${id}` };
      if (n.role !== 'candidate') return { ok: false, reason: `${id} is a ${n.role}; only a candidate can give up` };
      // Keeps its vote for itself; as a follower it ignores later VoteReply messages.
      n.role = 'follower';
      return { ok: true };
    },
    async crash(id: string): Promise<Outcome> {
      const n = nodes.get(id);
      if (!n) return { ok: false, reason: `unknown node ${id}` };
      if (n.role === 'down') return { ok: false, reason: `${id} is already down` };
      n.role = 'down';
      n.votes = new Set();
      return { ok: true };
    },
    async recover(id: string): Promise<Outcome> {
      const n = nodes.get(id);
      if (!n) return { ok: false, reason: `unknown node ${id}` };
      if (n.role !== 'down') return { ok: false, reason: `${id} is not down` };
      // term, vote and known leader survived the crash
      n.role = 'follower';
      return { ok: true };
    },
    async node(id: string) {
      const n = nodes.get(id);
      if (!n) return null;
      return { role: n.role, term: n.term, votedFor: n.votedFor, leader: n.leader };
    },
  };
}
