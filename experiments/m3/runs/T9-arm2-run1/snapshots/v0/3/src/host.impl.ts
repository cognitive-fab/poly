import type { CreateHost, Host, Message, NodeView, Outcome } from '../host.ts';
import { NODES, initialNode, isNode, onRequestVote, onTimeout, onVoteReply } from './core.ts';
import type { NodeState, Outgoing } from './core.ts';

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
    if (!s) return;
    if (m.action === 'RequestVote') {
      const r = onRequestVote(m.to, s, m.data as { from: string; term: number });
      nodes.set(m.to, r.state);
      send(r.send);
    } else if (m.action === 'VoteReply') {
      nodes.set(m.to, onVoteReply(s, m.from, m.data as { term: number; granted: boolean }));
    }
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
    async node(node: string): Promise<NodeView | null> {
      if (typeof node !== 'string' || !isNode(node)) return null;
      const s = nodes.get(node)!;
      return { role: s.role, term: s.term, votedFor: s.votedFor };
    },
  };
  return host;
};

export default createHost;
