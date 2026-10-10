// plan-ex.md E2.2: the inbox assistant admitted, loaded and connected over recorded traffic only. The module is the
// draft in docs/ex/inbox-draft until the example checks resolve std, profiles and route files (decisions-ex.md). The
// vault speaks to a fake Google token endpoint whose tokens the test makes; the Gmail source replays the recorded tapes
// through the vault's withToken, as the host binds it to each account's read grant; every decision is answered by a
// recorded provider. No test reaches Google or calls a model.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admit } from '@poly/check';
import { oauthVault, kmsStore, credentialIngress, gmailSource, memoryMailStore } from '@poly/io';
import { ROOT } from './helpers.mjs';
import { loaded, makeKey, project, signPolicies } from './runtime-helpers.mjs';

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

/** The draft as a project: the module, its policy (signed by a person), and its price tables and maps. */
export async function admittedInbox(name, { source = SOURCE, policy = POLICY } = {}) {
  const key = makeKey(name);
  const dir = project(name, [], key, 'test-ex-inbox');
  writeFileSync(join(dir, 'src', 'inbox.poly'), source);
  writeFileSync(join(dir, 'src', 'inbox.policy.poly'), policy);
  cpSync(join(DRAFT, 'prices'), join(dir, 'src', 'prices'), { recursive: true });
  cpSync(join(DRAFT, 'maps'), join(dir, 'src', 'maps'), { recursive: true });
  const cfg = JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8'));
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...cfg, credentials: { gmail_draft: { store: 'kms' } } }, null, 2));
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
 * The inbox loaded over a store file. The compose credential's vault is the runtime's, with a grant per account; the
 * read-only grants are the host's own, in a vault the host keeps, since no program effect uses them (decisions-ex.md).
 * Both speak to a fake Google token endpoint; the Gmail source replays the tapes through the read vault's withToken; and
 * the recorded providers answer every decision. `tokens` makes each token the endpoint issues, so a canary can be put
 * in one.
 */
export async function inbox(a, { db, tapes, answers, tokens = (k) => `${k}-${randomBytes(18).toString('base64url')}`, mailStore = memoryMailStore() }) {
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
  const callback = credentialIngress(rt, { gmail_draft: drafts }, () => rt.now());
  // The read-only grants, the host's: one per account, by a grant id the host names.
  let reading = null;
  const reads = oauthVault(GOOGLE, client, kmsStore(memoryWrap()), { http: google(() => reading) });
  for (const acct of ACCOUNTS) {
    const url = await rt.requestGrant('gmail_draft', acct.owner);
    const state = new URL(url).searchParams.get('state');
    const res = await callback('gmail_draft', { method: 'GET', url: `https://inbox.example/credentials/gmail_draft?code=c-${randomBytes(6).toString('hex')}&state=${state}`, headers: {}, body: '' });
    assert.equal(res.status, 200, `the compose grant of ${acct.label}`);
    const r = await reads.authorize({ grantId: `read:${acct.label}`, scopes: ['gmail.readonly'], now: rt.now() });
    const v = await reads.verify({ method: 'GET', url: `https://inbox.example/credentials?code=c-${randomBytes(6).toString('hex')}&state=${r.state}`, headers: {}, body: '' }, rt.now());
    assert.equal(v.grantId, `read:${acct.label}`, `the read grant of ${acct.label}: ${JSON.stringify(v)}`);
  }
  const accounts = ACCOUNTS.map((acct) => ({
    owner: acct.owner,
    label: acct.label,
    request: async (q) => { reading = acct.label; return reads.withToken(`read:${acct.label}`, q); },
  }));
  const source = gmailSource({ accounts, store: mailStore });
  rt.connectSource('mail', source);
  rt.connectSource('threads', source);
  const p = recordedInbox(answers);
  rt.provideTier('small', p.tiers.small);
  rt.provideTier('large', p.tiers.large);
  for (const d of ['summary', 'when', 'write']) rt.provide(d, { provider: p.decision, model: 'flash-2026-09' });
  const settle = async (n = 30) => { for (let i = 0; i < n; i++) await rt.worker.tick(); };
  return { rt, clock, source, accounts, provider: p, issued, seen, left, settle };
}
