// M9 step 12, the code review's findings on grants and the vault (PS16, PT10f, PT10g), each a test written before its
// fix and failing on the code it found. The provider is the tests' test-oauth, with recorded traffic only; every
// token is generated here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oauthVault, kmsStore } from '@poly/io';
import { RefusedDispatch } from '@poly/runtime';
import { GENERIC, desk, memoryWrap, secret } from './grants-helpers.mjs';

const revocations = (sent) => sent.filter((q) => q.url === GENERIC.revocation);
const formOf = (q) => Object.fromEntries(new URLSearchParams(q.body));
const ingressOf = async (rt) => (await rt.chain('runtime:ingress')).filter((e) => e.body?.credential).map((e) => e.body);

test('review C1: a grant asked again after it was granted, then revoked before the holder answers, has its tokens revoked and forgotten', { timeout: 300_000 }, async () => {
  const { rt, sent, answers, stores, grant } = await desk('rv-reauth-revoke');
  try {
    const tokens = await grant('payments', 'm-1', ['refunds.write']);
    const id = rt.grantOf('payments', 'm-1');
    await rt.requestGrant('payments', 'm-1');
    assert.equal((await rt.store.getInstance(id)).state.g, 'Requested');
    answers.push(() => ({ status: 200, headers: {}, body: '' }));
    await rt.revokeGrant('payments', 'm-1', { source: 'provider' });
    await rt.advance();
    assert.equal((await rt.store.getInstance(id)).state.g, 'Revoked');
    assert.deepEqual(revocations(sent).map((q) => formOf(q).token), [tokens.refresh]);
    assert.equal(await stores.payments.get(`grant:${id}`), null);
  } finally { await rt.close(); }
});

test('review C2: a callback that arrives after the grant was revoked is refused not-accepted, its tokens revoked at once, and nothing is recorded as granted', { timeout: 300_000 }, async () => {
  const { rt, sent, answers, stores, redirect, tokenAnswer } = await desk('rv-revoke-callback');
  try {
    const state = new URL(await rt.requestGrant('payments', 'm-1')).searchParams.get('state');
    const id = rt.grantOf('payments', 'm-1');
    await rt.revokeGrant('payments', 'm-1', { source: 'security' });
    await rt.advance();
    const tokens = tokenAnswer(['refunds.write']);
    answers.push(() => ({ status: 200, headers: {}, body: '' }));
    const a = await redirect('payments', state);
    assert.equal(a.status, 401);
    assert.equal((await rt.store.getInstance(id)).state.g, 'Revoked');
    assert.equal(await stores.payments.get(`grant:${id}`), null);
    assert.deepEqual(revocations(sent).map((q) => formOf(q).token), [tokens.refresh]);
    const records = (await ingressOf(rt)).filter((r) => r.stage === 'callback');
    assert.deepEqual(records.map((r) => [r.outcome, r.reason ?? null]), [['refused', 'not-accepted']]);
  } finally { await rt.close(); }
});

test('review C8: a grant id belongs to a credential only by its own prefix, never by a longer credential name', { timeout: 300_000 }, async () => {
  const { rt } = await desk('rv-prefix');
  try {
    await assert.rejects(rt.grantCallback('payments', 'grant:paymentsX#1', ['refunds.write']), /is not one of credential payments/);
    await assert.rejects(rt.grantCallback('payments', 'grant:payments-other:x#1', ['refunds.write']), /is not one of credential payments/);
  } finally { await rt.close(); }
});

test('review B2: only the runtime takes a grant\'s transitions; an outside dispatch of each is refused and audited, and TokenExpiring stays the host\'s', { timeout: 300_000 }, async () => {
  const { rt, grant } = await desk('rv-outside');
  try {
    await grant('payments', 'm-1', ['refunds.write']);
    const id = rt.grantOf('payments', 'm-1');
    const granted = { refunds_write: true, charges_read: true };
    for (const [action, data] of [['Callback', { granted }], ['Reauthorize', {}], ['Refreshed', { valid: true }], ['RefreshFailed', {}], ['Revoke', {}]]) {
      await assert.rejects(rt.dispatch(id, action, data), (e) => e instanceof RefusedDispatch && e.rule === 'PS16.4', action);
    }
    assert.equal((await rt.store.getInstance(id)).state.g, 'Granted');
    assert.equal((await rt.audit(id)).filter((x) => x.rule === 'PS16.4').length, 5);
    assert.equal((await rt.dispatch(id, 'TokenExpiring')).stepKind, 'accepted');
    assert.equal((await rt.store.getInstance(id)).state.g, 'Refreshing');
  } finally { await rt.close(); }
});

test('review D4, B7: the runtime keeps each credential as load read it; a descriptor rewritten after load changes nothing', { timeout: 300_000 }, async () => {
  const { rt, dir, cert } = await desk('rv-descriptor');
  try {
    const entry = cert.poly.credentials.find((c) => c.name === 'payments');
    const file = join(dir, entry.descriptor);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), scopes: ['charges.read'] }));
    const scope = new URL(await rt.requestGrant('payments', 'm-1')).searchParams.get('scope');
    assert.deepEqual(scope.split(' ').sort(), ['charges.read', 'refunds.write']);
  } finally { await rt.close(); }
});

test('review (low): a vault for another provider than the credential\'s is refused at connect (PL6408)', { timeout: 300_000 }, async () => {
  const { rt } = await desk('rv-provider');
  try {
    const other = oauthVault({ ...GENERIC, provider: 'other-oauth' }, { clientId: 'client-1', redirectUri: 'https://app.example/credentials/payments', clientSecret: secret() }, kmsStore(memoryWrap()), {});
    assert.throws(() => rt.connectVault('payments', other), /PL6408.*provider/);
  } finally { await rt.close(); }
});

// ── the vault alone ───────────────────────────────────────────────────────────────────────────────────────────

/** A vault over a transport whose answers the test gives, one per request, each a function of the request. */
function vaultWith(store = kmsStore(memoryWrap())) {
  const sent = [];
  const answers = [];
  const http = { async request(q) { sent.push(q); const a = answers.shift(); if (!a) throw new Error(`no recorded answer for ${q.method} ${q.url}`); return a(q); } };
  const v = oauthVault(GENERIC, { clientId: 'client-1', redirectUri: 'https://app.example/credentials/payments', clientSecret: secret() }, store, { http });
  /** The holder consents for a grant id, and the token endpoint answers with this body. */
  const consent = async (grantId, body) => {
    const { state } = await v.authorize({ grantId, scopes: ['refunds.write'], now: 0 });
    answers.push(() => ({ status: 200, headers: {}, body: JSON.stringify(body) }));
    const r = await v.verify({ method: 'GET', url: `https://app.example/credentials/payments?code=c-${secret()}&state=${state}`, headers: {}, body: '' }, 1);
    assert.ok(!('refused' in r), JSON.stringify(r));
  };
  return { v, store, sent, answers, consent };
}

test('review C3: a refresh and a revocation of one grant run one at a time, so the revocation revokes the newest token and nothing is kept after it', async () => {
  const { v, store, sent, answers, consent } = vaultWith();
  await consent('g1', { access_token: secret('at-'), refresh_token: secret('rt-'), scope: 'refunds.write' });
  const fresh = secret('rt-');
  let release;
  const held = new Promise((r) => { release = r; });
  answers.push(async () => { await held; return { status: 200, headers: {}, body: JSON.stringify({ access_token: secret('at-'), refresh_token: fresh }) }; });
  answers.push(() => ({ status: 200, headers: {}, body: '' }));
  const refreshing = v.refresh('g1');
  const revoking = v.revoke('g1');
  await new Promise((r) => setImmediate(r));
  release();
  assert.deepEqual(await refreshing, { valid: true });
  await revoking;
  assert.deepEqual(revocations(sent).map((q) => formOf(q).token), [fresh]);
  assert.equal(await store.get('grant:g1'), null);
});

test('review C4: an exchange that returns no refresh token keeps the one the grant held', async () => {
  const { v, sent, answers, consent } = vaultWith();
  const first = secret('rt-');
  await consent('g1', { access_token: secret('at-'), refresh_token: first, scope: 'refunds.write' });
  await consent('g1', { access_token: secret('at-'), scope: 'refunds.write' });
  answers.push(() => ({ status: 200, headers: {}, body: JSON.stringify({ access_token: secret('at-') }) }));
  assert.deepEqual(await v.refresh('g1'), { valid: true });
  assert.equal(formOf(sent.at(-1)).refresh_token, first);
});

test('review C5: a token set is sealed with its grant id, and one moved under another grant\'s id is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-vault-'));
  const { v, sent, consent } = vaultWith(kmsStore(memoryWrap(), { dir: `file:${dir}` }));
  await consent('g1', { access_token: secret('at-'), refresh_token: secret('rt-'), scope: 'refunds.write' });
  await consent('g2', { access_token: secret('at-'), refresh_token: secret('rt-'), scope: 'refunds.write' });
  const blob = (id) => join(dir, `${createHash('sha256').update(`grant:${id}`, 'utf8').digest('hex')}.bin`);
  copyFileSync(blob('g1'), blob('g2'));
  const before = sent.length;
  await assert.rejects(v.withToken('g2', { method: 'GET', url: 'https://api.test-oauth.example/v1/charges', headers: {} }));
  assert.equal(sent.length, before, 'nothing was sent under the moved token set');
});

test('review C6: a revocation answered 400 invalid_token forgets the token set, since the provider says it is already invalid', async () => {
  const { v, store, answers, consent } = vaultWith();
  await consent('g1', { access_token: secret('at-'), refresh_token: secret('rt-'), scope: 'refunds.write' });
  answers.push(() => ({ status: 400, headers: {}, body: JSON.stringify({ error: 'invalid_token' }) }));
  await v.revoke('g1');
  assert.equal(await store.get('grant:g1'), null);
});
