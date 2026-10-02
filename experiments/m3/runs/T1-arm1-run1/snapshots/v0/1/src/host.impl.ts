import type { CreateHost, Effect, Host, OrderView, Outcome } from '../host.ts';

interface Order {
  status: OrderView['status'];
  items: number;
  charges: number;
  refunds: number;
}

const MAX_ITEMS = 3;

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const orders = new Map<string, Order>();
  const pending = new Map<string, Effect>();
  let nextEffect = 1;

  const request = (from: string, kind: string, data: Record<string, unknown>): void => {
    const id = `effect-${nextEffect++}`;
    pending.set(id, { id, from, kind, data });
  };

  const host: Host = {
    async create(id) {
      if (orders.has(id)) return refuse('order already exists');
      orders.set(id, { status: 'draft', items: 0, charges: 0, refunds: 0 });
      return ok();
    },

    async addItem(id) {
      const o = orders.get(id);
      if (!o) return refuse('no such order');
      if (o.status !== 'draft') return refuse(`order is ${o.status}`);
      if (o.items >= MAX_ITEMS) return refuse('order is full');
      o.items++;
      return ok();
    },

    async removeItem(id) {
      const o = orders.get(id);
      if (!o) return refuse('no such order');
      if (o.status !== 'draft') return refuse(`order is ${o.status}`);
      if (o.items === 0) return refuse('order is empty');
      o.items--;
      return ok();
    },

    async place(id) {
      const o = orders.get(id);
      if (!o) return refuse('no such order');
      if (o.status !== 'draft') return refuse(`order is ${o.status}`);
      if (o.items === 0) return refuse('order is empty');
      o.status = 'placed';
      o.charges++;
      request(id, 'payment.charge', { amount: o.items });
      return ok();
    },

    async ship(id) {
      const o = orders.get(id);
      if (!o) return refuse('no such order');
      if (o.status !== 'paid') return refuse(`order is ${o.status}`);
      o.status = 'shipped';
      return ok();
    },

    async cancel(id) {
      const o = orders.get(id);
      if (!o) return refuse('no such order');
      if (o.status === 'draft') {
        o.status = 'cancelled';
        return ok();
      }
      if (o.status === 'paid') {
        // The refund is counted and needs no answer, so it is not left pending.
        o.status = 'cancelled';
        o.refunds++;
        return ok();
      }
      return refuse(`order is ${o.status}`);
    },

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
      const o = orders.get(e.from);
      if (!o || e.kind !== 'payment.charge' || o.status !== 'placed') return;
      o.status = outcome === 'ok' ? 'paid' : 'failed';
    },
  };
  return host;
};

export default createHost;
