import type { CreateHost, Effect, Host, OrderView, Outcome } from '../host.ts';

type Status = OrderView['status'];

interface Order {
  status: Status;
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

  function request(from: string, kind: string, data: Record<string, unknown>): void {
    const id = `effect-${nextEffect++}`;
    pending.set(id, { id, from, kind, data });
  }

  function withOrder(id: string, act: (o: Order) => Outcome): Outcome {
    const o = orders.get(id);
    if (!o) return refuse(`order ${id} does not exist`);
    return act(o);
  }

  const host: Host = {
    async create(id) {
      if (orders.has(id)) return refuse(`order ${id} already exists`);
      orders.set(id, { status: 'draft', items: 0, charges: 0, refunds: 0 });
      return ok();
    },

    async addItem(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'draft') return refuse(`order is ${o.status}, not a draft`);
        if (o.items >= MAX_ITEMS) return refuse(`a draft holds at most ${MAX_ITEMS} items`);
        o.items++;
        return ok();
      });
    },

    async removeItem(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'draft') return refuse(`order is ${o.status}, not a draft`);
        if (o.items <= 0) return refuse('the draft holds no item');
        o.items--;
        return ok();
      });
    },

    async place(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'draft') return refuse(`order is ${o.status}, not a draft`);
        if (o.items <= 0) return refuse('cannot place an empty order');
        o.status = 'placed';
        o.charges++;
        request(id, 'payment.charge', { amount: o.items });
        return ok();
      });
    },

    async ship(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'paid') return refuse(`order is ${o.status}, not paid`);
        o.status = 'shipped';
        return ok();
      });
    },

    async cancel(id) {
      return withOrder(id, (o) => {
        if (o.status === 'draft') {
          o.status = 'cancelled';
          return ok();
        }
        if (o.status === 'paid') {
          o.status = 'cancelled';
          o.refunds++;
          return ok();
        }
        if (o.status === 'placed') return refuse('payment is in progress');
        return refuse(`order is ${o.status}`);
      });
    },

    async retryPayment(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'declined') return refuse(`order is ${o.status}, not declined`);
        o.status = 'placed';
        o.charges++;
        request(id, 'payment.charge', { amount: o.items });
        return ok();
      });
    },

    async order(id) {
      const o = orders.get(id);
      return o ? { status: o.status, items: o.items, charges: o.charges, refunds: o.refunds } : null;
    },

    async pendingEffects() {
      return [...pending.values()].map((e) => ({ ...e, data: { ...e.data } }));
    },

    async completeEffect(effectId, outcome) {
      const e = pending.get(effectId);
      if (!e) return;
      pending.delete(effectId);
      if (e.kind !== 'payment.charge') return;
      const o = orders.get(e.from);
      if (!o || o.status !== 'placed') return;
      if (outcome === 'ok') o.status = 'paid';
      else o.status = o.charges < MAX_CHARGES ? 'declined' : 'failed';
    },
  };

  return host;
};

export default createHost;
