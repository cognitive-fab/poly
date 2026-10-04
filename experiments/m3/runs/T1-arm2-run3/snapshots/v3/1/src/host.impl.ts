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
  let nextEffectId = 1;

  const requestCharge = (from: string, amount: number): void => {
    const id = `effect-${nextEffectId++}`;
    pending.set(id, { id, from, kind: 'payment.charge', data: { amount } });
  };

  // Runs a command against an existing order; a refusal changes nothing.
  const withOrder = async (id: string, step: (o: Order) => Outcome): Promise<Outcome> => {
    const o = orders.get(id);
    if (!o) return refuse('unknown-order');
    return step(o);
  };

  const host: Host = {
    async create(id) {
      if (orders.has(id)) return refuse('order-exists');
      orders.set(id, { status: 'draft', items: 0, charges: 0, refunds: 0 });
      return ok();
    },

    addItem: (id) => withOrder(id, (o) => {
      if (o.status !== 'draft') return refuse('not-a-draft');
      if (o.items >= MAX_ITEMS) return refuse('draft-full');
      o.items += 1;
      return ok();
    }),

    removeItem: (id) => withOrder(id, (o) => {
      if (o.status !== 'draft') return refuse('not-a-draft');
      if (o.items <= 0) return refuse('draft-empty');
      o.items -= 1;
      return ok();
    }),

    place: (id) => withOrder(id, (o) => {
      if (o.status !== 'draft') return refuse('not-a-draft');
      if (o.items < 1) return refuse('draft-empty');
      o.status = 'placed';
      o.charges += 1;
      requestCharge(id, o.items);
      return ok();
    }),

    ship: (id) => withOrder(id, (o) => {
      if (o.status !== 'paid') return refuse('not-paid');
      o.status = 'shipped';
      return ok();
    }),

    cancel: (id) => withOrder(id, (o) => {
      if (o.status === 'draft') {
        o.status = 'cancelled';
        return ok();
      }
      if (o.status === 'paid') {
        o.status = 'cancelled';
        // The refund is counted; it awaits no answer, so it is never pending.
        o.refunds += 1;
        return ok();
      }
      if (o.status === 'placed') {
        // The charge's answer decides whether a refund is owed.
        o.status = 'cancelling';
        return ok();
      }
      return refuse(`order-${o.status}`);
    }),

    retryPayment: (id) => withOrder(id, (o) => {
      if (o.status !== 'declined') return refuse('not-declined');
      o.status = 'placed';
      o.charges += 1;
      requestCharge(id, o.items);
      return ok();
    }),

    async order(id) {
      const o = orders.get(id);
      return o ? { ...o } : null;
    },

    async pendingEffects() {
      return [...pending.values()].map((e) => ({ ...e, data: { ...e.data } }));
    },

    async completeEffect(id, outcome) {
      const effect = pending.get(id);
      if (!effect) return;
      pending.delete(id);
      const o = orders.get(effect.from);
      if (!o) return;
      if (o.status === 'cancelling') {
        o.status = 'cancelled';
        if (outcome === 'ok') o.refunds += 1;
        return;
      }
      if (o.status !== 'placed') return;
      if (outcome === 'ok') o.status = 'paid';
      // Only the first charge may be retried.
      else o.status = o.charges < MAX_CHARGES ? 'declined' : 'failed';
    },
  };

  return host;
};

export default createHost;
