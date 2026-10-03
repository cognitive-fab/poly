// Leader election among three nodes, one round (term 1).
// The stateful core (timeout, giveUp, onRequestVote, onVoteReply, onLeader) is mirrored by spec/election.cjs.

import type { CreateHost, Host, Message, NodeView, Outcome } from './types.ts';

const NODES = ['n0', 'n1', 'n2'] as const;
const MAJORITY = 2;
const ELECTION_TERM = 1;

interface NodeState {
  role: NodeView['role'];
  term: number;
  votedFor: string | null;
  /** The leader this node knows in its term, itself if it leads. */
  leader: string | null;
  /** Ids of the nodes whose vote this node holds in its term, its own included. */
  votes: Set<string>;
}

function isNode(id: unknown): id is string {
  return typeof id === 'string' && (NODES as readonly string[]).includes(id);
}

const createHost: CreateHost = async () => {
  const nodes = new Map<string, NodeState>();
  for (const id of NODES) nodes.set(id, { role: 'follower', term: 0, votedFor: null, leader: null, votes: new Set() });

  let inFlight: Message[] = [];
  let nextId = 1;

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    inFlight.push({ id: `m${nextId++}`, from, to, action, data });
  }

  function onRequestVote(me: string, msg: Message): void {
    const self = nodes.get(me)!;
    const candidate = msg.data.from;
    if (msg.data.term !== ELECTION_TERM || !isNode(candidate) || candidate === me) return;
    let granted: boolean;
    if (self.term < ELECTION_TERM) {
      self.term = ELECTION_TERM;
      self.role = 'follower';
      self.votedFor = candidate;
      self.votes = new Set();
      granted = true;
    } else {
      granted = self.role === 'follower' && (self.votedFor === null || self.votedFor === candidate);
      if (granted) self.votedFor = candidate;
    }
    send(me, candidate, 'VoteReply', { term: ELECTION_TERM, granted });
  }

  function onVoteReply(me: string, msg: Message): void {
    const self = nodes.get(me)!;
    if (self.role !== 'candidate' || msg.data.term !== self.term || msg.data.granted !== true) return;
    if (!isNode(msg.from) || msg.from === me) return;
    self.votes.add(msg.from);
    if (self.votes.size >= MAJORITY) {
      self.role = 'leader';
      self.leader = me;
      for (const other of NODES) {
        if (other !== me) send(me, other, 'Leader', { from: me, term: self.term });
      }
    }
  }

  function onLeader(me: string, msg: Message): void {
    const self = nodes.get(me)!;
    const leader = msg.data.from;
    if (msg.data.term !== ELECTION_TERM || !isNode(leader) || leader === me || self.role === 'leader') return;
    if (self.term < ELECTION_TERM) {
      self.term = ELECTION_TERM;
      self.votedFor = null;
      self.votes = new Set();
    }
    self.role = 'follower';
    self.leader = leader;
  }

  function handle(msg: Message): void {
    if (!isNode(msg.to)) return;
    if (nodes.get(msg.to)!.role === 'down') return; // a down node ignores every message delivered to it
    if (msg.action === 'RequestVote') onRequestVote(msg.to, msg);
    else if (msg.action === 'VoteReply') onVoteReply(msg.to, msg);
    else if (msg.action === 'Leader') onLeader(msg.to, msg);
  }

  const host: Host = {
    async timeout(node: string): Promise<Outcome> {
      if (!isNode(node)) return { ok: false, reason: `unknown node: ${String(node)}` };
      const self = nodes.get(node)!;
      if (self.role === 'down') return { ok: false, reason: `${node} is down` };
      if (self.role !== 'follower' || self.term !== 0) {
        return { ok: false, reason: `${node} cannot start an election: it is a ${self.role} in term ${self.term}` };
      }
      self.role = 'candidate';
      self.term = ELECTION_TERM;
      self.votedFor = node;
      self.votes = new Set([node]);
      for (const other of NODES) {
        if (other !== node) send(node, other, 'RequestVote', { from: node, term: ELECTION_TERM });
      }
      return { ok: true };
    },

    async giveUp(node: string): Promise<Outcome> {
      if (!isNode(node)) return { ok: false, reason: `unknown node: ${String(node)}` };
      const self = nodes.get(node)!;
      if (self.role !== 'candidate') return { ok: false, reason: `${node} is not a candidate: it is a ${self.role}` };
      // Keeps votedFor === node, so it grants no other vote in the term; as a follower it ignores later VoteReplies.
      self.role = 'follower';
      self.votes = new Set();
      return { ok: true };
    },

    async node(node: string): Promise<NodeView | null> {
      if (!isNode(node)) return null;
      const s = nodes.get(node)!;
      return { role: s.role, term: s.term, votedFor: s.votedFor, leader: s.leader };
    },

    async inFlight(): Promise<Message[]> {
      return inFlight.map((m) => ({ ...m, data: { ...m.data } }));
    },

    async deliver(id: string): Promise<void> {
      const msg = inFlight.find((m) => m.id === id);
      if (!msg) return;
      inFlight = inFlight.filter((m) => m !== msg);
      handle(msg);
    },

    async deliverAll(): Promise<void> {
      while (inFlight.length > 0) {
        const msg = inFlight.shift()!;
        handle(msg);
      }
    },
  };
  return host;
};

export default createHost;
