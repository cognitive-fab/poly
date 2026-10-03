import type { CreateHost, Host, Message, NodeView, Outcome } from '../host.ts';

const NODES = ['n0', 'n1', 'n2'] as const;
const MAJORITY = 2;

interface NodeState {
  role: NodeView['role'];
  term: number;
  votedFor: string | null;
  leader: string | null;
  votes: Set<string>;
  electionStarted: boolean;
}

const createHost: CreateHost = async () => {
  const nodes = new Map<string, NodeState>();
  for (const id of NODES) {
    nodes.set(id, { role: 'follower', term: 0, votedFor: null, leader: null, votes: new Set(), electionStarted: false });
  }
  const inTransit = new Map<string, Message>();
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    const id = `m${nextId++}`;
    inTransit.set(id, { id, from, to, action, data });
  }

  function onRequestVote(self: string, msg: Message): void {
    const n = nodes.get(self)!;
    const candidate = msg.data.from;
    if (typeof candidate !== 'string' || !nodes.has(candidate) || msg.data.term !== 1) return;
    let granted: boolean;
    if (n.term === 0) {
      n.term = 1;
      n.role = 'follower';
      n.votedFor = candidate;
      granted = true;
    } else {
      granted = n.role === 'follower' && (n.votedFor === null || n.votedFor === candidate);
      if (granted) n.votedFor = candidate;
    }
    send(self, candidate, 'VoteReply', { term: 1, granted });
  }

  function onVoteReply(self: string, msg: Message): void {
    const n = nodes.get(self)!;
    if (n.role !== 'candidate' || msg.data.term !== n.term || msg.data.granted !== true) return;
    n.votes.add(msg.from);
    if (n.votes.size >= MAJORITY) n.role = 'leader';
  }

  function process(msg: Message): void {
    if (msg.action === 'RequestVote') onRequestVote(msg.to, msg);
    else if (msg.action === 'VoteReply') onVoteReply(msg.to, msg);
  }

  const copy = (m: Message): Message => ({ ...m, data: { ...m.data } });

  const host: Host = {
    async inFlight() {
      return [...inTransit.values()].map(copy);
    },
    async deliver(id: string) {
      const msg = inTransit.get(id);
      if (!msg) throw new Error(`no message in transit with id ${id}`);
      inTransit.delete(id);
      process(msg);
    },
    async deliverAll() {
      while (inTransit.size > 0) {
        const [id, msg] = inTransit.entries().next().value!;
        inTransit.delete(id);
        process(msg);
      }
    },
    async timeout(node: string): Promise<Outcome> {
      const n = nodes.get(node);
      if (!n) return { ok: false, reason: `unknown node ${node}` };
      if (n.electionStarted) return { ok: false, reason: `${node} has already started an election` };
      if (n.role !== 'follower' || n.term !== 0) {
        return { ok: false, reason: `${node} is not a follower in term 0` };
      }
      n.electionStarted = true;
      n.role = 'candidate';
      n.term = 1;
      n.votedFor = node;
      n.votes = new Set([node]);
      for (const other of NODES) {
        if (other !== node) send(node, other, 'RequestVote', { from: node, term: 1 });
      }
      return { ok: true };
    },
    async node(node: string) {
      const n = nodes.get(node);
      if (!n) return null;
      return { role: n.role, term: n.term, votedFor: n.votedFor };
    },
  };
  return host;
};

export default createHost;
