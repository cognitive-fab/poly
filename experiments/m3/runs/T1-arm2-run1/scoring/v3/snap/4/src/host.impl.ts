import type { CreateHost, Effect, Host, OrderView, Outcome } from '../host.ts';
import { initialOrder, step } from './order.ts';
import type { OrderAction } from './order.ts';

const createHost: CreateHost = async () => {
  const orders = new Map<string, OrderView>();
  const pending = new Map<string, Effect>();
  let nextEffect = 1;

  function apply(id: string, action: OrderAction): Outcome {
    const current = orders.get(id);
    if (!current) return { ok: false, reason: `no order ${id}` };
    const result = step(current, action);
    if (!result.ok) return result;
    orders.set(id, result.next);
    for (const r of result.requests) {
      // A refund is counted only; a charge awaits the provider's answer.
      if (r.kind === 'payment.charge') {
        const effectId = `e${nextEffect++}`;
        pending.set(effectId, { id: effectId, from: id, kind: r.kind, data: { ...r.data } });
      }
    }
    return { ok: true };
  }

  const host: Host = {
    async create(id) {
      if (orders.has(id)) return { ok: false, reason: `order ${id} exists` };
      orders.set(id, initialOrder());
      return { ok: true };
    },
    async addItem(id) { return apply(id, { type: 'addItem' }); },
    async removeItem(id) { return apply(id, { type: 'removeItem' }); },
    async place(id) { return apply(id, { type: 'place' }); },
    async ship(id) { return apply(id, { type: 'ship' }); },
    async cancel(id) { return apply(id, { type: 'cancel' }); },
    async retryPayment(id) { return apply(id, { type: 'retryPayment' }); },
    async hold(id) { return apply(id, { type: 'hold' }); },
    async release(id) { return apply(id, { type: 'release' }); },
    async order(id) {
      const o = orders.get(id);
      return o ? { ...o } : null;
    },
    async pendingEffects() {
      return [...pending.values()].map((e) => ({ ...e, data: { ...e.data } }));
    },
    async completeEffect(effectId, outcome) {
      const e = pending.get(effectId);
      if (!e) return;
      pending.delete(effectId);
      if (e.kind === 'payment.charge') apply(e.from, { type: 'chargeResult', outcome });
    },
  };
  return host;
};

export default createHost;
