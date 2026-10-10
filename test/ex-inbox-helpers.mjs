// plan-ex.md E2.2: the inbox assistant admitted, loaded and connected over recorded traffic only. The module is the
// draft in docs/ex/inbox-draft until the example checks resolve std, profiles and route files (decisions-ex.md). The
// vault speaks to a fake Google token endpoint whose tokens the test makes; the Gmail source replays the recorded tapes
// through the vault's withToken, as the host binds it to each account's read grant; every decision is answered by a
// recorded provider. No test reaches Google or calls a model.
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
 * S460 with one account: the draft whose mail source names a holder-less read credential, so the runtime's vault holds
 * the read grant and its Grant instance tracks it. A grant reaches one mailbox; the three accounts of IAC1 stay on the
 * host's read vault until S461 gives an owned source's credential a grant per owner (decisions-ex.md).
 */
export const SOURCE_READ_GRANT = (() => {
  const swap = (src, from, to) => { assert.equal(src.split(from).length, 2, from); return src.split(from).join(to); };
  const nl = SOURCE.includes('\r\n') ? '\r\n' : '\n';
  const read = ['credential gmail_read: oauth2 {', '  provider "google"', '  grant authorization_code pkce', '  scopes { gmail.readonly }', '}', '', 'source mail: records {', '  adapter "gmail"', '  credential gmail_read'].join(nl);
  return swap(SOURCE, ['source mail: records {', '  adapter "gmail"'].join(nl), read);
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
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...cfg, credentials: { gmail_draft: { store: 'kms' }, ...(source.includes('credential gmail_read') ? { gmail_read: { store: 'kms' } } : {}) } }, null, 2));
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
 * The inbox loaded over a store file. The compose credential's vault is the runtime's, with a grant per account. The
 * read grant is the runtime's too when the source names its credential (S460, `readGrant: 'source'`, one account): the
 * Gmail source is built with rt.credentialHandle('gmail_read'). Otherwise (`'host'`, until S461) the read-only grants
 * are the host's own, one per account, in a vault the host keeps. Both vaults speak to a fake Google token endpoint; the
 * Gmail API answers from the tapes; and the recorded providers answer every decision. `tokens` makes each token the
 * endpoint issues, so a canary can be put in one.
 */
export async function inbox(a, { db, tapes, answers, tokens = (k) => `${k}-${randomBytes(18).toString('base64url')}`, mailStore = memoryMailStore(), readGrant = 'host', accounts: chosen = ACCOUNTS }) {
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
  const google = (label) => ({
    async request(q) {
      if (q.url === GOOGLE.token) {
        const at = tokens('at');
        const rt_ = tokens('rt');
        issued.push(at, rt_);
        return { status: 200, headers: {}, body: JSON.stringify({ access_token: at, refresh_token: rt_, token_type: 'Bearer', expires_in: 3599 }) };
      }
      if (q.url === GOOGLE.revocation) return { status: 200, headers: {}, body: '' };
      return gmail(q, label());
    },
  });
  const client = { clientId: 'inbox', redirectUri: 'https://inbox.example/credentials', clientSecret: randomBytes(24).toString('base64url') };
  // The compose credential, the runtime's: one grant per account (PS16.2).
  const drafts = oauthVault(GOOGLE, client, kmsStore(memoryWrap()), { http: google(() => null) });
  rt.connectVault('gmail_draft', drafts);
  let reading = null;
  const reads = oauthVault(GOOGLE, client, kmsStore(memoryWrap()), { http: google(() => reading) });
  if (readGrant === 'source') {
    assert.equal(chosen.length, 1, 'a source credential\'s one grant reaches one mailbox (S460)');
    rt.connectVault('gmail_read', reads);
    reading = chosen[0].label;
  }
  const callback = credentialIngress(rt, readGrant === 'source' ? { gmail_draft: drafts, gmail_read: reads } : { gmail_draft: drafts }, () => rt.now());
  if (readGrant === 'source') {
    // S457, PT10g: a person's credential with no holder is requested by the person's signed grant request, which fixes
    // the account's principal as its holder; the runtime makes the authorization URL, and the person consents.
    const approvals = join(dirname(db), 'approvals');
    mkdirSync(approvals, { recursive: true });
    const record = signRecord({ kind: 'grant-request', subject: grantRequestSubject('gmail_read', chosen[0].owner), by: PERSON.keyId, at: '2026-10-10T00:00:00.000Z' }, PERSON.privateKeyPem);
    writeFileSync(join(approvals, '00-read-grant.json'), JSON.stringify({ kind: 'grant-request', credential: 'gmail_read', holder: chosen[0].owner, record }));
    const taken = await rt.takeApprovals(approvals);
    assert.deepEqual(taken.map((x) => x.outcome), ['applied'], JSON.stringify(taken));
    const url = rt.takeAuthorizations().find((x) => x.credential === 'gmail_read').url;
    const res = await callback('gmail_read', { method: 'GET', url: `https://inbox.example/credentials/gmail_read?code=c-${randomBytes(6).toString('hex')}&state=${new URL(url).searchParams.get('state')}`, headers: {}, body: '' });
    assert.equal(res.status, 200, 'the read grant');
  }
  for (const acct of chosen) {
    const url = await rt.requestGrant('gmail_draft', acct.owner);
    const state = new URL(url).searchParams.get('state');
    const res = await callback('gmail_draft', { method: 'GET', url: `https://inbox.example/credentials/gmail_draft?code=c-${randomBytes(6).toString('hex')}&state=${state}`, headers: {}, body: '' });
    assert.equal(res.status, 200, `the compose grant of ${acct.label}`);
    if (readGrant === 'source') continue;
    // The read-only grants, the host's until S461: one per account, by a grant id the host names.
    const r = await reads.authorize({ grantId: `read:${acct.label}`, scopes: ['gmail.readonly'], now: rt.now() });
    const v = await reads.verify({ method: 'GET', url: `https://inbox.example/credentials?code=c-${randomBytes(6).toString('hex')}&state=${r.state}`, headers: {}, body: '' }, rt.now());
    assert.equal(v.grantId, `read:${acct.label}`, `the read grant of ${acct.label}: ${JSON.stringify(v)}`);
  }
  const accounts = readGrant === 'source'
    ? chosen.map((acct) => ({ owner: acct.owner, label: acct.label }))
    : chosen.map((acct) => ({ owner: acct.owner, label: acct.label, request: async (q) => { reading = acct.label; return reads.withToken(`read:${acct.label}`, q); } }));
  const source = gmailSource(readGrant === 'source' ? { accounts, transport: rt.credentialHandle('gmail_read'), store: mailStore } : { accounts, store: mailStore });
  rt.connectSource('mail', source);
  const p = recordedInbox(answers);
  rt.provideTier('small', p.tiers.small);
  rt.provideTier('large', p.tiers.large);
  for (const d of ['summary', 'when', 'write']) rt.provide(d, { provider: p.decision, model: 'flash-2026-09' });
  const settle = async (n = 30) => { for (let i = 0; i < n; i++) await rt.worker.tick(); };
  return { rt, clock, source, accounts, provider: p, issued, seen, left, settle, reads };
}
