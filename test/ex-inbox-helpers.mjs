// plan-ex.md E2.2: the inbox assistant admitted, loaded and connected over recorded traffic only. The module is the
// draft in docs/ex/inbox-draft until the example checks resolve std, profiles and route files (decisions-ex.md). Both
// credentials' vaults are the runtime's and speak to a fake Google token endpoint whose tokens the test makes; the Gmail
// source replays the recorded tapes through the runtime's handles for the read credential, one grant per account
// (S461); every decision is answered by a recorded provider. No test reaches Google or calls a model.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admit } from '@poly/check';
import { oauthVault, kmsStore, credentialIngress, gmailSource, memoryMailStore } from '@poly/io';
import { grantRequestSubject, signRecord } from '@poly/core';
import { ROOT } from './helpers.mjs';
import { PERSON, loaded, makeKey, project, signPolicies } from './runtime-helpers.mjs';

export const DRAFT = join(ROOT, 'docs', 'ex', 'inbox-draft');
export const SOURCE = readFileSync(join(DRAFT, 'inbox.poly.draft'), 'utf8');
export const POLICY = readFileSync(join(DRAFT, 'inbox.policy.poly.draft'), 'utf8');
export const GOOGLE = JSON.parse(readFileSync(join(ROOT, 'std', 'credentials', 'providers', 'google.json'), 'utf8'));
export const ACCOUNTS = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'inbox', 'corpus.json'), 'utf8')).accounts;
export const tape = (label) => JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'traffic', 'gmail', `${label}.json`), 'utf8'));
export const host = await import(pathToFileURL(join(ROOT, 'examples', 'inbox', 'host', 'inbox.mjs')).href);

function memoryWrap() {
  const key = randomBytes(32);
  return {
    wrap(p) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const b = Buffer.concat([c.update(p), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]); },
    unwrap(x) { const b = Buffer.from(x); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]); },
  };
}

/**
 * S460: the draft with a holder-less read credential, which has one grant and so reaches one mailbox. The draft itself
 * names gmail_read with holder Principal, one grant per account (S461).
 */
export const SOURCE_ONE_GRANT = (() => {
  const nl = SOURCE.includes('\r\n') ? '\r\n' : '\n';
  const from = ['  scopes { gmail.readonly }', '  holder Principal'].join(nl);
  assert.equal(SOURCE.split(from).length, 2, from);
  return SOURCE.split(from).join('  scopes { gmail.readonly }');
})();

/** The draft as a project: the module, its policy (signed by a person), and its price tables and maps. */
export async function admittedInbox(name, { source = SOURCE, policy = POLICY } = {}) {
  const key = makeKey(name);
  const dir = project(name, [], key, 'test-ex-inbox');
  writeFileSync(join(dir, 'src', 'inbox.poly'), source);
  writeFileSync(join(dir, 'src', 'inbox.policy.poly'), policy);
  cpSync(join(DRAFT, 'prices'), join(dir, 'src', 'prices'), { recursive: true });
  cpSync(join(DRAFT, 'maps'), join(dir, 'src', 'maps'), { recursive: true });
  const cfg = JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8'));
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...cfg, credentials: { gmail_draft: { store: 'kms' }, gmail_read: { store: 'kms' } } }, null, 2));
  await signPolicies(dir);
  const r = await admit(dir);
  assert.ok(r.certificatePath, `the inbox is admitted: ${JSON.stringify(r.certificate ?? r).slice(0, 3000)}`);
  return { dir, key, build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } };
}

/**
 * A recorded provider for the inbox's decisions: each answer is chosen by the message or thread the decision's items
 * hold, by the item ids it was given, so a test scripts answers per message id. `answers(decision, ids, tier)` gives
 * `{ answer, p, cites? }`, or throws for a question the test did not expect.
 */
export function recordedInbox(answers) {
  const asked = [];
  const ask = (q, m, tier) => {
    const ids = Object.values(m?.items ?? {}).flat().map((i) => i.id).sort();
    asked.push({ decision: q.decision, tier: tier ?? null, ids });
    const a = answers(q.decision, ids, tier);
    return { answer: a.answer, distribution: [[a.answer, a.p ?? 0.97]], ...(a.cites ? { cites: a.cites } : {}), usage: a.usage ?? { input: 400, output: 10 }, reported: tier === 'large' ? 'opus-2026-08' : 'flash-2026-09', latencyMs: 0 };
  };
  return {
    asked,
    tiers: { small: (q, m) => ask(q, m, 'small'), large: (q, m) => ask(q, m, 'large') },
    decision: (q, m) => ask(q, m, null),
  };
}

/**
 * The inbox loaded over a store file. Both credentials' vaults are the runtime's, each with a grant per account
 * (PS16.2): the compose credential's, and the read credential's (S461), so revoking one account's read grant stops that
 * account's sync and no other. The Gmail source is built with the runtime's routing handle for gmail_read, and each
 * account syncs through its owner's handle, rt.credentialHandle('gmail_read', owner). With `oneGrant` (S460, one
 * account, SOURCE_ONE_GRANT) the read credential has one grant, requested by the person's signed grant request, and the
 * account syncs through the one handle. Both vaults speak to a fake Google token endpoint; the Gmail API answers each
 * request from the tape of the account whose token the vault attached; and the recorded providers answer every
 * decision. `tokens` makes each token the endpoint issues, so a canary can be put in one.
 */
export async function inbox(a, { db, tapes, answers, tokens = (k) => `${k}-${randomBytes(18).toString('base64url')}`, mailStore = memoryMailStore(), oneGrant = false, accounts: chosen = ACCOUNTS }) {
  const { rt, clock } = await loaded(a, { store: { sqlite: db } });
  const issued = [];
  // The Gmail API, from the tapes: the first unused exchange of the account with the same method and URL answers.
  const left = Object.entries(tapes).flatMap(([label, exchanges]) => exchanges.map((e) => ({ ...e, label, used: false })));
  const seen = [];
  const gmail = async (q, label) => {
    seen.push({ method: q.method, url: q.url, label, auth: Object.keys(q.headers ?? {}).some((h) => h.toLowerCase() === 'authorization') });
    const e = left.find((x) => !x.used && x.request.method === q.method && x.request.url === q.url && x.label === label);
    if (!e) throw new Error(`no recorded exchange for ${q.method} ${q.url} (${label})`);
    e.used = true;
    return { status: e.response.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(e.response.body) };
  };
  // Each access token the endpoint issues, and the account whose consent it was issued for.
  const tokenOf = new Map();
  let consenting = null;
  const google = {
    async request(q) {
      if (q.url === GOOGLE.token) {
        const at = tokens('at');
        const rt_ = tokens('rt');
        issued.push(at, rt_);
        tokenOf.set(at, consenting);
        return { status: 200, headers: {}, body: JSON.stringify({ access_token: at, refresh_token: rt_, token_type: 'Bearer', expires_in: 3599 }) };
      }
      if (q.url === GOOGLE.revocation) return { status: 200, headers: {}, body: '' };
      const auth = Object.entries(q.headers ?? {}).find(([h]) => h.toLowerCase() === 'authorization')?.[1] ?? '';
      return gmail(q, tokenOf.get(String(auth).replace(/^Bearer /, '')) ?? null);
    },
  };
  const client = { clientId: 'inbox', redirectUri: 'https://inbox.example/credentials', clientSecret: randomBytes(24).toString('base64url') };
  const drafts = oauthVault(GOOGLE, client, kmsStore(memoryWrap()), { http: google });
  const reads = oauthVault(GOOGLE, client, kmsStore(memoryWrap()), { http: google });
  rt.connectVault('gmail_draft', drafts);
  rt.connectVault('gmail_read', reads);
  const callback = credentialIngress(rt, { gmail_draft: drafts, gmail_read: reads }, () => rt.now());
  const consent = async (c, url, label) => {
    consenting = label;
    const res = await callback(c, { method: 'GET', url: `https://inbox.example/credentials/${c}?code=c-${randomBytes(6).toString('hex')}&state=${new URL(url).searchParams.get('state')}`, headers: {}, body: '' });
    consenting = null;
    assert.equal(res.status, 200, `the ${c} grant of ${label}`);
  };
  if (oneGrant) {
    assert.equal(chosen.length, 1, 'a source credential\'s one grant reaches one mailbox (S460)');
    // S457, PT10g: a person's credential with no holder is requested by the person's signed grant request, which fixes
    // the account's principal as its holder; the runtime makes the authorization URL, and the person consents.
    const approvals = join(dirname(db), 'approvals');
    mkdirSync(approvals, { recursive: true });
    const record = signRecord({ kind: 'grant-request', subject: grantRequestSubject('gmail_read', chosen[0].owner), by: PERSON.keyId, at: '2026-10-10T00:00:00.000Z' }, PERSON.privateKeyPem);
    writeFileSync(join(approvals, '00-read-grant.json'), JSON.stringify({ kind: 'grant-request', credential: 'gmail_read', holder: chosen[0].owner, record }));
    const taken = await rt.takeApprovals(approvals);
    assert.deepEqual(taken.map((x) => x.outcome), ['applied'], JSON.stringify(taken));
    await consent('gmail_read', rt.takeAuthorizations().find((x) => x.credential === 'gmail_read').url, chosen[0].label);
  }
  for (const acct of chosen) {
    await consent('gmail_draft', await rt.requestGrant('gmail_draft', acct.owner), acct.label);
    if (!oneGrant) await consent('gmail_read', await rt.requestGrant('gmail_read', acct.owner), acct.label);
  }
  // S461: each account syncs through its owner's handle; the adapter is built with the routing handle.
  const accounts = chosen.map((acct) => (oneGrant ? { owner: acct.owner, label: acct.label } : { owner: acct.owner, label: acct.label, request: rt.credentialHandle('gmail_read', acct.owner).request }));
  const source = gmailSource({ accounts, transport: rt.credentialHandle('gmail_read'), store: mailStore });
  rt.connectSource('mail', source);
  const p = recordedInbox(answers);
  rt.provideTier('small', p.tiers.small);
  rt.provideTier('large', p.tiers.large);
  for (const d of ['summary', 'when', 'write']) rt.provide(d, { provider: p.decision, model: 'flash-2026-09' });
  const settle = async (n = 30) => { for (let i = 0; i < n; i++) await rt.worker.tick(); };
  return { rt, clock, source, accounts, provider: p, issued, seen, left, settle };
}
