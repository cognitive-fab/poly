// The stateful core of one order: a pure transition function.
// The host wraps it with the order map and the effect port.

export const MAX_ITEMS = 3;
/** A declined first charge may be retried once: at most this many charges per order. */
export const MAX_CHARGES = 2;

export type Status = 'none' | 'draft' | 'placed' | 'paid' | 'shipped' | 'cancelled' | 'declined' | 'failed';

export interface OrderState {
  status: Status;
  items: number;
  charges: number;
  refunds: number;
  /** Charges requested and not yet answered. */
  pending: number;
}

export type Action =
  | 'create'
  | 'addItem'
  | 'removeItem'
  | 'place'
  | 'ship'
  | 'cancel'
  | 'retryPayment'
  | 'chargeOk'
  | 'chargeFailed';

export type EffectRequest = { kind: 'payment.charge'; data: { amount: number } } | { kind: 'payment.refund'; data: { amount: number } };

export type StepResult =
  | { ok: true; next: OrderState; effect?: EffectRequest }
  | { ok: false; reason: string };

export const INITIAL: OrderState = { status: 'none', items: 0, charges: 0, refunds: 0, pending: 0 };

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
      return { ok: true, next: { ...s, status: 'shipped' } };
    case 'cancel':
      if (s.status === 'draft') return { ok: true, next: { ...s, status: 'cancelled' } };
      if (s.status === 'paid') {
        return {
          ok: true,
          next: { ...s, status: 'cancelled', refunds: s.refunds + 1 },
          effect: { kind: 'payment.refund', data: { amount: s.items } },
        };
      }
      if (s.status === 'placed') return refuse('payment in progress');
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
      // order no longer placed changes nothing else.
      if (s.pending <= 0) return refuse('no charge pending');
      // A failed first charge declines the order (retryable); a failed retry fails it.
      const failed: Status = s.charges < MAX_CHARGES ? 'declined' : 'failed';
      const status = s.status !== 'placed' ? s.status : action === 'chargeOk' ? 'paid' : failed;
      return { ok: true, next: { ...s, status, pending: s.pending - 1 } };
    }
    default:
      return refuse('unknown action');
  }
}
