import type { CreateHost, Host, Message, NodeView, Outcome } from './types.ts';
import { NODES, initialNode, isNode, onGiveUp, onLeader, onRequestVote, onTimeout, onVoteReply } from './core.ts';
import type { NodeState, Outgoing } from './core.ts';

/** Read-only observation seam (tests, trace capture): full node states, votes included. */
export const inspectNodes = new WeakMap<Host, () => Record<string, NodeState>>();

const createHost: CreateHost = async () => {
  const nodes = new Map<string, NodeState>(NODES.map((n) => [n, initialNode()]));
  const inTransit = new Map<string, Message>();
  let nextId = 1;

  const send = (out: Outgoing[]) => {
    for (const m of out) {
      const id = `m${nextId++}`;
      inTransit.set(id, { id, from: m.from, to: m.to, action: m.action, data: { ...m.data } });
    }
  };

  const receive = (m: Message) => {
    const s = nodes.get(m.to);
    // a down node ignores every message delivered to it
    if (!s || s.role === 'down') return;
    if (m.action === 'RequestVote') {
      const r = onRequestVote(m.to, s, m.data as { from: string; term: number });
      nodes.set(m.to, r.state);
      send(r.send);
    } else if (m.action === 'VoteReply') {
      const r = onVoteReply(m.to, s, m.from, m.data as { term: number; granted: boolean });
      nodes.set(m.to, r.state);
      send(r.send);
    } else if (m.action === 'Leader') {
      nodes.set(m.to, onLeader(s, m.data as { from: string; term: number }));
    }
  };

  /** A command on one node that sends nothing: apply it, or refuse and change nothing. */
  const command = (
    node: string,
    step: (id: string, s: NodeState) => { ok: true; state: NodeState } | { ok: false; reason: string },
  ): Outcome => {
    if (typeof node !== 'string' || !isNode(node)) return { ok: false, reason: `unknown node: ${String(node)}` };
    const r = step(node, nodes.get(node)!);
    if (!r.ok) return { ok: false, reason: r.reason };
    nodes.set(node, r.state);
    return { ok: true };
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
      if (typeof node !== 'string' || !isNode(node)) return { ok: false, reason: `unknown node: ${String(node)}` };
      const r = onTimeout(node, nodes.get(node)!);
      if (!r.ok) return { ok: false, reason: r.reason };
      nodes.set(node, r.state);
      send(r.send);
      return { ok: true };
    },
    async giveUp(node: string): Promise<Outcome> {
      return command(node, onGiveUp);
    },
    async crash(node: string): Promise<Outcome> {
      return command(node, onCrash);
    },
    async recover(node: string): Promise<Outcome> {
      return command(node, onRecover);
    },
    async node(node: string): Promise<NodeView | null> {
      if (typeof node !== 'string' || !isNode(node)) return null;
      const s = nodes.get(node)!;
      return { role: s.role, term: s.term, votedFor: s.votedFor, leader: s.leader };
    },
  };
  inspectNodes.set(host, () =>
    Object.fromEntries([...nodes].map(([id, s]) => [id, { ...s, votes: [...s.votes].sort() }])),
  );
  return host;
};

export default createHost;
