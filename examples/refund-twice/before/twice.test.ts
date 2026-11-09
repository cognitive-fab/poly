// The test nobody wrote (S588). It is not run by `npm test`. It PASSES BECAUSE IT ASSERTS THE BUG: the same customer asks
// for the same order in two messages, and Stripe is called twice, for the full amount each time. It is the record of the
// double payment, not a test the desk should pass. The after (../after) is the same desk in poly, where the check refuses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRefund } from './refunds.ts';
import { standInStripe } from './stripe-stand-in.ts';

test('a customer who writes twice is refunded twice', async () => {
  const deps = { orders: [{ id: '9011', customer: 'ana', charge: 'ch_9011', amount: 450 }], stripe: standInStripe(), ledger: new Map<string, string>() };
  const first = await handleRefund({ customer: 'ana', order: '9011', messageId: 'wamid.1' }, deps);
  // "I still don't see it, please refund me": a new message, so a new idempotency key.
  const second = await handleRefund({ customer: 'ana', order: '9011', messageId: 'wamid.2' }, deps);
  assert.equal(first.status, 'refunded');
  assert.equal(second.status, 'refunded');
  assert.equal(deps.stripe.calls.length, 2, 'two refunds of one order');
  assert.deepEqual(deps.stripe.calls.map((c) => c.amount), [450, 450], 'the full amount each time');
  assert.deepEqual(deps.stripe.calls.map((c) => c.idempotencyKey), ['wamid.1', 'wamid.2'], 'two keys: Stripe cannot join them');
});
