// M9 step 11 (AC18 to AC21): the concierge with a refund through the merchant's delegated credential, admitted,
// loaded and given a vault on the tests' generic provider, with recorded traffic. Every token is generated here, with a
// prefix the test chooses, so the canary scan can look for it. Until E13 the ticket's conversation is created beside
// its application, as the spawn of starts would (PS15.2).
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit } from '@poly/check';
import { withEvidence } from '@poly/runtime';
import { oauthVault, kmsStore, credentialIngress } from '@poly/io';
import { TEST_STD } from './helpers.mjs';
import { loaded, makeKey, project } from './runtime-helpers.mjs';

export const PROVIDER = JSON.parse(readFileSync(join(TEST_STD, 'credentials', 'providers', 'test-oauth.json'), 'utf8'));
export const REFUNDS = 'https://api.test-oauth.example/v1/refunds';

function memoryWrap() {
  const key = randomBytes(32);
  return {
    wrap(p) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const b = Buffer.concat([c.update(p), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]); },
    unwrap(x) { const b = Buffer.from(x); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]); },
  };
}

/**
 * The concierge, admitted and loaded. `evidence()` gives the staff member's evidence for each Refund (PD6: times and
 * mandates); `token()` makes each token the provider issues; `provider(request)` answers each provider call that is
 * not the token endpoint.
 */
export async function concierge(name, opts = {}) {
  const key = makeKey(name);
  const dir = project(name, ['test/fixtures/m9/concierge-refund.poly'], key, 'test-concierge-refund');
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8')), credentials: { payments: { store: 'kms' } } }, null, 2));
  const r = await admit(dir, { std: TEST_STD });
  const verifier = (credentials) => (credentials ? withEvidence({ role: credentials.role ?? 'Agent', principal: credentials.principal ?? 'agent-1' }, (opts.evidence ?? (() => ({})))(credentials)) : null);
  const { rt, clock } = await loaded({ build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } }, { std: TEST_STD, verifier });
  const token = opts.token ?? ((kind) => `${kind}-${randomBytes(24).toString('base64url')}`);
  const issued = [];
  const sent = [];
  const http = {
    async request(q) {
      sent.push(q);
      if (q.url === PROVIDER.token) {
        const body = new URLSearchParams(q.body);
        const access = token('at');
        const refresh = body.get('grant_type') === 'refresh_token' ? null : token('rt');
        issued.push(access, ...(refresh ? [refresh] : []));
        return { status: 200, headers: {}, body: JSON.stringify({ access_token: access, ...(refresh ? { refresh_token: refresh } : {}), token_type: 'Bearer', expires_in: 3600, ...(opts.scope ? { scope: opts.scope } : {}) }) };
      }
      if (q.url === PROVIDER.revocation) return { status: 200, headers: {}, body: '' };
      return opts.provider ? opts.provider(q) : { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `re_${sent.length}`, status: 'succeeded' }) };
    },
  };
  const vault = oauthVault(PROVIDER, { clientId: 'concierge', redirectUri: 'https://concierge.example/credentials/payments', clientSecret: randomBytes(24).toString('base64url') }, kmsStore(memoryWrap()), { http });
  rt.connectVault('payments', vault);
  const callback = credentialIngress(rt, { payments: vault }, () => rt.now());
  return {
    rt, clock, dir, certificate: r.certificatePath, issued, sent,
    /** The merchant consents to the scopes given. */
    async grant(merchant) {
      const url = await rt.requestGrant('payments', merchant);
      const state = new URL(url).searchParams.get('state');
      const a = await callback('payments', { method: 'GET', url: `https://concierge.example/credentials/payments?code=c-${randomBytes(8).toString('hex')}&state=${state}`, headers: {}, body: '' });
      assert.equal(a.status, 200);
      return rt.grantOf('payments', merchant);
    },
    /** A ticket on the customer's thread: the application at its keyed id and its conversation (until E13, unstarted). */
    async ticket(customer) {
      const app = await rt.threadId('support', customer);
      await rt.create('refunds.Ticket', { id: app });
      await rt.create('refunds.support.Conversation', { id: `${app}/support`, creation: { action: 'Open', data: { app } } });
      return app;
    },
    async refund(app, merchant, amount, staff = { role: 'Agent', principal: 'agent-1' }) {
      return rt.dispatch(app, 'Refund', { merchant, amount }, { credentials: staff });
    },
  };
}

/** The decisions on an instance's intents, in order: [outcome, reason]. */
export const verdicts = async (rt, id) => (await rt.chain(id)).filter((e) => e.kind === 'verdict' && e.body.outcome).map((e) => [e.body.outcome, e.body.reason ?? null]);
