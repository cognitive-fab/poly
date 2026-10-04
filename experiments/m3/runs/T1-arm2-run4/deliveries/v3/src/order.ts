// The stateful core of one order: a pure transition function.
// The host wraps it with the order map and the effect port.

export const MAX_ITEMS = 3;
/** A declined first charge may be retried once: at most this many charges per order. */
export const MAX_CHARGES = 2;

export type Status = 'none' | 'draft' | 'placed' | 'paid' | 'shipped' | 'cancelling' | 'cancelled' | 'declined' | 'failed';

export interface OrderState {
  status: Status;
  items: number;
  charges: number;
  refunds: number;
  /** Charges requested and not yet answered. */
  pending: number;
  /** Held back from shipping by the warehouse; only a paid order can be held. */
  held: boolean;
}

export type Action =
  | 'create'
  | 'addItem'
  | 'removeItem'
  | 'place'
  | 'ship'
  | 'cancel'
  | 'retryPayment'
  | 'hold'
  | 'release'
  | 'chargeOk'
  | 'chargeFailed';

export type EffectRequest = { kind: 'payment.charge'; data: { amount: number } } | { kind: 'payment.refund'; data: { amount: number } };

export type StepResult =
  | { ok: true; next: OrderState; effect?: EffectRequest }
  | { ok: false; reason: string };

export const INITIAL: OrderState = { status: 'none', items: 0, charges: 0, refunds: 0, pending: 0, held: false };

const refuse = (reason: string): StepResult => ({ ok: false, reason });

export function step(s: OrderState, action: Action): StepResult {
  if (action === 'create') {
    if (s.status !== 'none') return refuse('order already exists');
    return { ok: true, next: { ...s, status: 'draft' } };
  }
  if (s.status === 'none') return refuse('no such order');

  switch (action) {
    case 'addItem':
      if (s.status !== 'draft') return refuse('order is not a draft');
      if (s.items >= MAX_ITEMS) return refuse('draft is full');
      return { ok: true, next: { ...s, items: s.items + 1 } };
    case 'removeItem':
      if (s.status !== 'draft') return refuse('order is not a draft');
      if (s.items <= 0) return refuse('draft is empty');
      return { ok: true, next: { ...s, items: s.items - 1 } };
    case 'place':
      if (s.status !== 'draft') return refuse('order is not a draft');
      if (s.items <= 0) return refuse('draft is empty');
      return {
        ok: true,
        next: { ...s, status: 'placed', charges: s.charges + 1, pending: s.pending + 1 },
        effect: { kind: 'payment.charge', data: { amount: s.items } },
      };
    case 'ship':
      if (s.status !== 'paid') return refuse('order is not paid');
      if (s.held) return refuse('order is held');
      return { ok: true, next: { ...s, status: 'shipped' } };
    case 'hold':
      if (s.status !== 'paid') return refuse('order is not paid');
      if (s.held) return refuse('order is already held');
      return { ok: true, next: { ...s, held: true } };
    case 'release':
      if (!s.held) return refuse('order is not held');
      return { ok: true, next: { ...s, held: false } };
    case 'cancel':
      if (s.status === 'draft') return { ok: true, next: { ...s, status: 'cancelled' } };
      if (s.status === 'paid') {
        return {
          ok: true,
          // A held paid order can be cancelled too; it is then no longer held.
          next: { ...s, status: 'cancelled', refunds: s.refunds + 1, held: false },
          effect: { kind: 'payment.refund', data: { amount: s.items } },
        };
      }
      // The charge is in progress: its answer decides whether to refund.
      if (s.status === 'placed') return { ok: true, next: { ...s, status: 'cancelling' } };
      return refuse(`order is ${s.status}`);
    case 'retryPayment':
      if (s.status !== 'declined') return refuse('order is not declined');
      return {
        ok: true,
        next: { ...s, status: 'placed', charges: s.charges + 1, pending: s.pending + 1 },
        effect: { kind: 'payment.charge', data: { amount: s.items } },
      };
    case 'chargeOk':
    case 'chargeFailed': {
      // A completed charge is no longer pending; an answer that finds the
      // order neither placed nor cancelling changes nothing else.
      if (s.pending <= 0) return refuse('no charge pending');
      if (s.status === 'cancelling') {
        // The charge went through after all: return the money. Otherwise nothing was taken.
        if (action === 'chargeOk') {
          return {
            ok: true,
            next: { ...s, status: 'cancelled', refunds: s.refunds + 1, pending: s.pending - 1 },
            effect: { kind: 'payment.refund', data: { amount: s.items } },
          };
        }
        return { ok: true, next: { ...s, status: 'cancelled', pending: s.pending - 1 } };
      }
      // A failed first charge declines the order (retryable); a failed retry fails it.
      const failed: Status = s.charges < MAX_CHARGES ? 'declined' : 'failed';
      const status = s.status !== 'placed' ? s.status : action === 'chargeOk' ? 'paid' : failed;
      return { ok: true, next: { ...s, status, pending: s.pending - 1 } };
    }
    default:
      return refuse('unknown action');
  }
}
