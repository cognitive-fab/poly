import type { CreateHost, Effect, Host, OrderView, Outcome } from '../host.ts';

const MAX_ITEMS = 3;
const MAX_CHARGES = 2;

interface Order {
  status: OrderView['status'];
  items: number;
  charges: number;
  refunds: number;
  held: boolean;
}

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const orders = new Map<string, Order>();
  const pending = new Map<string, Effect>();
  let nextEffect = 1;

  const request = (from: string, kind: string, data: Record<string, unknown>) => {
    const id = `e${nextEffect++}`;
    pending.set(id, { id, from, kind, data });
  };

  const withOrder = (id: string, fn: (o: Order) => Outcome): Outcome => {
    const o = orders.get(id);
    return o ? fn(o) : refuse('unknown order');
  };

  const host: Host = {
    async create(id) {
      if (orders.has(id)) return refuse('order exists');
      orders.set(id, { status: 'draft', items: 0, charges: 0, refunds: 0, held: false });
      return ok();
    },
    async addItem(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'draft') return refuse('not a draft');
        if (o.items >= MAX_ITEMS) return refuse('draft is full');
        o.items++;
        return ok();
      });
    },
    async removeItem(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'draft') return refuse('not a draft');
        if (o.items <= 0) return refuse('draft is empty');
        o.items--;
        return ok();
      });
    },
    async place(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'draft') return refuse('not a draft');
        if (o.items <= 0) return refuse('draft is empty');
        o.status = 'placed';
        o.charges++;
        request(id, 'payment.charge', { amount: o.items });
        return ok();
      });
    },
    async ship(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'paid') return refuse('not paid');
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
        if (o.status === 'placed') {
          o.status = 'cancelling';
          return ok();
        }
        if (o.status === 'paid') {
          o.status = 'cancelled';
          o.refunds++;
          return ok();
        }
        return refuse(`cannot cancel a ${o.status} order`);
      });
    },
    async retryPayment(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'declined') return refuse('not declined');
        o.status = 'placed';
        o.charges++;
        request(id, 'payment.charge', { amount: o.items });
        return ok();
      });
    },
    async order(id) {
      const o = orders.get(id);
      return o ? { ...o } : null;
    },
    async pendingEffects() {
      return [...pending.values()].map((e) => ({ ...e, data: { ...e.data } }));
    },
    async completeEffect(id, outcome) {
      const e = pending.get(id);
      if (!e) return;
      pending.delete(id);
      if (e.kind !== 'payment.charge') return;
      const o = orders.get(e.from);
      if (!o) return;
      if (o.status === 'cancelling') {
        o.status = 'cancelled';
        if (outcome === 'ok') o.refunds++;
        return;
      }
      if (o.status !== 'placed') return;
      if (outcome === 'ok') o.status = 'paid';
      else o.status = o.charges < MAX_CHARGES ? 'declined' : 'failed';
    },
  };
  return host;
};

export default createHost;
