// plan-ex.md E2.2, S460 (PS17.0, PT10j, PS16.4): the inbox's mail source names its read credential, so the runtime's
// vault holds the read grant, its Grant instance tracks it, and the Gmail source is built with the runtime's handle
// (rt.credentialHandle), never with a token or a request function of the host's. A grant reaches one mailbox, so this
// runs one account; IAC1's three wait for S461, a grant per owner (decisions-ex.md). Recorded traffic only: the work
// account's tapes and a fake token endpoint whose tokens the test makes. No test reaches Google or calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gmailSource, memoryMailStore } from '@poly/io';
import { ACCOUNTS, SOURCE_READ_GRANT, admittedInbox, host, inbox, tape } from './ex-inbox-helpers.mjs';

const answers = (decision) => {
  if (decision === 'triage') return { answer: 'Fyi', p: 0.97 };
  if (decision === 'kind') return { answer: 'Other', p: 0.97 };
  throw new Error(`no recorded answer for ${decision}`);
};

test('S460: the inbox syncs through the runtime\'s handle for its read credential, and revoking the grant stops the sync', { timeout: 600_000 }, async () => {
  const a = await admittedInbox('ex-inbox-read-grant', { source: SOURCE_READ_GRANT });
  const dir = mkdtempSync(join(tmpdir(), 'poly-ex-inbox-'));
  const w = tape('work');
  const work = ACCOUNTS.find((x) => x.label === 'work');
  const { rt, source, accounts, seen, issued, settle } = await inbox(a, { db: join(dir, 'store.db'), tapes: { work: [...w.initial, ...w.poll] }, answers, readGrant: 'source', accounts: [work] });
  try {
    // The certificate binds a vault for the read credential, as for the compose credential (PT10f).
    assert.deepEqual(rt.verified.certificate.poly.vaults.map((v) => v.credential).sort(), ['gmail_draft', 'gmail_read']);
    // An adapter the host built over its own request function is refused for a source that names a credential (PL6408).
    assert.throws(() => rt.connectSource('mail', gmailSource({ accounts: [{ owner: work.owner, label: 'work', request: async () => ({ status: 500, headers: {}, body: '' }) }], store: memoryMailStore() })), /PL6408/);

    const first = await host.syncAccount(rt, source, accounts[0]);
    assert.ok(first.created.length > 0, 'the first sync made Messages');
    assert.ok(seen.length > 0 && seen.every((q) => q.auth && q.url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/')), 'every Gmail request went through the vault, which attached the token');
    await settle();
    assert.ok(issued.length > 0);
    const kept = (rt.store.db.prepare('SELECT state FROM pr_instance').all()).map((r) => r.state).join('\n');
    assert.ok(!issued.some((t) => kept.includes(t)), 'no token in what the runtime keeps');

    // PS16.4: from the step that records Revoked, the source sends nothing, its sync included.
    await rt.revokeGrant('gmail_read', null, { source: 'provider' });
    await rt.advance();
    const before = seen.length;
    await assert.rejects(host.syncAccount(rt, source, accounts[0]), /credential-unavailable/);
    assert.equal(seen.length, before, 'no request reached Gmail after the revocation');
    // The compose grant of the account is untouched: it is another credential's grant.
    assert.ok(rt.grantOf('gmail_draft', work.owner));
  } finally {
    await rt.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* the store's file may stay locked a moment on Windows */ }
  }
});
