import type { CreateHost, Host, Message, NodeView, Outcome } from '../host.ts';

const NODES = ['n0', 'n1', 'n2'] as const;
const ELECTION_TERM = 1;
const MAJORITY = 2;

interface NodeState {
  role: 'follower' | 'candidate' | 'leader';
  term: number;
  votedFor: string | null;
  leader: string | null;
  votes: Set<string>;
}

/** Test seam: the full internal state of a host, for trace capture. */
const internals = new WeakMap<Host, () => unknown>();
export const inspect = (host: Host): unknown => internals.get(host)?.();

const isNode = (id: string): boolean => (NODES as readonly string[]).includes(id);

const createHost: CreateHost = async () => {
  const nodes = new Map<string, NodeState>();
  for (const id of NODES) nodes.set(id, { role: 'follower', term: 0, votedFor: null, leader: null, votes: new Set() });

  const inFlight = new Map<string, Message>();
  let nextId = 1;

  const send = (from: string, to: string, action: string, data: Record<string, unknown>): void => {
    const id = `m${nextId++}`;
    inFlight.set(id, { id, from, to, action, data });
  };

  const onRequestVote = (self: string, msg: Message): void => {
    const n = nodes.get(self)!;
    const candidate = msg.data.from;
    if (typeof candidate !== 'string' || !isNode(candidate) || msg.data.term !== ELECTION_TERM) return;
    let granted: boolean;
    if (n.term < ELECTION_TERM) {
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

  const onVoteReply = (self: string, msg: Message): void => {
    const n = nodes.get(self)!;
    if (n.role !== 'candidate' || msg.data.term !== n.term || msg.data.granted !== true) return;
    n.votes.add(msg.from);
    if (n.votes.size < MAJORITY) return;
    n.role = 'leader';
    n.leader = self;
    for (const other of NODES) {
      if (other !== self) send(self, other, 'Leader', { from: self, term: n.term });
    }
  };

  const onLeader = (self: string, msg: Message): void => {
    const n = nodes.get(self)!;
    const leader = msg.data.from;
    if (typeof leader !== 'string' || !isNode(leader) || msg.data.term !== ELECTION_TERM) return;
    if (n.role === 'leader') return; // only one node leads in a term
    if (n.term < ELECTION_TERM) {
      n.term = ELECTION_TERM;
      n.votedFor = null;
    }
    // a candidate steps down, keeping its vote for itself
    n.role = 'follower';
    n.leader = leader;
  };

  const deliver = async (id: string): Promise<void> => {
    const msg = inFlight.get(id);
    if (!msg) return;
    inFlight.delete(id);
    if (!isNode(msg.to)) return;
    if (msg.action === 'RequestVote') onRequestVote(msg.to, msg);
    else if (msg.action === 'VoteReply') onVoteReply(msg.to, msg);
    else if (msg.action === 'Leader') onLeader(msg.to, msg);
  };

  const host: Host = {
    async inFlight() {
      return [...inFlight.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    deliver,
    async deliverAll() {
      while (inFlight.size > 0) {
        const [id] = inFlight.keys();
        await deliver(id);
      }
    },
    async timeout(node: string): Promise<Outcome> {
      if (!isNode(node)) return { ok: false, reason: `unknown node: ${node}` };
      const n = nodes.get(node)!;
      if (n.role !== 'follower' || n.term !== 0) {
        return { ok: false, reason: `${node} cannot start an election (role ${n.role}, term ${n.term})` };
      }
      n.role = 'candidate';
      n.term = ELECTION_TERM;
      n.votedFor = node;
      n.votes = new Set([node]);
      for (const other of NODES) {
        if (other !== node) send(node, other, 'RequestVote', { from: node, term: ELECTION_TERM });
      }
      return { ok: true };
    },
    async node(node: string): Promise<NodeView | null> {
      if (!isNode(node)) return null;
      const n = nodes.get(node)!;
      return { role: n.role, term: n.term, votedFor: n.votedFor, leader: n.leader };
    },
  };
  internals.set(host, () => ({
    nodes: Object.fromEntries(
      [...nodes].map(([id, n]) => [id, { role: n.role, term: n.term, votedFor: n.votedFor, leader: n.leader, votes: [...n.votes].sort() }]),
    ),
    net: Object.fromEntries([...inFlight.values()].map((m) => [`${m.action}|${m.from}|${m.to}`, { ...m.data }])),
  }));
  return host;
};

export default createHost;
