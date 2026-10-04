// T9: electing a leader among three nodes, single round (term 1).

export interface Message {
  id: string;
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

export type Outcome = { ok: true } | { ok: false; reason: string };

export interface NodeView {
  role: 'follower' | 'candidate' | 'leader';
  term: number;
  votedFor: string | null;
  leader: string | null;
}

export interface Host {
  inFlight(): Promise<Message[]>;
  deliver(id: string): Promise<void>;
  deliverAll(): Promise<void>;
  timeout(node: string): Promise<Outcome>;
  node(node: string): Promise<NodeView | null>;
}

const NODE_IDS = ['n0', 'n1', 'n2'];
const MAJORITY = 2;
const ELECTION_TERM = 1;

interface NodeState {
  id: string;
  role: 'follower' | 'candidate' | 'leader';
  term: number;
  votedFor: string | null;
  votes: Set<string>;
  leader: string | null;
}

export default async function createHost(): Promise<Host> {
  const nodes = new Map<string, NodeState>();
  for (const id of NODE_IDS) {
    nodes.set(id, { id, role: 'follower', term: 0, votedFor: null, votes: new Set(), leader: null });
  }
  const transit = new Map<string, Message>();
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${nextId++}`;
    transit.set(id, { id, from, to, action, data });
  }

  function onRequestVote(n: NodeState, msg: Message): void {
    const candidate = msg.data.from;
    if (typeof candidate !== 'string' || !nodes.has(candidate) || candidate === n.id) return;
    if (msg.data.term !== ELECTION_TERM) return;
    let granted = false;
    if (n.term === 0) {
      n.term = ELECTION_TERM;
      n.role = 'follower';
      n.votedFor = candidate;
      granted = true;
    } else if (n.term === ELECTION_TERM) {
      granted = n.role === 'follower' && (n.votedFor === null || n.votedFor === candidate);
      if (granted) n.votedFor = candidate;
    }
    send(n.id, candidate, 'VoteReply', { term: ELECTION_TERM, granted });
  }

  function onVoteReply(n: NodeState, msg: Message): void {
    if (n.role !== 'candidate') return;
    if (msg.data.term !== n.term || msg.data.granted !== true) return;
    n.votes.add(msg.from);
    if (n.votes.size < MAJORITY) return;
    n.role = 'leader';
    n.leader = n.id;
    for (const other of NODE_IDS) {
      if (other !== n.id) send(n.id, other, 'Leader', { from: n.id, term: n.term });
    }
  }

  function onLeader(n: NodeState, msg: Message): void {
    const leader = msg.data.from;
    if (typeof leader !== 'string' || !nodes.has(leader) || leader === n.id) return;
    if (msg.data.term !== ELECTION_TERM || n.role === 'leader') return;
    if (n.term === 0) n.term = ELECTION_TERM;
    n.role = 'follower';
    n.leader = leader;
  }

  function deliverOne(id: string): void {
    const msg = transit.get(id);
    if (!msg) return;
    transit.delete(id);
    const n = nodes.get(msg.to);
    if (!n) return;
    if (msg.action === 'RequestVote') onRequestVote(n, msg);
    else if (msg.action === 'VoteReply') onVoteReply(n, msg);
    else if (msg.action === 'Leader') onLeader(n, msg);
  }

  return {
    async inFlight() {
      return [...transit.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id: string) {
      deliverOne(id);
    },
    async deliverAll() {
      while (transit.size > 0) {
        const id = transit.keys().next().value as string;
        deliverOne(id);
      }
    },
    async timeout(id: string): Promise<Outcome> {
      const n = nodes.get(id);
      if (!n) return { ok: false, reason: `unknown node: ${id}` };
      if (n.role !== 'follower' || n.term !== 0) {
        return { ok: false, reason: `${id} cannot start an election: it is a ${n.role} in term ${n.term}` };
      }
      n.role = 'candidate';
      n.term = ELECTION_TERM;
      n.votedFor = id;
      n.votes = new Set([id]);
      for (const other of NODE_IDS) {
        if (other !== id) send(id, other, 'RequestVote', { from: id, term: ELECTION_TERM });
      }
      return { ok: true };
    },
    async node(id: string) {
      const n = nodes.get(id);
      if (!n) return null;
      return { role: n.role, term: n.term, votedFor: n.votedFor, leader: n.leader };
    },
  };
}
