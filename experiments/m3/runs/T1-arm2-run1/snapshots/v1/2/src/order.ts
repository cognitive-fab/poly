// The stateful core of one order: a pure transition function over its view.

import type { OrderView } from '../host.ts';

export const MAX_ITEMS = 3;
export const MAX_CHARGES = 2;

export type OrderAction =
  | { type: 'addItem' }
  | { type: 'removeItem' }
  | { type: 'place' }
  | { type: 'ship' }
  | { type: 'cancel' }
  | { type: 'chargeResult'; outcome: 'ok' | 'failed' };

/** What a step asks the outside world to do. */
export type Request = { kind: 'payment.charge'; data: { amount: number } } | { kind: 'payment.refund' };

export type Step =
  | { ok: true; next: OrderView; requests: Request[] }
  | { ok: false; reason: string };

export function initialOrder(): OrderView {
  return { status: 'draft', items: 0, charges: 0, refunds: 0 };
}

const refuse = (reason: string): Step => ({ ok: false, reason });

export function step(o: OrderView, a: OrderAction): Step {
  switch (a.type) {
    case 'addItem':
      if (o.status !== 'draft') return refuse(`order is ${o.status}, not draft`);
      if (o.items >= MAX_ITEMS) return refuse(`draft already holds ${MAX_ITEMS} items`);
      return { ok: true, next: { ...o, items: o.items + 1 }, requests: [] };
    case 'removeItem':
      if (o.status !== 'draft') return refuse(`order is ${o.status}, not draft`);
      if (o.items === 0) return refuse('draft holds no item');
      return { ok: true, next: { ...o, items: o.items - 1 }, requests: [] };
    case 'place':
      if (o.status !== 'draft') return refuse(`order is ${o.status}, not draft`);
      if (o.items === 0) return refuse('draft holds no item');
      return {
        ok: true,
        next: { ...o, status: 'placed', charges: o.charges + 1 },
        requests: [{ kind: 'payment.charge', data: { amount: o.items } }],
      };
    case 'ship':
      if (o.status !== 'paid') return refuse(`order is ${o.status}, not paid`);
      return { ok: true, next: { ...o, status: 'shipped' }, requests: [] };
    case 'cancel':
      if (o.status === 'draft') return { ok: true, next: { ...o, status: 'cancelled' }, requests: [] };
      if (o.status === 'paid') {
        return {
          ok: true,
          next: { ...o, status: 'cancelled', refunds: o.refunds + 1 },
          requests: [{ kind: 'payment.refund' }],
        };
      }
      if (o.status === 'placed') return refuse('payment is in progress');
      return refuse(`order is ${o.status}`);
    case 'retryPayment':
      if (o.status !== 'declined') return refuse(`order is ${o.status}, not declined`);
      return {
        ok: true,
        next: { ...o, status: 'placed', charges: o.charges + 1 },
        requests: [{ kind: 'payment.charge', data: { amount: o.items } }],
      };
    case 'chargeResult': {
      if (o.status !== 'placed') return refuse(`order is ${o.status}, not placed`);
      // A first declined charge may be retried once; a second one is final.
      const status = a.outcome === 'ok' ? 'paid' : o.charges < MAX_CHARGES ? 'declined' : 'failed';
      return { ok: true, next: { ...o, status }, requests: [] };
    }
  }
}
