import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SupportAgent } from '../src/agent.ts';
import { Ledger } from '../src/ledger.ts';
import { loadOrders } from '../src/orders.ts';
import type { Refund, RefundRequest, StripeClient } from '../src/stripe.ts';

export const ORDERS_PATH = fileURLToPath(new URL('../orders.json', import.meta.url));
export const ADA = '15550100001'; // owns ORD-1001 (BLENDER-1 $60 + CUPS-4 $40)
export const BEN = '15550100002'; // owns ORD-1002
export const STRANGER = '15559999999';
export const TODAY = new Date('2026-10-16T12:00:00Z');

export interface FakeStripe extends StripeClient {
  calls: RefundRequest[];
  fail: Error | null;
  status: string;
}

export function fakeStripe(): FakeStripe {
  const refunds = new Map<string, Refund>();
  const stripe: FakeStripe = {
    calls: [],
    fail: null,
    status: 'succeeded',
    async createRefund(req) {
      stripe.calls.push(req);
      if (stripe.fail) throw stripe.fail;
      // Mimic Stripe's idempotency: same key returns the same refund.
      const existing = refunds.get(req.idempotencyKey);
      if (existing) return existing;
      const refund = { id: `re_test_${refunds.size + 1}`, status: stripe.status, amount: req.amount };
      refunds.set(req.idempotencyKey, refund);
      return refund;
    },
  };
  return stripe;
}

export function makeAgent(opts: { now?: () => Date; ledger?: Ledger; stripe?: FakeStripe } = {}) {
  const stripe = opts.stripe ?? fakeStripe();
  const ledger = opts.ledger ?? new Ledger();
  const agent = new SupportAgent({
    getOrders: () => loadOrders(ORDERS_PATH),
    ledger,
    stripe,
    refundWindowDays: 30,
    now: opts.now ?? (() => TODAY),
  });
  return { agent, stripe, ledger };
}

export function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

export function webhookPayload(from: string, id: string, text: string | null): string {
  const message =
    text === null
      ? { from, id, timestamp: '1760000000', type: 'image', image: { id: 'img1' } }
      : { from, id, timestamp: '1760000000', type: 'text', text: { body: text } };
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: 'PNID' },
              contacts: [{ profile: { name: 'Customer' }, wa_id: from }],
              messages: [message],
            },
          },
        ],
      },
    ],
  });
}
