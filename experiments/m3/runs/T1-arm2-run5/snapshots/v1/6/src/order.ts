// The stateful core: one order's lifecycle as a pure transition function.

export type Status = 'draft' | 'placed' | 'paid' | 'shipped' | 'cancelled' | 'declined' | 'failed';

export interface OrderState {
  status: Status;
  items: number;
  charges: number;
  refunds: number;
}

export type Command = 'addItem' | 'removeItem' | 'place' | 'ship' | 'cancel' | 'retryPayment';
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
  return { status: 'draft', items: 0, charges: 0, refunds: 0 };
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
      if (s.status === 'placed') return refuse('payment is in progress');
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
 * The provider's answer to the order's charge; a non-placed order ignores it.
 * A failed first charge declines the order (it may be retried); a failed retry fails it.
 */
export function answer(s: OrderState, a: Answer): OrderState {
  if (s.status !== 'placed') return s;
  if (a === 'chargeOk') return { ...s, status: 'paid' };
  return { ...s, status: s.charges < MAX_CHARGES ? 'declined' : 'failed' };
}
