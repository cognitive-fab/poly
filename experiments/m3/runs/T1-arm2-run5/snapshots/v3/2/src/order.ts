// The stateful core: one order's lifecycle as a pure transition function.

export type Status = 'draft' | 'placed' | 'paid' | 'shipped' | 'cancelling' | 'cancelled' | 'declined' | 'failed';

export interface OrderState {
  status: Status;
  items: number;
  charges: number;
  refunds: number;
  /** Held back from shipping by the warehouse; only a paid order is ever held. */
  held: boolean;
}

export type Command = 'addItem' | 'removeItem' | 'place' | 'ship' | 'cancel' | 'retryPayment' | 'hold' | 'release';
export type Answer = 'chargeOk' | 'chargeFailed';

/** An effect a step asks for: a charge (answered later) or a refund (counted only). */
export type Request = { kind: 'payment.charge'; data: { amount: number } } | { kind: 'payment.refund'; data: { amount: number } };

export type Step =
  | { ok: true; state: OrderState; requests: Request[] }
  | { ok: false; reason: string };

export const MAX_ITEMS = 3;
/** The first charge plus one retry. */
export const MAX_CHARGES = 2;

export function created(): OrderState {
  return { status: 'draft', items: 0, charges: 0, refunds: 0, held: false };
}

const refuse = (reason: string): Step => ({ ok: false, reason });

export function step(s: OrderState, command: Command): Step {
  switch (command) {
    case 'addItem':
      if (s.status !== 'draft') return refuse(`order is ${s.status}, not a draft`);
      if (s.items >= MAX_ITEMS) return refuse(`a draft holds at most ${MAX_ITEMS} items`);
      return { ok: true, state: { ...s, items: s.items + 1 }, requests: [] };
    case 'removeItem':
      if (s.status !== 'draft') return refuse(`order is ${s.status}, not a draft`);
      if (s.items <= 0) return refuse('the draft holds no item');
      return { ok: true, state: { ...s, items: s.items - 1 }, requests: [] };
    case 'place':
      if (s.status !== 'draft') return refuse(`order is ${s.status}, not a draft`);
      if (s.items <= 0) return refuse('cannot place an empty order');
      return {
        ok: true,
        state: { ...s, status: 'placed', charges: s.charges + 1 },
        requests: [{ kind: 'payment.charge', data: { amount: s.items } }],
      };
    case 'ship':
      if (s.status !== 'paid') return refuse(`order is ${s.status}, not paid`);
      return { ok: true, state: { ...s, status: 'shipped' }, requests: [] };
    case 'cancel':
      if (s.status === 'draft') return { ok: true, state: { ...s, status: 'cancelled' }, requests: [] };
      if (s.status === 'paid') {
        return {
          ok: true,
          state: { ...s, status: 'cancelled', refunds: s.refunds + 1 },
          requests: [{ kind: 'payment.refund', data: { amount: s.items } }],
        };
      }
      // The charge is in progress: its answer decides whether a refund is owed.
      if (s.status === 'placed') return { ok: true, state: { ...s, status: 'cancelling' }, requests: [] };
      return refuse(`order is ${s.status}`);
    case 'retryPayment':
      if (s.status !== 'declined') return refuse(`order is ${s.status}, not declined`);
      if (s.charges >= MAX_CHARGES) return refuse('the payment was already retried');
      return {
        ok: true,
        state: { ...s, status: 'placed', charges: s.charges + 1 },
        requests: [{ kind: 'payment.charge', data: { amount: s.items } }],
      };
  }
}

/**
 * The provider's answer to the order's charge; an order neither placed nor cancelling ignores it.
 * A failed first charge declines the order (it may be retried); a failed retry fails it.
 * A cancelling order is cancelled either way, and refunded if the charge went through.
 */
export function answer(s: OrderState, a: Answer): { state: OrderState; requests: Request[] } {
  if (s.status === 'cancelling') {
    if (a === 'chargeFailed') return { state: { ...s, status: 'cancelled' }, requests: [] };
    return {
      state: { ...s, status: 'cancelled', refunds: s.refunds + 1 },
      requests: [{ kind: 'payment.refund', data: { amount: s.items } }],
    };
  }
  if (s.status !== 'placed') return { state: s, requests: [] };
  if (a === 'chargeOk') return { state: { ...s, status: 'paid' }, requests: [] };
  return { state: { ...s, status: s.charges < MAX_CHARGES ? 'declined' : 'failed' }, requests: [] };
}
