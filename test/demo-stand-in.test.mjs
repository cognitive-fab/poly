// DAC9 (DB6): the Stripe stand-in applies the documented behaviour of refunds and Idempotency-Key, keeps a log without secrets, and
// applies a fault script. Nothing here leaves the machine: the TLS server listens on the loopback with a throwaway authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { createStripe } from '../demo/stand-in/stripe/stripe.mjs';
import { createAuthority } from '../demo/stand-in/stripe/tls.mjs';
import { startStandIn } from '../demo/stand-in/stripe/server.mjs';
import { createStripeIgnoringKeys } from './fixtures/demo/mutants/stripe-ignores-key.mjs';

const CHARGES = [{ id: 'ch_demo_1001', amount: 10000, currency: 'usd' }, { id: 'ch_demo_1002', amount: 2500, currency: 'usd' }];
const AUTH = { authorization: 'Bearer sk_test_standin_synthetic' };
const refund = (stripe, params, headers = {}) => stripe.handle({ method: 'POST', path: '/v1/refunds', headers: { ...AUTH, ...headers }, body: new URLSearchParams(params).toString() });

// ---- the behaviour, without a socket ---------------------------------------------------------------------------------------

test('DAC9: a refund creates one object, raises amount_refunded on the charge and shows it on GET', () => {
  const s = createStripe({ charges: CHARGES });
  const r = refund(s, { charge: 'ch_demo_1001', amount: '4000' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.object, r.body.amount, r.body.charge, r.body.status], ['refund', 4000, 'ch_demo_1001', 'succeeded']);
  const c = s.handle({ method: 'GET', path: '/v1/charges/ch_demo_1001', headers: AUTH });
  assert.deepEqual([c.body.amount, c.body.amount_refunded, c.body.refunded], [10000, 4000, false]);
  assert.equal(s.refunds().length, 1);
});

test('DAC9: an amount over what is left is refused, a charge with nothing left is charge_already_refunded, an unknown charge is 404', () => {
  const s = createStripe({ charges: CHARGES });
  assert.equal(refund(s, { charge: 'ch_demo_1002', amount: '3000' }).status, 400);
  assert.equal(refund(s, { charge: 'ch_demo_1002' }).body.amount, 2500, 'no amount means all that is left');
  const again = refund(s, { charge: 'ch_demo_1002' });
  assert.equal(again.body.error.code, 'charge_already_refunded');
  assert.equal(refund(s, { charge: 'ch_nope', amount: '1' }).status, 404);
  assert.equal(s.refunds().length, 1, 'only the accepted request made a refund');
});

test('DAC9: a request with no Authorization header is refused (401)', () => {
  const s = createStripe({ charges: CHARGES });
  assert.equal(s.handle({ method: 'POST', path: '/v1/refunds', headers: {}, body: 'charge=ch_demo_1001&amount=1' }).status, 401);
});

test('DAC9, DB6: a repeated key with the same parameters creates one refund and returns the first response, marked as replayed', () => {
  const s = createStripe({ charges: CHARGES });
  const first = refund(s, { charge: 'ch_demo_1001', amount: '4000' }, { 'idempotency-key': 'k1' });
  const again = refund(s, { charge: 'ch_demo_1001', amount: '4000' }, { 'idempotency-key': 'k1' });
  assert.equal(s.refunds().length, 1);
  assert.deepEqual(again.body, first.body);
  assert.equal(again.headers['idempotent-replayed'], 'true');
  assert.equal(first.headers['idempotent-replayed'], undefined);
  assert.equal(s.charge('ch_demo_1001').amount_refunded, 4000);
});

test('DAC9: the parameters are compared whatever their order, and a repeated key with other parameters is an idempotency_error that refunds nothing', () => {
  const s = createStripe({ charges: CHARGES });
  refund(s, { charge: 'ch_demo_1001', amount: '4000' }, { 'idempotency-key': 'k1' });
  assert.equal(refund(s, { amount: '4000', charge: 'ch_demo_1001' }, { 'idempotency-key': 'k1' }).headers['idempotent-replayed'], 'true');
  const other = refund(s, { charge: 'ch_demo_1001', amount: '5000' }, { 'idempotency-key': 'k1' });
  assert.equal(other.status, 400);
  assert.equal(other.body.error.type, 'idempotency_error');
  assert.equal(s.refunds().length, 1);
});

test('DAC9: a fresh key on each retry is no key at all: two refunds', () => {
  const s = createStripe({ charges: CHARGES });
  refund(s, { charge: 'ch_demo_1001', amount: '4000' }, { 'idempotency-key': 'attempt-1' });
  refund(s, { charge: 'ch_demo_1001', amount: '4000' }, { 'idempotency-key': 'attempt-2' });
  assert.equal(s.refunds().length, 2);
  assert.equal(s.charge('ch_demo_1001').amount_refunded, 8000);
});

test('DB6: the first response is saved whether it succeeded or failed, and a key is kept for 24 hours', () => {
  let t = 1_700_000_000_000;
  const s = createStripe({ charges: CHARGES, now: () => t });
  const bad = refund(s, { charge: 'ch_demo_1002', amount: '9999' }, { 'idempotency-key': 'k-bad' });
  assert.equal(bad.status, 400);
  t += 60_000;
  const replay = refund(s, { charge: 'ch_demo_1002', amount: '9999' }, { 'idempotency-key': 'k-bad' });
  assert.deepEqual([replay.status, replay.headers['idempotent-replayed']], [400, 'true']);
  const ok = refund(s, { charge: 'ch_demo_1001', amount: '100' }, { 'idempotency-key': 'k-old' });
  t += 24 * 60 * 60 * 1000 + 1;
  const afterDay = refund(s, { charge: 'ch_demo_1001', amount: '100' }, { 'idempotency-key': 'k-old' });
  assert.notEqual(afterDay.body.id, ok.body.id, 'after 24 hours the key is gone and the request is new');
});

test('DB6: a GET ignores a key', () => {
  const s = createStripe({ charges: CHARGES });
  const r = s.handle({ method: 'GET', path: '/v1/charges/ch_demo_1001', headers: { ...AUTH, 'idempotency-key': 'k' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['idempotent-replayed'], undefined);
});

test('DAC8: the mutant that ignores the key refunds twice where the stand-in refunds once (the difference the control must see)', () => {
  const real = createStripe({ charges: CHARGES });
  const mutant = createStripeIgnoringKeys({ charges: CHARGES });
  for (const s of [real, mutant]) for (let i = 0; i < 2; i++) refund(s, { charge: 'ch_demo_1001', amount: '4000' }, { 'idempotency-key': 'same' });
  assert.deepEqual([real.refunds().length, mutant.refunds().length], [1, 2]);
});

// ---- the server, the log and the fault script --------------------------------------------------------------------------------

function call(standIn, authority, { host = 'api.stripe.com', method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: standIn.port, method, path, ca: authority.ca, servername: host, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withStandIn(options, fn) {
  const authority = createAuthority();
  const standIn = await startStandIn({ authority, charges: CHARGES, ...options });
  try { return await fn(standIn, authority); } finally { await standIn.close(); authority.remove(); }
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded', ...AUTH };

test('DB6: the stand-in answers for api.stripe.com under the throwaway authority, and the log keeps no secret', async () => {
  await withStandIn({}, async (s, authority) => {
    const r = await call(s, authority, { method: 'POST', path: '/v1/refunds', headers: { ...FORM, 'idempotency-key': 'k1' }, body: 'charge=ch_demo_1001&amount=4000' });
    assert.equal(r.status, 200);
    const log = s.log();
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].method, log[0].path, log[0].key, log[0].authorization, log[0].applied], ['POST', '/v1/refunds', 'k1', 'Bearer', true]);
    assert.ok(!JSON.stringify(log).includes('sk_test_standin_synthetic'), 'the authorization value is not in the log');
  });
});

test('DB6 item 5: lost-answer applies the first POST /v1/refunds and resets the connection; every later request is normal', async () => {
  await withStandIn({ fault: 'lost-answer' }, async (s, authority) => {
    await assert.rejects(call(s, authority, { method: 'POST', path: '/v1/refunds', headers: FORM, body: 'charge=ch_demo_1001&amount=4000' }), (e) => /socket hang up|ECONNRESET|reset/i.test(String(e.message) + String(e.code)));
    assert.equal(s.report().refunds, 1, 'the refund was applied though its answer was lost');
    const second = await call(s, authority, { method: 'POST', path: '/v1/refunds', headers: FORM, body: 'charge=ch_demo_1001&amount=4000' });
    assert.equal(second.status, 200, 'the second request is normal');
    const r = s.report();
    assert.deepEqual([r.requests, r.refunds, r.amountRefunded.ch_demo_1001], [2, 2, 8000]);
    assert.deepEqual(r.posts.map((p) => p.fault), ['reset', null]);
  });
});

test('DB6 item 5: the same lost answer with the same key refunds once', async () => {
  await withStandIn({ fault: 'lost-answer' }, async (s, authority) => {
    const headers = { ...FORM, 'idempotency-key': 'stable' };
    await assert.rejects(call(s, authority, { method: 'POST', path: '/v1/refunds', headers, body: 'charge=ch_demo_1001&amount=4000' }));
    const second = await call(s, authority, { method: 'POST', path: '/v1/refunds', headers, body: 'charge=ch_demo_1001&amount=4000' });
    assert.equal(second.headers['idempotent-replayed'], 'true');
    assert.deepEqual([s.report().refunds, s.report().amountRefunded.ch_demo_1001], [1, 4000]);
  });
});

test('DB6 item 5: a held connection is applied, gets no answer, and is dropped after its time', async () => {
  const script = { name: 'hold-short', rules: [{ host: 'api.stripe.com', method: 'POST', path: '/v1/refunds', nth: 1, then: 'hold', ms: 150 }] };
  await withStandIn({ fault: script }, async (s, authority) => {
    const started = Date.now();
    await assert.rejects(call(s, authority, { method: 'POST', path: '/v1/refunds', headers: FORM, body: 'charge=ch_demo_1002&amount=100' }));
    assert.ok(Date.now() - started >= 140, 'the connection was held');
    assert.equal(s.report().refunds, 1);
  });
});

test('DB6 item 6: the WhatsApp sink records the reply the customer got, and the report has the five numbers', async () => {
  await withStandIn({}, async (s, authority) => {
    await call(s, authority, { method: 'POST', path: '/v1/refunds', headers: FORM, body: 'charge=ch_demo_1001&amount=4000' });
    await call(s, authority, { host: 'graph.facebook.com', method: 'POST', path: '/v19.0/100000000000001/messages', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: '15550100001', text: { body: 'Your refund is issued.' } }) });
    const r = s.report();
    assert.deepEqual(Object.keys(r).sort(), ['amount', 'amountRefunded', 'fault', 'posts', 'refunds', 'reply', 'requests']);
    assert.deepEqual([r.requests, r.posts.length, r.refunds, r.amountRefunded.ch_demo_1001, r.reply], [1, 1, 1, 4000, ['Your refund is issued.']]);
  });
});

test('Q10: the stand-in has no outward connection: it listens on the loopback and its code opens none', async () => {
  await withStandIn({}, async (s) => assert.equal(s.host, '127.0.0.1'));
  const { readFileSync } = await import('node:fs');
  for (const f of ['stripe.mjs', 'server.mjs', 'faults.mjs']) {
    const text = readFileSync(new URL(`../demo/stand-in/stripe/${f}`, import.meta.url), 'utf8');
    assert.ok(!/\b(fetch|https?\.request|https?\.get|net\.connect|tls\.connect)\s*\(/.test(text), `${f} opens no connection`);
  }
});
