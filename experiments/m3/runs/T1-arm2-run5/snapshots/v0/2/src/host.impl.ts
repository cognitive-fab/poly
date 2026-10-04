import type { CreateHost, Effect, Host, Outcome, OrderView } from '../host.ts';
import { answer, created, step } from './order.ts';
import type { Command, OrderState } from './order.ts';

const createHost: CreateHost = async () => {
  const orders = new Map<string, OrderState>();
  // Only charges await an answer; refunds are counted and never pending.
  const pending = new Map<string, Effect>();
  let nextEffect = 1;

  const run = (id: string, command: Command): Outcome => {
    const s = orders.get(id);
    if (!s) return { ok: false, reason: `no order ${id}` };
    const r = step(s, command);
    if (!r.ok) return { ok: false, reason: r.reason };
    orders.set(id, r.state);
    for (const req of r.requests) {
      if (req.kind !== 'payment.charge') continue;
      const effectId = `effect-${nextEffect++}`;
      pending.set(effectId, { id: effectId, from: id, kind: req.kind, data: { ...req.data } });
    }
    return { ok: true };
  };

  const host: Host = {
    async create(id) {
      if (orders.has(id)) return { ok: false, reason: `order ${id} exists` };
      orders.set(id, created());
      return { ok: true };
    },
    async addItem(id) { return run(id, 'addItem'); },
    async removeItem(id) { return run(id, 'removeItem'); },
    async place(id) { return run(id, 'place'); },
    async ship(id) { return run(id, 'ship'); },
    async cancel(id) { return run(id, 'cancel'); },
    async order(id): Promise<OrderView | null> {
      const s = orders.get(id);
      return s ? { ...s } : null;
    },
    async pendingEffects() {
      return [...pending.values()].map((e) => ({ ...e, data: { ...e.data } }));
    },
    async completeEffect(effectId, outcome) {
      const e = pending.get(effectId);
      if (!e) return;
      pending.delete(effectId);
      const s = orders.get(e.from);
      if (s) orders.set(e.from, answer(s, outcome === 'ok' ? 'chargeOk' : 'chargeFailed'));
    },
  };
  return host;
};

export default createHost;
