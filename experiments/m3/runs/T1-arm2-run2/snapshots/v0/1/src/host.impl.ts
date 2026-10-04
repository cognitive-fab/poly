import type { CreateHost, Effect, Host, OrderView, Outcome } from '../host.ts';

const MAX_ITEMS = 3;

type Status = OrderView['status'];

interface Order {
  status: Status;
  items: number;
  charges: number;
  refunds: number;
}

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const orders = new Map<string, Order>();
  const pending = new Map<string, Effect>();
  let nextEffect = 1;

  const request = (from: string, kind: string, data: Record<string, unknown>): void => {
    const id = `e${nextEffect++}`;
    pending.set(id, { id, from, kind, data });
  };

  // Runs a command on an existing order; the step either refuses (returns a reason)
  // or mutates the order, so a refused command changes nothing.
  const onOrder = async (id: string, step: (o: Order) => string | void): Promise<Outcome> => {
    const o = orders.get(id);
    if (!o) return refuse('unknown order');
    const reason = step(o);
    return reason ? refuse(reason) : ok();
  };

  const host: Host = {
    async create(id) {
      if (orders.has(id)) return refuse('order already exists');
      orders.set(id, { status: 'draft', items: 0, charges: 0, refunds: 0 });
      return ok();
    },

    addItem: (id) => onOrder(id, (o) => {
      if (o.status !== 'draft') return 'order is not a draft';
      if (o.items >= MAX_ITEMS) return 'draft is full';
      o.items++;
    }),

    removeItem: (id) => onOrder(id, (o) => {
      if (o.status !== 'draft') return 'order is not a draft';
      if (o.items === 0) return 'draft is empty';
      o.items--;
    }),

    place: (id) => onOrder(id, (o) => {
      if (o.status !== 'draft') return 'order is not a draft';
      if (o.items === 0) return 'draft is empty';
      o.status = 'placed';
      o.charges++;
      request(id, 'payment.charge', { amount: o.items });
    }),

    ship: (id) => onOrder(id, (o) => {
      if (o.status !== 'paid') return 'order is not paid';
      o.status = 'shipped';
    }),

    cancel: (id) => onOrder(id, (o) => {
      if (o.status === 'draft') {
        o.status = 'cancelled';
        return;
      }
      if (o.status === 'paid') {
        o.status = 'cancelled';
        o.refunds++;
        return;
      }
      if (o.status === 'placed') return 'payment in progress';
      return `order is ${o.status}`;
    }),

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
      if (!o || o.status !== 'placed') return;
      o.status = outcome === 'ok' ? 'paid' : 'failed';
    },
  };
  return host;
};

export default createHost;
