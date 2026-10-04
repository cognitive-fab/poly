export type Outcome = { ok: true } | { ok: false; reason: string };

export interface Effect {
  id: string;
  from: string;
  kind: string;
  data: Record<string, unknown>;
}

type Status = 'draft' | 'placed' | 'paid' | 'shipped' | 'cancelling' | 'cancelled' | 'declined' | 'failed';

export interface OrderView {
  status: Status;
  items: number;
  charges: number;
  refunds: number;
}

export interface Host {
  pendingEffects(): Promise<Effect[]>;
  completeEffect(id: string, outcome: 'ok' | 'failed'): Promise<void>;
  create(order: string): Promise<Outcome>;
  addItem(order: string): Promise<Outcome>;
  removeItem(order: string): Promise<Outcome>;
  place(order: string): Promise<Outcome>;
  ship(order: string): Promise<Outcome>;
  cancel(order: string): Promise<Outcome>;
  retryPayment(order: string): Promise<Outcome>;
  order(order: string): Promise<OrderView | null>;
}

const MAX_ITEMS = 3;
const MAX_CHARGES = 2;

const OK: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

export default async function createHost(): Promise<Host> {
  const orders = new Map<string, OrderView>();
  const pending = new Map<string, Effect>();
  let nextEffect = 1;

  const request = (from: string, kind: string, data: Record<string, unknown>): void => {
    const id = `effect-${nextEffect++}`;
    pending.set(id, { id, from, kind, data });
  };

  const withOrder = (id: string, fn: (o: OrderView) => Outcome): Outcome => {
    const o = orders.get(id);
    if (!o) return refuse(`no order ${id}`);
    return fn(o);
  };

  return {
    async create(id) {
      if (orders.has(id)) return refuse(`order ${id} exists`);
      orders.set(id, { status: 'draft', items: 0, charges: 0, refunds: 0 });
      return OK;
    },

    async addItem(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'draft') return refuse(`order is ${o.status}, not draft`);
        if (o.items >= MAX_ITEMS) return refuse(`draft already holds ${MAX_ITEMS} items`);
        o.items++;
        return OK;
      });
    },

    async removeItem(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'draft') return refuse(`order is ${o.status}, not draft`);
        if (o.items < 1) return refuse('draft holds no item');
        o.items--;
        return OK;
      });
    },

    async place(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'draft') return refuse(`order is ${o.status}, not draft`);
        if (o.items < 1) return refuse('draft holds no item');
        o.status = 'placed';
        o.charges++;
        request(id, 'payment.charge', { amount: o.items });
        return OK;
      });
    },

    async ship(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'paid') return refuse(`order is ${o.status}, not paid`);
        o.status = 'shipped';
        return OK;
      });
    },

    async cancel(id) {
      return withOrder(id, (o) => {
        if (o.status === 'draft') {
          o.status = 'cancelled';
          return OK;
        }
        if (o.status === 'paid') {
          o.status = 'cancelled';
          o.refunds++;
          return OK;
        }
        return refuse(`order is ${o.status}, cannot be cancelled`);
      });
    },

    async retryPayment(id) {
      return withOrder(id, (o) => {
        if (o.status !== 'declined') return refuse(`order is ${o.status}, not declined`);
        o.status = 'placed';
        o.charges++;
        request(id, 'payment.charge', { amount: o.items });
        return OK;
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
      if (!o || o.status !== 'placed') return;
      if (outcome === 'ok') o.status = 'paid';
      else o.status = o.charges < MAX_CHARGES ? 'declined' : 'failed';
    },
  };
}
