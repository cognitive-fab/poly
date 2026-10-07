// M9 step 7 (PT10f, S200, S202, S208): the vault adapters in poly-io, against recorded traffic only. The generic
// provider is the tests' profile test-oauth, written from RFC 6749, RFC 7636 and RFC 7009; Stripe Connect and Google
// are std's profiles. Every token, key and client secret is generated in the test, and none is written to disk except
// the development keychain's key file, which the test writes outside the repository and deletes (as ruled for the CLI
// test's key file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { oauthVault, devKeychain, kmsStore, credentialIngress, madeHere } from '@poly/io';
import { ROOT, TEST_STD } from './helpers.mjs';

const profile = (dir, name) => JSON.parse(readFileSync(join(dir, 'credentials', 'providers', `${name}.json`), 'utf8'));
const GENERIC = profile(TEST_STD, 'test-oauth');
const STRIPE = profile(join(ROOT, 'std'), 'stripe-connect');
const GOOGLE = profile(join(ROOT, 'std'), 'google');
const TRAFFIC = join(ROOT, 'test', 'fixtures', 'traffic');
const recorded = (p) => JSON.parse(readFileSync(join(TRAFFIC, p), 'utf8'));
const secret = (prefix = '') => prefix + randomBytes(24).toString('base64url');
const b64url = (b) => Buffer.from(b).toString('base64url');

/** An in-memory wrapping pair over a key generated here: AES-256-GCM, as a KMS would wrap a data key. */
function memoryWrap() {
  const key = randomBytes(32);
  return {
    wrap(plain) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(plain), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); },
    unwrap(blob) { const b = Buffer.from(blob); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]); },
  };
}

/** A transport that answers from a list of handlers in turn and records each request. */
function transport(...answers) {
  const sent = [];
  return { sent, http: { async request(r) { sent.push(r); const a = answers.shift(); if (!a) throw new Error(`no recorded answer for ${r.method} ${r.url}`); return typeof a === 'function' ? a(r) : a; } } };
}
const ok = (body) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const client = (extra = {}) => ({ clientId: 'client-1', redirectUri: 'https://app.example/credentials/payments', clientSecret: secret('cs-'), ...extra });
const callback = (state, extra = '') => ({ method: 'GET', url: `https://app.example/credentials/payments?code=${encodeURIComponent('code-' + secret())}&state=${encodeURIComponent(state)}${extra}`, headers: {}, body: '' });

/** A vault on the generic provider with a token set granted for g-1, and the tokens it holds. */
async function granted(extra = {}) {
  const tokens = { access: secret('at-'), refresh: secret('rt-') };
  const t = transport(ok({ ...recorded('oauth/token-response.json'), access_token: tokens.access, refresh_token: tokens.refresh, scope: 'refunds.write' }), ...(extra.answers ?? []));
  const store = kmsStore(memoryWrap());
  const v = oauthVault(GENERIC, client(), store, { http: t.http });
  const a = await v.authorize({ grantId: 'g-1', scopes: ['refunds.write', 'charges.read'], now: 1_000 });
  const r = await v.verify(callback(a.state), 2_000);
  assert.deepEqual(r.grantId, 'g-1', JSON.stringify(r));
  return { v, t, store, tokens, a, r };
}

test('RFC 7636: the authorization URL carries the client, the scopes, a fresh state and an S256 challenge, and no secret', async () => {
  const c = client();
  const v = oauthVault(GENERIC, c, kmsStore(memoryWrap()), { http: transport().http });
  const a = await v.authorize({ grantId: 'g-1', scopes: ['refunds.write', 'charges.read'], now: 1_000 });
  const u = new URL(a.url);
  assert.equal(`${u.origin}${u.pathname}`, GENERIC.authorization);
  const q = Object.fromEntries(u.searchParams);
  assert.deepEqual([q.response_type, q.client_id, q.redirect_uri, q.scope, q.state, q.code_challenge_method], ['code', 'client-1', c.redirectUri, 'refunds.write charges.read', a.state, 'S256']);
  assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(a.state.length >= 32 && a.until > 1_000);
  assert.ok(!a.url.includes(c.clientSecret));
  const b = await v.authorize({ grantId: 'g-2', scopes: ['charges.read'], now: 1_000 });
  assert.notEqual(b.state, a.state);
});

test('PT10f: Google\'s scopes are sent as its scope URLs, with access_type=offline; Stripe\'s with no PKCE', async () => {
  const g = oauthVault(GOOGLE, client(), kmsStore(memoryWrap()), { http: transport().http });
  const q = Object.fromEntries(new URL((await g.authorize({ grantId: 'g', scopes: ['gmail.readonly', 'gmail.send'], now: 0 })).url).searchParams);
  assert.deepEqual([q.scope, q.access_type, q.code_challenge_method], ['https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send', 'offline', 'S256']);
  const s = oauthVault(STRIPE, client(), kmsStore(memoryWrap()), { http: transport().http });
  const p = Object.fromEntries(new URL((await s.authorize({ grantId: 's', scopes: ['read_write'], now: 0 })).url).searchParams);
  assert.deepEqual([p.scope, p.code_challenge, p.response_type], ['read_write', undefined, 'code']);
});

test('RFC 6749 section 4.1.3: the callback exchanges the code with the PKCE verifier, keeps the tokens encrypted, and returns only the grant and its scopes', async () => {
  const { t, store, tokens, r, a } = await granted();
  assert.deepEqual([r.grantId, r.scopes, r.nonce.key], ['g-1', ['refunds.write'], a.state]);
  assert.ok(!JSON.stringify(r).includes(tokens.access) && !JSON.stringify(r).includes(tokens.refresh));
  const body = Object.fromEntries(new URLSearchParams(t.sent[0].body));
  assert.equal(t.sent[0].url, GENERIC.token);
  assert.equal(body.grant_type, 'authorization_code');
  // The verifier sent is the one whose S256 is the challenge in the authorization URL.
  const challenge = new URL(a.url).searchParams.get('code_challenge');
  assert.equal(b64url(createHash('sha256').update(body.code_verifier).digest()), challenge);
  // The store holds a record, and no blob it keeps holds a token in the clear.
  assert.ok(await store.get('grant:g-1'));
  assert.ok(!JSON.stringify(store.blobs ? [...store.blobs.values()].map((b) => Buffer.from(b).toString('latin1')) : []).includes(tokens.access));
});

test('RFC 6749 section 5.1: with no scope in the token response, the scopes granted are those requested', async () => {
  const t = transport(ok({ ...recorded('oauth/token-response.json'), access_token: secret(), refresh_token: secret() }));
  const v = oauthVault(GENERIC, client(), kmsStore(memoryWrap()), { http: t.http });
  const a = await v.authorize({ grantId: 'g-1', scopes: ['refunds.write', 'charges.read'], now: 0 });
  assert.deepEqual((await v.verify(callback(a.state), 1)).scopes, ['refunds.write', 'charges.read']);
});

test('S202: an unknown or expired state, an error redirect and a token endpoint refusal are refused, and nothing is kept', async () => {
  const v = oauthVault(GENERIC, client(), kmsStore(memoryWrap()), { http: transport({ status: 400, headers: {}, body: JSON.stringify(recorded('oauth/error-invalid-grant.json')) }).http });
  const a = await v.authorize({ grantId: 'g-1', scopes: ['refunds.write'], now: 0 });
  assert.match((await v.verify(callback('not-a-state'), 1)).refused, /state/);
  assert.match((await v.verify(callback(a.state, '&error=access_denied'), 1)).refused, /access_denied/);
  // The state is used once: the error redirect took it.
  assert.match((await v.verify(callback(a.state), 1)).refused, /unknown state/);
  const late = await v.authorize({ grantId: 'g-3', scopes: ['refunds.write'], now: 0 });
  assert.match((await v.verify(callback(late.state), late.until + 1)).refused, /expired/);
  const b = await v.authorize({ grantId: 'g-2', scopes: ['refunds.write'], now: 0 });
  assert.match((await v.verify(callback(b.state), 1)).refused, /invalid_grant/);
});

test('RFC 6749 section 6: a refresh keeps the refresh token when none is returned; invalid_grant is { valid: false }; a 503 is a failure to retry', async () => {
  const fresh = secret('at2-');
  const { v, t, tokens } = await granted({ answers: [ok({ access_token: fresh, token_type: 'example', expires_in: 3600 }), { status: 503, headers: {}, body: '' }, { status: 400, headers: {}, body: JSON.stringify(recorded('oauth/error-invalid-grant.json')) }] });
  assert.deepEqual(await v.refresh('g-1'), { valid: true });
  const body = Object.fromEntries(new URLSearchParams(t.sent[1].body));
  assert.deepEqual([body.grant_type, body.refresh_token], ['refresh_token', tokens.refresh]);
  await assert.rejects(v.refresh('g-1'), /503/);
  // The first refresh returned no refresh token, so the second sends the one granted.
  assert.equal(new URLSearchParams(t.sent[2].body).get('refresh_token'), tokens.refresh);
  assert.deepEqual(await v.refresh('g-1'), { valid: false });
  // invalid_grant forgets the tokens: the grant is expired, and only a new authorization renews it.
  assert.deepEqual(await v.refresh('g-1'), { valid: false });
});

test('RFC 7009: revoke posts the refresh token with its hint, and forgets the grant; Stripe deauthorizes the account', async () => {
  const { v, t, tokens } = await granted({ answers: [{ status: 200, headers: {}, body: '' }] });
  await v.revoke('g-1');
  assert.equal(t.sent[1].url, GENERIC.revocation);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(t.sent[1].body)), { token: tokens.refresh, token_type_hint: 'refresh_token' });
  await assert.rejects(v.withToken('g-1', { method: 'GET', url: 'https://api.test-oauth.example/v1/refunds', headers: {}, body: '' }), /no grant/);
  const c = client();
  const st = transport(ok({ ...recorded('stripe/token-response.json'), stripe_user_id: 'acct_1Abc' }), ok({ stripe_user_id: 'acct_1Abc' }));
  const s = oauthVault(STRIPE, c, kmsStore(memoryWrap()), { http: st.http });
  const a = await s.authorize({ grantId: 's-1', scopes: ['read_write'], now: 0 });
  assert.deepEqual((await s.verify(callback(a.state), 1)).scopes, ['read_write']);
  await s.revoke('s-1');
  assert.equal(st.sent[1].url, STRIPE.revocation);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(st.sent[1].body)), { client_id: 'client-1', stripe_user_id: 'acct_1Abc' });
  assert.equal(st.sent[1].headers.authorization, `Bearer ${c.clientSecret}`);
});

test('PT22.5: withToken attaches the credential inside the adapter, only under the profile\'s bases, and strips token-bearing headers from the answer', async () => {
  const { v, t, tokens } = await granted({ answers: [{ status: 200, headers: { 'set-cookie': 'sid=x', authorization: 'Bearer leak', 'content-type': 'application/json' }, body: '{"id":"re_1"}' }] });
  const res = await v.withToken('g-1', { method: 'POST', url: 'https://api.test-oauth.example/v1/refunds', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'amount=1' });
  assert.equal(t.sent[1].headers.authorization, `Bearer ${tokens.access}`);
  assert.deepEqual(res, { status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":"re_1"}' });
  await assert.rejects(v.withToken('g-1', { method: 'GET', url: 'https://evil.example/v1/refunds', headers: {}, body: '' }), /outside/);
  await assert.rejects(v.withToken('g-1', { method: 'GET', url: 'https://api.test-oauth.example/v1/x', headers: { authorization: 'Bearer mine' }, body: '' }), /authorization/);
  // Stripe: the platform's key and the connected account's header (S208).
  const c = client();
  const st = transport(ok({ ...recorded('stripe/token-response.json'), stripe_user_id: 'acct_1Abc' }), ok({ id: 're_1' }));
  const s = oauthVault(STRIPE, c, kmsStore(memoryWrap()), { http: st.http });
  const a = await s.authorize({ grantId: 's-1', scopes: ['read_write'], now: 0 });
  await s.verify(callback(a.state), 1);
  await s.withToken('s-1', { method: 'POST', url: 'https://api.stripe.com/v1/refunds', headers: {}, body: 'charge=ch_1' });
  assert.deepEqual([st.sent[1].headers.authorization, st.sent[1].headers['stripe-account']], [`Bearer ${c.clientSecret}`, 'acct_1Abc']);
});

test('S200: the KMS store keeps ciphertext only, and the development keychain encrypts under a key read from an absolute file: path', async () => {
  const kms = kmsStore(memoryWrap());
  const at = secret('at-');
  await kms.put('g', { access: at });
  assert.deepEqual(await kms.get('g'), { access: at });
  await kms.remove('g');
  assert.equal(await kms.get('g'), null);
  const tmp = mkdtempSync(join(tmpdir(), 'poly-vault-'));
  try {
    const keyFile = join(tmp, 'vault.key');
    writeFileSync(keyFile, randomBytes(32).toString('hex'));
    const dir = join(tmp, 'blobs');
    const dev = devKeychain({ key: `file:${keyFile}`, dir: `file:${dir}` });
    assert.equal(dev.kind, 'dev-keychain');
    await dev.put('g', { access: at });
    assert.deepEqual(await dev.get('g'), { access: at });
    for (const f of readdirSync(dir)) assert.ok(!readFileSync(join(dir, f), 'latin1').includes(at), 'a blob holds the token in the clear');
    // Another key cannot read it.
    writeFileSync(keyFile, randomBytes(32).toString('hex'));
    await assert.rejects(devKeychain({ key: `file:${keyFile}`, dir: `file:${dir}` }).get('g'));
    assert.throws(() => devKeychain({ key: 'vault.key' }), /file:/);
    assert.throws(() => devKeychain({ key: 'file:relative/vault.key' }), /absolute/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('S182, PT10f: a vault adapter is frozen and made here', () => {
  const v = oauthVault(GENERIC, client(), kmsStore(memoryWrap()), { http: transport().http });
  assert.ok(madeHere(v) && Object.isFrozen(v));
  assert.ok(!madeHere({ ...v }));
  assert.throws(() => oauthVault(GENERIC, { clientId: '', redirectUri: 'https://app.example/cb' }, kmsStore(memoryWrap()), {}), /clientId/);
});

test('S202: the callback route takes the state once, records the outcome, and hands the grant and its scopes to the host', async () => {
  const t = transport(ok({ ...recorded('oauth/token-response.json'), access_token: secret(), refresh_token: secret(), scope: 'refunds.write' }));
  const v = oauthVault(GENERIC, client(), kmsStore(memoryWrap()), { http: t.http });
  const taken = new Set();
  const records = [];
  const grants = [];
  const host = {
    async claimNonce(scope, key) { const k = `${scope}|${key}`; if (taken.has(k)) return false; taken.add(k); return true; },
    async credentialRecord(credential, r) { records.push([credential, r.outcome, r.reason ?? null]); },
    async grantCallback(credential, grantId, scopes) { grants.push([credential, grantId, scopes]); },
  };
  const handle = credentialIngress(host, { payments: v }, () => 5);
  const a = await v.authorize({ grantId: 'g-1', scopes: ['refunds.write'], now: 0 });
  const w = callback(a.state);
  assert.equal((await handle('payments', w)).status, 200);
  assert.deepEqual(grants, [['payments', 'g-1', ['refunds.write']]]);
  // A replay of the same redirect is refused: its state was taken.
  assert.equal((await handle('payments', w)).status, 401);
  assert.equal((await handle('nowhere', w)).status, 404);
  assert.deepEqual(records.map((r) => r[1]), ['granted', 'refused']);
  assert.ok(!JSON.stringify(records).includes(a.state));
});

// ── PT10f, S200: the certificate names each credential's vault; production refuses the development keychain ──
import { admit } from '@poly/check';
import { makeKey, project, loaded } from './runtime-helpers.mjs';

async function vaultProject(name, poly) {
  const key = makeKey(name);
  const dir = project(name, ['test/fixtures/m9/stripe-refund.poly'], key, 'test-vault');
  const manifest = JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8'));
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...manifest, ...poly }, null, 2));
  return { dir, key, run: () => admit(dir) };
}

test('S200: admission binds each credential\'s vault in the certificate, by store and by the adapter package', { timeout: 300_000 }, async () => {
  const p = await vaultProject('vault-kms', { credentials: { payments: { store: 'kms' } } });
  const r = await p.run();
  assert.equal(r.verdict, 'CLEAN');
  const [v] = r.certificate.poly.vaults;
  assert.deepEqual([v.credential, v.store, v.package], ['payments', 'kms', '@poly/io']);
  assert.match(v.digest, /^sha256:[0-9a-f]{64}$/);
  // The runtime takes only a vault the certified package made, of the certified store (PL6408).
  const { rt } = await loaded({ build: join(p.dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [p.key.id]: p.key.publicKey } });
  try {
    const kms = oauthVault(STRIPE, client(), kmsStore(memoryWrap()), { http: transport().http });
    assert.throws(() => rt.connectVault('payments', { ...kms }), /PL6408/);
    assert.throws(() => rt.connectVault('nowhere', kms), /no credential nowhere/);
    const tmp = mkdtempSync(join(tmpdir(), 'poly-vault-'));
    try {
      writeFileSync(join(tmp, 'k'), randomBytes(32).toString('hex'));
      const dev = oauthVault(STRIPE, client(), devKeychain({ key: `file:${join(tmp, 'k')}` }), { http: transport().http });
      assert.throws(() => rt.connectVault('payments', dev), /PL6408.*dev-keychain/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
    rt.connectVault('payments', kms);
  } finally { await rt.close(); }
});

test('S200, PL6826: a production build refuses the development keychain, and a credential with no store is refused', { timeout: 300_000 }, async () => {
  await assert.rejects((await vaultProject('vault-prod', { production: true, credentials: { payments: { store: 'dev-keychain' } } })).run(), /PL6826/);
  assert.equal((await (await vaultProject('vault-dev', { credentials: { payments: { store: 'dev-keychain' } } })).run()).verdict, 'CLEAN');
  await assert.rejects((await vaultProject('vault-none', {})).run(), /credential payments names no store/);
  await assert.rejects((await vaultProject('vault-bad', { credentials: { payments: { store: 'keychain' } } })).run(), /dev-keychain/);
});

test('PT10f: std\'s Google and Stripe profiles are well formed, and a malformed optional field is refused', async () => {
  const { profileProblem } = await import('@poly/core');
  assert.equal(profileProblem(GOOGLE, 'google'), null);
  assert.equal(profileProblem(STRIPE, 'stripe-connect'), null);
  assert.match(profileProblem({ ...GOOGLE, scopeValues: { 'gmail.delete': 'x' } }, 'google'), /scope values/);
  assert.match(profileProblem({ ...GOOGLE, attach: 'cookie' }, 'google'), /attaches/);
  assert.match(profileProblem({ ...STRIPE, revocationStyle: 'none' }, 'stripe-connect'), /revokes/);
});
