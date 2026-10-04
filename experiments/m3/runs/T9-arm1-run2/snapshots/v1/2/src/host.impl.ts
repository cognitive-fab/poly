import type { CreateHost, Host, Message, NodeView, Outcome } from '../host.ts';

const NODE_IDS = ['n0', 'n1', 'n2'];
const MAJORITY = 2;

interface NodeState {
  id: string;
  role: NodeView['role'];
  term: number;
  votedFor: string | null;
  leader: string | null;
  votes: Set<string>;
  startedElection: boolean;
}

const createHost: CreateHost = async () => {
  const nodes = new Map<string, NodeState>();
  for (const id of NODE_IDS) {
    nodes.set(id, { id, role: 'follower', term: 0, votedFor: null, leader: null, votes: new Set(), startedElection: false });
  }
  const inTransit = new Map<string, Message>();
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${nextId++}`;
    inTransit.set(id, { id, from, to, action, data });
  }

  function handleRequestVote(node: NodeState, msg: Message): void {
    const candidate = msg.data.from;
    const term = msg.data.term;
    if (term !== 1 || typeof candidate !== 'string' || !nodes.has(candidate)) return;
    let granted = false;
    if (node.term === 0) {
      node.term = 1;
      node.role = 'follower';
      node.votedFor = candidate;
      granted = true;
    } else if (node.term === 1) {
      granted = node.role === 'follower' && (node.votedFor === null || node.votedFor === candidate);
      if (granted) node.votedFor = candidate;
    }
    send(node.id, msg.from, 'VoteReply', { term: 1, granted });
  }

  function handleVoteReply(node: NodeState, msg: Message): void {
    if (node.role !== 'candidate') return;
    if (msg.data.term !== node.term || msg.data.granted !== true) return;
    node.votes.add(msg.from);
    if (node.votes.size >= MAJORITY) node.role = 'leader';
  }

  function deliverMessage(msg: Message): void {
    inTransit.delete(msg.id);
    const node = nodes.get(msg.to);
    if (!node) return;
    if (msg.action === 'RequestVote') handleRequestVote(node, msg);
    else if (msg.action === 'VoteReply') handleVoteReply(node, msg);
  }

  const host: Host = {
    async inFlight() {
      return [...inTransit.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id) {
      const msg = inTransit.get(id);
      if (msg) deliverMessage(msg);
    },
    async deliverAll() {
      while (inTransit.size > 0) {
        const msg = inTransit.values().next().value as Message;
        deliverMessage(msg);
      }
    },
    async timeout(id): Promise<Outcome> {
      const node = nodes.get(id);
      if (!node) return { ok: false, reason: `unknown node ${id}` };
      if (node.startedElection) return { ok: false, reason: `${id} already started an election` };
      if (node.role !== 'follower' || node.term !== 0) {
        return { ok: false, reason: `${id} is not a follower in term 0` };
      }
      node.startedElection = true;
      node.role = 'candidate';
      node.term = 1;
      node.votedFor = id;
      node.votes = new Set([id]);
      for (const other of NODE_IDS) {
        if (other !== id) send(id, other, 'RequestVote', { from: id, term: 1 });
      }
      return { ok: true };
    },
    async node(id) {
      const node = nodes.get(id);
      if (!node) return null;
      return { role: node.role, term: node.term, votedFor: node.votedFor };
    },
  };
  return host;
};

export default createHost;
