// M9 steps 8 and 12: the desk of step 5 with both credentials in the KMS store, loaded and given a vault per
// credential over recorded traffic, for the grant tests and the review's. Every token is generated here.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit } from '@poly/check';
import { oauthVault, kmsStore, credentialIngress } from '@poly/io';
import { TEST_STD } from './helpers.mjs';
import { loaded, makeKey, project, signPolicies } from './runtime-helpers.mjs';

export const GENERIC = JSON.parse(readFileSync(join(TEST_STD, 'credentials', 'providers', 'test-oauth.json'), 'utf8'));
export const secret = (prefix = '') => prefix + randomBytes(24).toString('base64url');
export function memoryWrap() {
  const key = randomBytes(32);
  return {
    wrap(p) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const b = Buffer.concat([c.update(p), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]); },
    unwrap(x) { const b = Buffer.from(x); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]); },
  };
}

/** The desk of step 5, admitted with both credentials in the KMS store, loaded, and given a vault per credential. */
export async function desk(name, poly = {}, sources = ['test/fixtures/m9/credentials.poly']) {
  const key = makeKey(name);
  const dir = project(name, sources, key, 'test-grants');
  if (sources.length > 1) await signPolicies(dir);
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8')), credentials: { payments: { store: 'kms' }, reports: { store: 'kms' } }, ...poly }, null, 2));
  const r = await admit(dir, { std: TEST_STD });
  const { rt, clock } = await loaded({ build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } }, { std: TEST_STD });
  const sent = [];
  const answers = [];
  const http = { async request(q) { sent.push(q); const a = answers.shift(); if (!a) throw new Error(`no recorded answer for ${q.method} ${q.url}`); return a(q); } };
  const vaults = {};
  const stores = {};
  for (const c of ['payments', 'reports']) { stores[c] = kmsStore(memoryWrap()); vaults[c] = oauthVault(GENERIC, { clientId: 'client-1', redirectUri: `https://app.example/credentials/${c}`, clientSecret: secret() }, stores[c], { http }); rt.connectVault(c, vaults[c]); }
  const callback = credentialIngress(rt, vaults, () => rt.now());
  /** The provider's redirect with a code, for a state. */
  const redirect = (credential, state) => callback(credential, { method: 'GET', url: `https://app.example/credentials/${credential}?code=c-${secret()}&state=${state}`, headers: {}, body: '' });
  /** The token endpoint's answer to the next exchange, with the scopes given; the tokens it hands out. */
  const tokenAnswer = (scopes) => {
    const tokens = { access: secret('at-'), refresh: secret('rt-') };
    answers.push(() => ({ status: 200, headers: {}, body: JSON.stringify({ access_token: tokens.access, refresh_token: tokens.refresh, token_type: 'Bearer', expires_in: 3600, scope: scopes.join(' ') }) }));
    return tokens;
  };
  /** The holder consents: the provider redirects with a code, and its token endpoint answers with the scopes given. */
  const grant = async (credential, holder, scopes) => {
    const url = await rt.requestGrant(credential, holder);
    const tokens = tokenAnswer(scopes);
    const a = await redirect(credential, new URL(url).searchParams.get('state'));
    assert.equal(a.status, 200);
    return tokens;
  };
  return { rt, clock, dir, key, sent, answers, vaults, stores, grant, redirect, tokenAnswer, cert: r.certificate };
}
export const verdicts = async (rt, id) => (await rt.chain(id)).filter((e) => e.kind === 'verdict' && e.body.outcome).map((e) => [e.body.outcome, e.body.reason ?? null]);
