// plan-ex.md E2.2, S460 and S461 (PS17.0, PT10j, PS16.4): the inbox's mail source names its read credential, so the
// runtime's vault holds every read grant, a Grant instance tracks each, and the Gmail source is built with the runtime's
// handle (rt.credentialHandle), never with a token or a vault of the host's. Under S460 a holder-less credential has one
// grant and reaches one mailbox; under S461 the draft's gmail_read names holder Principal, one grant per account, and
// each account syncs through its owner's handle. Recorded traffic only: the corpus's Gmail tapes and a fake token
// endpoint whose tokens the test makes. No test reaches Google or calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gmailSource, memoryMailStore } from '@poly/io';
import { ACCOUNTS, SOURCE_ONE_GRANT, admittedInbox, host, inbox, tape } from './ex-inbox-helpers.mjs';

const answers = (decision) => {
  if (decision === 'triage') return { answer: 'Fyi', p: 0.97 };
  if (decision === 'kind') return { answer: 'Other', p: 0.97 };
  throw new Error(`no recorded answer for ${decision}`);
};
const cleanup = async (rt, dir) => {
  await rt.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* the store's file may stay locked a moment on Windows */ }
};

test('S460: with one grant, the inbox syncs through the runtime\'s handle for its read credential, and revoking the grant stops the sync', { timeout: 600_000 }, async () => {
  const a = await admittedInbox('ex-inbox-one-grant', { source: SOURCE_ONE_GRANT });
  const dir = mkdtempSync(join(tmpdir(), 'poly-ex-inbox-'));
  const w = tape('work');
  const work = ACCOUNTS.find((x) => x.label === 'work');
  const { rt, source, accounts, seen, issued, settle } = await inbox(a, { db: join(dir, 'store.db'), tapes: { work: [...w.initial, ...w.poll] }, answers, oneGrant: true, accounts: [work] });
  try {
    // The certificate binds a vault for the read credential, as for the compose credential (PT10f).
    assert.deepEqual(rt.verified.certificate.poly.vaults.map((v) => v.credential).sort(), ['gmail_draft', 'gmail_read']);
    // An adapter the host built over its own request function is refused for a source that names a credential (PL6408).
    assert.throws(() => rt.connectSource('mail', gmailSource({ accounts: [{ owner: work.owner, label: 'work', request: async () => ({ status: 500, headers: {}, body: '' }) }], store: memoryMailStore() })), /PL6408/);

    const first = await host.syncAccount(rt, source, accounts[0]);
    assert.ok(first.created.length > 0, 'the first sync made Messages');
    assert.ok(seen.length > 0 && seen.every((q) => q.auth && q.label === 'work' && q.url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/')), 'every Gmail request went through the vault, which attached the token');
    await settle();
    assert.ok(issued.length > 0);
    const kept = rt.store.db.prepare('SELECT state FROM pr_instance').all().map((r) => r.state).join('\n');
    assert.ok(!issued.some((t) => kept.includes(t)), 'no token in what the runtime keeps');

    // PS16.4: from the step that records Revoked, the source sends nothing, its sync included.
    await rt.revokeGrant('gmail_read', null, { source: 'provider' });
    await rt.advance();
    const before = seen.length;
    await assert.rejects(host.syncAccount(rt, source, accounts[0]), /credential-unavailable/);
    assert.equal(seen.length, before, 'no request reached Gmail after the revocation');
    // The compose grant of the account is untouched: it is another credential's grant.
    assert.ok(rt.grantOf('gmail_draft', work.owner));
  } finally { await cleanup(rt, dir); }
});

test('S461: three accounts, each syncing under its own read grant; revoking one stops only that account\'s sync, and the other two still sync', { timeout: 600_000 }, async () => {
  const a = await admittedInbox('ex-inbox-owner-grants');
  const dir = mkdtempSync(join(tmpdir(), 'poly-ex-inbox-'));
  const w = tape('work');
  const { rt, source, accounts, seen, settle } = await inbox(a, { db: join(dir, 'store.db'), tapes: { work: [...w.initial, ...w.poll], home: [...tape('home').initial, ...tape('home').quiet], club: [...tape('club').initial, ...tape('club').quiet] }, answers });
  try {
    const [work, home, club] = ['work', 'home', 'club'].map((l) => accounts.find((x) => x.label === l));
    // One read grant per owner (PT10g, S461), each its own Grant instance.
    const grants = [work, home, club].map((x) => rt.grantOf('gmail_read', x.owner));
    assert.ok(grants.every(Boolean) && new Set(grants).size === 3, JSON.stringify(grants));
    // An adapter built with one owner's handle is refused: it would send every owner's requests under that one grant.
    assert.throws(() => rt.connectSource('mail', gmailSource({ accounts: [{ owner: work.owner, label: 'work' }], transport: rt.credentialHandle('gmail_read', work.owner), store: memoryMailStore() })), /PL6408/);

    for (const x of [work, home, club]) await host.syncAccount(rt, source, x);
    await settle();
    // Each account's requests reached Gmail under its own token: the fake answers each from its token's account.
    for (const l of ['work', 'home', 'club']) assert.ok(seen.some((q) => q.label === l && q.auth), `${l} synced under its own grant`);
    assert.ok(seen.every((q) => q.auth && q.label !== null), 'no request went out under a token of no account');

    // PS16.4: revoking work's read grant stops work's sync, and only work's.
    await rt.revokeGrant('gmail_read', work.owner, { source: 'provider' });
    await rt.advance();
    const before = seen.length;
    await assert.rejects(host.syncAccount(rt, source, work), /credential-unavailable/);
    assert.equal(seen.length, before, 'no request of work reached Gmail after its revocation');
    for (const x of [home, club]) {
      const n = seen.length;
      await host.syncAccount(rt, source, x);
      assert.ok(seen.length > n && seen.slice(n).every((q) => q.label === x.label && q.auth), `${x.label} still syncs under its own grant`);
    }
    // The compose grants stand: they are another credential's.
    for (const x of [work, home, club]) assert.ok(rt.grantOf('gmail_draft', x.owner));
  } finally { await cleanup(rt, dir); }
});
