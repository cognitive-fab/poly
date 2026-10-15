// Step 9 (DF5, DB6, Q10): the development vault and the stand-in's Connect side. The concierge's credential is a Stripe Connect grant,
// so the demo runs a vault that holds a synthetic token that only the stand-in accepts: made at start, held in memory, written
// nowhere. The stand-in answers the Connect token endpoint and, when it is given a token, refuses every other bearer. In-process
// requests go through the same handler as the TLS listener, so every request is in the stand-in's log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAuthority } from '../demo/stand-in/stripe/tls.mjs';
import { startStandIn } from '../demo/stand-in/stripe/server.mjs';
import { developmentHttp, mintDevelopmentToken } from '../demo/host/vault.mjs';

const CHARGES = [{ id: 'ch_demo9011', amount: 12000, currency: 'usd' }];
const TOKEN = 'tok-synthetic-for-the-test-0001';
const ACCOUNT = 'acct_demo';

async function withStandIn(fn, options = {}) {
  const authority = createAuthority();
  const standIn = await startStandIn({ authority, charges: CHARGES, connect: { accessToken: TOKEN, account: ACCOUNT }, ...options });
  try { return await fn(standIn); } finally { await standIn.close(); authority.remove(); }
}

const api = (standIn, { token = TOKEN, account = ACCOUNT, method = 'GET', path = '/v1/charges/ch_demo9011', body = '', headers = {} } = {}) =>
  standIn.call({ host: 'api.stripe.com', method, path, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(account ? { 'stripe-account': account } : {}), ...headers }, body });

test('DF5: the stand-in accepts only the synthetic token, with the connected account, and refuses any other', async () => {
  await withStandIn(async (s) => {
    assert.equal((await api(s)).status, 200);
    assert.equal((await api(s, { token: 'sk_test_someone_elses_key' })).status, 401);
    assert.equal((await api(s, { token: null })).status, 401);
    assert.equal((await api(s, { account: 'acct_other' })).status, 403);
  });
});

test('DF5: the Connect token endpoint gives the synthetic token and the connected account, and deauthorize ends it', async () => {
  await withStandIn(async (s) => {
    const r = await s.call({ host: 'connect.stripe.com', method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code&code=ac_synthetic' });
    assert.equal(r.status, 200);
    const t = JSON.parse(r.body);
    assert.deepEqual([t.token_type, t.livemode, t.stripe_user_id, t.scope], ['bearer', false, ACCOUNT, 'read_write']);
    assert.equal(t.access_token, TOKEN);
    const d = await s.call({ host: 'connect.stripe.com', method: 'POST', path: '/oauth/deauthorize', headers: {}, body: `client_id=ca_demo&stripe_user_id=${ACCOUNT}` });
    assert.equal(d.status, 200);
    assert.equal((await api(s)).status, 401, 'after deauthorize the token is refused');
  });
});

test('DF5: an in-process request is in the stand-in\'s log, with no token in it', async () => {
  await withStandIn(async (s) => {
    await api(s, { method: 'POST', path: '/v1/refunds', body: 'charge=ch_demo9011&amount=4000', headers: { 'idempotency-key': 'k1', 'content-type': 'application/x-www-form-urlencoded' } });
    const log = s.log();
    assert.deepEqual([log[0].method, log[0].path, log[0].key, log[0].authorization, log[0].applied], ['POST', '/v1/refunds', 'k1', 'Bearer', true]);
    assert.ok(!JSON.stringify(log).includes(TOKEN));
    assert.equal(s.report().refunds, 1);
  });
});

test('DB6 item 5: the fault script reaches an in-process request too: the answer is lost, the refund exists', async () => {
  await withStandIn(async (s) => {
    s.reset({ charges: CHARGES, fault: 'lost-answer' });
    await assert.rejects(api(s, { method: 'POST', path: '/v1/refunds', body: 'charge=ch_demo9011&amount=4000', headers: { 'content-type': 'application/x-www-form-urlencoded' } }), /socket hang up|reset/i);
    assert.equal(s.report().refunds, 1);
  });
});

test('DF5: the development http routes the vault\'s and the runtime\'s requests to the stand-in, and everything else has no route', async () => {
  await withStandIn(async (s) => {
    const http = developmentHttp(s);
    const t = await http.request({ method: 'POST', url: 'https://connect.stripe.com/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code&code=ac_x' });
    assert.equal(t.status, 200);
    const c = await http.request({ method: 'GET', url: 'https://api.stripe.com/v1/charges/ch_demo9011', headers: { authorization: `Bearer ${JSON.parse(t.body).access_token}`, 'stripe-account': ACCOUNT }, body: '' });
    assert.equal(c.status, 200);
    assert.equal(JSON.parse(c.body).amount, 12000);
    await assert.rejects(http.request({ method: 'GET', url: 'https://example.com/', headers: {}, body: '' }), /no route/);
    await assert.rejects(http.request({ method: 'GET', url: 'https://api.anthropic.com/v1/messages', headers: {}, body: '' }), /no route/);
  });
});

test('DF5: the synthetic token is made at start, is not the same twice, and is a string no provider would accept', () => {
  const a = mintDevelopmentToken();
  const b = mintDevelopmentToken();
  assert.notEqual(a, b);
  assert.match(a, /^tok-synthetic-[0-9a-f]{40}$/);
  assert.ok(!/^(sk|rk|pk)_/.test(a), 'it has no Stripe key shape');
});

test('Q10: nothing under demo/host reads a Stripe key or writes the token anywhere', () => {
  for (const f of ['vault.mjs']) {
    const text = readFileSync(new URL(`../demo/host/${f}`, import.meta.url), 'utf8');
    assert.ok(!/process\.env/.test(text), `${f} reads no environment variable`);
    assert.ok(!/(writeFile|appendFile|createWriteStream)/.test(text), `${f} writes no file`);
  }
});
