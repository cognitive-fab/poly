// AC21 (PD6-A5, PS16.3) on the concierge: a refund outside the staff member's innermost mandate is denied
// outside-mandate though the merchant's grant covers its scope, and one outside the grant is denied insufficient-scope
// though the mandate covers it, on the tenth refund as on the first. The grant is checked first, then the mandate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleWith } from './runtime-helpers.mjs';
import { concierge, REFUNDS, verdicts } from './concierge-refund-helpers.mjs';

const MIN = 60_000;
const mandate = (id, delegator, delegate, scope, expires) => ({ id, delegator, delegate, scope, expires });

async function tenRefunds(c, amountOf) {
  handleWith(c.rt, 'payments.refund', async (p, { api }) => ({ status: (await api.post(REFUNDS, `amount=${p.amount}`)).status }));
  await c.grant('merchant-1');
  const app = await c.ticket('alice');
  for (let i = 0; i < 10; i++) {
    await c.rt.dispatch(app, 'Refund', { merchant: 'merchant-1', amount: amountOf(i) }, { credentials: { role: 'Agent', principal: 'agent-1' }, actionId: `refund-${i}` });
    await c.rt.advance();
  }
  return verdicts(c.rt, app);
}

test('AC21: outside the innermost mandate is outside-mandate though the grant covers the scope, on the tenth refund as on the first', { timeout: 300_000 }, async () => {
  let now = 0;
  let chain = [];
  const c = await concierge('ac21-mandate', { evidence: () => ({ verifiedAt: now, statusAt: now, mandates: chain }) });
  try {
    now = c.clock.now();
    chain = [mandate('m1', 'owner', 'lead-1', { actions: ['payments.refund'], max: { amount: 300 } }, now + 60 * MIN), mandate('m2', 'lead-1', 'agent-1', { actions: ['payments.refund'], max: { amount: 100 } }, now + 30 * MIN)];
    const v = await tenRefunds(c, (i) => (i === 0 || i === 9 ? 200 : 50));
    assert.deepEqual(v.filter(([o]) => o === 'denied'), [['denied', 'outside-mandate'], ['denied', 'outside-mandate']]);
    assert.equal(v.filter(([o]) => o === 'allowed').length, 8);
    assert.equal(c.sent.filter((q) => q.url === REFUNDS).length, 8);
  } finally { await c.rt.close(); }
});

test('AC21: outside the grant is insufficient-scope though the mandate covers it, on the tenth refund as on the first', { timeout: 300_000 }, async () => {
  let now = 0;
  let chain = [];
  const c = await concierge('ac21-grant', { scope: 'charges.read', evidence: () => ({ verifiedAt: now, statusAt: now, mandates: chain }) });
  try {
    now = c.clock.now();
    chain = [mandate('m1', 'owner', 'agent-1', { actions: ['payments.refund'], max: { amount: 100 } }, now + 60 * MIN)];
    const v = await tenRefunds(c, () => 50);
    assert.deepEqual(v, Array.from({ length: 10 }, () => ['denied', 'insufficient-scope']));
    assert.equal(c.sent.filter((q) => q.url === REFUNDS).length, 0);
  } finally { await c.rt.close(); }
});
