// plan-ex.md E1, S462: what the concierge's refund tests share. The orders table has the charge column the source's
// `charge` key reads (S451), and a fake Stripe answers a charge's read and a refund from the fixture's paid amounts.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { pgOrders } from './memory-helpers.mjs';

export const CHARGES_URL = 'https://api.stripe.com/v1/charges/';

export function memoryWrap() {
  const key = randomBytes(32);
  return {
    wrap(p) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const b = Buffer.concat([c.update(p), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]); },
    unwrap(x) { const b = Buffer.from(x); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]); },
  };
}

/** The fixture's orders as rows of the orders table, with the Stripe charge each was paid with. */
export const orderRows = (fixture) => fixture.orders.map((o) => ({ order_id: o.id, customer_id: o.owner, updated_at: o.asOf, summary: o.body, charge_id: o.charge }));

/** pgOrders, plus the charge column on each row of a retrieval: key_0, as postgresSource's `keys: { charge: 'charge_id' }` reads it. */
export function ordersTable(rows) {
  const base = pgOrders(rows);
  const query = async (text, params) => {
    const r = await base.query(text, params);
    if (text.startsWith('SELECT "order_id" AS id')) r.rows = r.rows.map((x) => ({ ...x, key_0: rows.find((o) => o.order_id === x.id).charge_id }));
    return r;
  };
  return { ...base, query };
}

/**
 * A Stripe over the fixture: the token endpoint (the connected account is `acct_1Merchant`), GET /v1/charges/{id} from
 * the fixture's paid amounts (`override` changes a charge), and POST /v1/refunds. `sent` keeps every request but the
 * token's, with the connected account and the idempotency key it carried.
 */
export function fakeStripe(fixture, profile, override = {}) {
  const paid = Object.fromEntries(fixture.orders.map((o) => [o.charge, { amount: o.paid, amount_refunded: 0, paid: true, ...(override[o.charge] ?? {}) }]));
  const sent = [];
  const http = { async request(q) {
    if (q.url === profile.token) return { status: 200, headers: {}, body: JSON.stringify({ ...JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'traffic', 'stripe', 'token-response.json'), 'utf8')), stripe_user_id: 'acct_1Merchant' }) };
    sent.push({ method: q.method, url: q.url, body: q.body, account: q.headers['stripe-account'], key: q.headers['idempotency-key'] });
    if (q.method === 'GET' && q.url.startsWith(CHARGES_URL)) { const c = paid[q.url.slice(CHARGES_URL.length)]; return { status: c ? 200 : 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify(c ?? {}) }; }
    return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":"re_1","object":"refund","status":"succeeded"}' };
  } };
  return { http, sent };
}
