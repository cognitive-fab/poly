// The tests the desk's author wrote and stopped at (S588). They all pass, so `npm test` is green and the change merges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRefund, type Order } from './refunds.ts';
import { standInStripe } from './stripe-stand-in.ts';

const orders: Order[] = [
  { id: '9011', customer: 'ana', charge: 'ch_9011', amount: 450 },
  { id: '9012', customer: 'ben', charge: 'ch_9012', amount: 80 },
];

function desk() {
  return { orders, stripe: standInStripe(), ledger: new Map<string, string>() };
}

test('a request for a known order of its customer issues one refund of its amount', async () => {
  const deps = desk();
  const answer = await handleRefund({ customer: 'ana', order: '9011', messageId: 'wamid.1' }, deps);
  assert.deepEqual(answer, { status: 'refunded', refundId: 're_1' });
  assert.equal(deps.stripe.calls.length, 1);
  assert.equal(deps.stripe.calls[0].charge, 'ch_9011');
  assert.equal(deps.stripe.calls[0].amount, 450);
});

test('a request for another customer\'s order, or for no order, is refused and pays nothing', async () => {
  const deps = desk();
  assert.deepEqual(await handleRefund({ customer: 'ana', order: '9012', messageId: 'wamid.2' }, deps), { status: 'unknown-order' });
  assert.deepEqual(await handleRefund({ customer: 'ana', order: '0000', messageId: 'wamid.3' }, deps), { status: 'unknown-order' });
  assert.equal(deps.stripe.calls.length, 0);
});

test('the ledger holds the refund under the order', async () => {
  const deps = desk();
  const answer = await handleRefund({ customer: 'ben', order: '9012', messageId: 'wamid.4' }, deps);
  assert.equal(answer.status, 'refunded');
  assert.equal(deps.ledger.get('9012'), 're_1');
});

test('the same message delivered twice pays once, since its key stops the second', async () => {
  const deps = desk();
  await handleRefund({ customer: 'ana', order: '9011', messageId: 'wamid.5' }, deps);
  await handleRefund({ customer: 'ana', order: '9011', messageId: 'wamid.5' }, deps);
  assert.equal(deps.stripe.calls.length, 1);
});
