// AC19 (PT22.1b, PT22.4, PT22.6) on the concierge: an effect whose uses names a scope its credential does not declare
// is PL6821 at admission; a grant with fewer scopes than the refund needs gives insufficient-scope; after the step that
// records Revoked no intent using the grant starts, and one already running completes, recorded as started first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit, checkFile } from '@poly/check';
import { ROOT, TEST_STD } from './helpers.mjs';
import { handleWith, makeKey, project } from './runtime-helpers.mjs';
import { concierge, REFUNDS, verdicts } from './concierge-refund-helpers.mjs';

test('AC19: a uses of a scope the credential does not declare is PL6821 at admission', { timeout: 300_000 }, async () => {
  const key = makeKey('ac19-pl6821');
  const dir = project('ac19-pl6821', [], key, 'test-concierge-refund');
  const src = readFileSync(join(ROOT, 'test', 'fixtures', 'm9', 'concierge-refund.poly'), 'utf8').replace('uses payments { refunds.write } for merchant', 'uses payments { refunds.write, payouts.write } for merchant');
  writeFileSync(join(dir, 'src', 'concierge-refund.poly'), src);
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8')), credentials: { payments: { store: 'kms' } } }, null, 2));
  await assert.rejects(admit(dir, { std: TEST_STD }), /REFUSED/);
  // The refusal is the check's, with the code at the effect's uses.
  const r = await checkFile(join(dir, 'src', 'concierge-refund.poly'), { root: dir, std: TEST_STD });
  const d = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].filter((x) => x.severity === 'error');
  assert.deepEqual(d.map((x) => x.code), ['PL6821']);
  assert.match(d[0].message, /payouts\.write/);
});

test('AC19: a grant with fewer scopes than the refund needs gives insufficient-scope', { timeout: 300_000 }, async () => {
  const c = await concierge('ac19-scope', { scope: 'charges.read' });
  try {
    await c.grant('merchant-1');
    const app = await c.ticket('alice');
    await c.refund(app, 'merchant-1', 40);
    await c.rt.advance();
    assert.deepEqual(await verdicts(c.rt, app), [['denied', 'insufficient-scope']]);
    assert.equal(c.sent.filter((q) => q.url === REFUNDS).length, 0);
  } finally { await c.rt.close(); }
});

test('AC19: after the step that records Revoked no refund starts, and one already running completes and is recorded as started first', { timeout: 300_000 }, async () => {
  const c = await concierge('ac19-revoke');
  try {
    await c.grant('merchant-1');
    const app = await c.ticket('alice');
    // The revocation arrives while the first refund's handler runs: the provider has already taken its request.
    let calls = 0;
    handleWith(c.rt, 'payments.refund', async (p, { api }) => { calls++; const r = await api.post(REFUNDS, `amount=${p.amount}`); if (calls === 1) await c.rt.revokeGrant('payments', 'merchant-1', { source: 'provider' }); return { status: r.status }; });
    await c.refund(app, 'merchant-1', 40);
    await c.rt.advance();
    await c.refund(app, 'merchant-1', 60);
    await c.rt.advance();
    assert.equal(calls, 1);
    assert.deepEqual(await verdicts(c.rt, app), [['allowed', null], ['denied', 'credential-unavailable']]);
    assert.deepEqual((await c.rt.outbox(app)).map((r) => r.status).sort(), ['dead', 'done']);
    const ledger = c.rt.store.db.prepare('SELECT run, event FROM poly_ledger ORDER BY rowid').all().map((r) => ({ run: r.run, body: JSON.parse(r.event).body }));
    const started = ledger.findIndex((e) => e.run.startsWith('intent:') && e.body?.action === 'Start');
    const revoked = ledger.findIndex((e) => e.body?.stage === 'revocation');
    assert.ok(started >= 0 && revoked > started, JSON.stringify({ started, revoked }));
  } finally { await c.rt.close(); }
});
