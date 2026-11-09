// The desk, in TypeScript: the before of the refund-twice example (S588, docs/examples/refund-twice.md).
//
// THE MISTAKE IS KEPT ON PURPOSE. handleRefund records each refund in the ledger after paying it, and never reads the
// ledger before paying. A customer who writes a second time sends a new message, with a new idempotency key, so Stripe's
// key does not stop it either, and the order is refunded twice. refunds.test.ts passes all the same; twice.test.ts shows
// the second payment. Do not fix this file: it is the example.

import type { StandInStripe } from './stripe-stand-in.ts';

export type Order = { id: string; customer: string; charge: string; amount: number };
export type Ledger = Map<string, string>;

export type RefundRequest = { customer: string; order: string; messageId: string };
export type RefundAnswer = { status: 'refunded'; refundId: string } | { status: 'unknown-order' };

export async function handleRefund(
  request: RefundRequest,
  deps: { orders: Order[]; stripe: StandInStripe; ledger: Ledger },
): Promise<RefundAnswer> {
  const order = deps.orders.find((o) => o.id === request.order && o.customer === request.customer);
  if (!order) return { status: 'unknown-order' };

  // The message's id is the idempotency key, so a message delivered twice is paid once.
  const refund = await deps.stripe.refunds.create(
    { charge: order.charge, amount: order.amount },
    { idempotencyKey: request.messageId },
  );
  deps.ledger.set(order.id, refund.id);
  return { status: 'refunded', refundId: refund.id };
}
