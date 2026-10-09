// S457 (ruled 2026-10-09; PS16.2, PS16.3, PS16.4, PT10e, PT10g): a credential granted by a person may name no holder.
// It then has one Grant instance at a time, an effect that uses it names no `for`, and its holder is the person the
// first signed grant request taken for that instance names, kept by keyed digest and never readable. Replacing the
// holder needs a revocation. Written from the text alone, before the code. The provider is the tests' test-oauth, with
// recorded traffic only; every token and every holder value is generated here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { grantRequestSubject, signRecord } from '@poly/core';
import { ROOT } from './helpers.mjs';
import { handleWith, PERSON } from './runtime-helpers.mjs';
import { GENERIC, desk, verdicts } from './grants-helpers.mjs';

const FIXTURES = join(ROOT, 'test', 'fixtures', 'grant-no-holder');
const STRIPE = readFileSync(join(FIXTURES, 'stripe-refund.poly'), 'utf8');
const DESK = ['test/fixtures/grant-no-holder/desk.poly'];
const OUT = join(ROOT, '.poly', 'test-grant-no-holder');
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
const codes = (r) => all(r).map((d) => d.code);
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
let n = 0;
async function check(src) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), src);
  // The Stripe Connect profile is std's own, so the default std is used.
  return { r: await checkFile(join(d, 'm.poly'), { root: d }), build: join(d, '.poly', 'build') };
}

// Holder values are random, so a search of the journal or the store for one cannot match by chance.
const person = (name) => `${name}-${randomBytes(6).toString('hex')}`;
const ONE = 'grant:payments#1';
const TWO = 'grant:payments#2';

/** The desk with a helper that writes a person's signed grant request (PT10g, S210) and has the runtime take it. */
async function nhDesk(name) {
  const d = await desk(name, {}, DESK);
  const approvals = join(d.dir, 'approvals');
  mkdirSync(approvals, { recursive: true });
  let k = 0;
  const request = async (holder) => {
    const record = signRecord({ kind: 'grant-request', subject: grantRequestSubject('payments', holder), by: PERSON.keyId, at: `2026-10-09T00:00:${String(k).padStart(2, '0')}.000Z` }, PERSON.privateKeyPem);
    writeFileSync(join(approvals, `${String(k++).padStart(2, '0')}-request.json`), JSON.stringify({ kind: 'grant-request', credential: 'payments', holder, record }));
    return d.rt.takeApprovals(approvals);
  };
  /** The holder consents to the URL given, or to the last authorization the runtime made: the provider redirects, and its token endpoint answers. */
  const consent = async (scopes, given = null) => {
    let url = given;
    if (!url) {
      const auths = d.rt.takeAuthorizations();
      assert.ok(auths.length >= 1, 'an authorization URL was made');
      url = auths.at(-1).url;
    }
    d.tokenAnswer(scopes);
    const a = await d.redirect('payments', new URL(url).searchParams.get('state'));
    assert.equal(a.status, 200);
  };
  const state = async (id) => (await d.rt.store.getInstance(id))?.state?.g ?? null;
  return { ...d, request, consent, state };
}
const outcomes = (out) => out.map((x) => [x.outcome, x.reason ?? null]);

// 1. PT10e, S457: the refund case.
test('S457, PT10e: a person\'s credential that names no holder, used with no for, checks with no PL1201 and no PL6822', { timeout: 180_000 }, async () => {
  const { r, build } = await check(STRIPE);
  const c = codes(r);
  assert.ok(!c.includes('PL1201') && !c.includes('PL6822'), text(r));
  assert.equal(r.verdict, 'CLEAN', text(r));
  // PT10e lowering: the descriptor records whether the credential has a holder, and the manifest's uses names none.
  const descriptor = JSON.parse(readFileSync(join(build, 'credentials', 'payments.json'), 'utf8'));
  assert.deepEqual([descriptor.grant, descriptor.holder], ['authorization_code', false]);
  const manifest = JSON.parse(readFileSync(join(build, 'refund_nh.Desk', 'effects.manifest.json'), 'utf8'));
  assert.deepEqual(manifest.effects['payments.refund'].uses, { credential: 'payments', scopes: ['read_write'], holder: null });
});

// 2. PT10e, PS16.2: a credential that declares its holder keeps its meaning.
test('S457, PL6822: a credential that declares holder Principal, used with no for, stays HOLDER_NOT_NAMED', { timeout: 180_000 }, async () => {
  const { r } = await check(swap(STRIPE, '  scopes { read_write }\n', '  scopes { read_write }\n  holder Principal\n'));
  assert.equal(r.verdict, 'REFUSED');
  assert.deepEqual(codes(r), ['PL6822'], text(r));
});

// 3. PT10e: an authorization_code credential that declares no holder takes no for (PL1201, S457).
test('S457, PL1201: a person\'s credential that names no holder, used for a Principal, is refused', { timeout: 180_000 }, async () => {
  let src = swap(STRIPE, 'action Refund(amount: 0..500)', 'action Refund(merchant: Principal, amount: 0..500)');
  src = swap(src, 'on Refund(amount) {', 'on Refund(merchant, amount) {');
  src = swap(src, 'emit refund(amount: amount)', 'emit refund(merchant: merchant, amount: amount)');
  src = swap(src, 'effect refund(amount: 0..500) {', 'effect refund(merchant: Principal, amount: 0..500) {');
  src = swap(src, 'uses payments { read_write }\n', 'uses payments { read_write } for merchant\n');
  const { r } = await check(src);
  assert.equal(r.verdict, 'REFUSED');
  const c = codes(r);
  assert.ok(c.length && c.every((x) => x === 'PL1201'), text(r));
});

// 4. PS16.3, PS16.4, PT10g: the grant check reads the credential's one instance.
test('S457, PS16.3, PS16.4: the refund passes the grant check while the one grant is Granted, and is denied credential-unavailable with none and once it is Revoked', { timeout: 300_000 }, async () => {
  const { rt, answers, request, consent, state } = await nhDesk('nh-check');
  try {
    handleWith(rt, 'payments.refund', async () => ({}));
    await rt.create('nh.Desk', { id: 'd-1' });
    // No instance yet: credential-unavailable (PS16.3).
    await rt.dispatch('d-1', 'Refund', { amount: 1 });
    await rt.advance();
    assert.deepEqual(await verdicts(rt, 'd-1'), [['denied', 'credential-unavailable']]);
    assert.deepEqual(outcomes(await request(person('alice'))), [['applied', null]]);
    await consent(['refunds.write']);
    assert.equal(await state(ONE), 'Granted');
    await rt.create('nh.Desk', { id: 'd-2' });
    await rt.dispatch('d-2', 'Refund', { amount: 1 });
    await rt.advance();
    assert.deepEqual((await verdicts(rt, 'd-2')).map((v) => v[0]), ['allowed']);
    assert.deepEqual((await rt.outbox('d-2')).map((r) => r.status), ['done']);
    // PS16.4: from the step that records Revoked, every intent using the grant is denied.
    answers.push(() => ({ status: 200, headers: {}, body: '' }));
    await rt.revokeGrant('payments', null, { source: 'provider' });
    await rt.advance();
    assert.equal(await state(ONE), 'Revoked');
    await rt.dispatch('d-2', 'Refund', { amount: 1 });
    await rt.advance();
    assert.deepEqual((await verdicts(rt, 'd-2')).at(-1), ['denied', 'credential-unavailable']);
  } finally { await rt.close(); }
});

// 5. PT10g as amended by S457: the signed grant request fixes the one instance's holder.
test('S457, PT10g: the first signed request creates grant:payments#1 and fixes its holder; another holder is refused holder-mismatch until a revocation, after which it creates grant:payments#2', { timeout: 300_000 }, async () => {
  const { rt, answers, request, consent, state } = await nhDesk('nh-request');
  const alice = person('alice');
  const bob = person('bob');
  try {
    assert.equal(await state(ONE), null, 'no instance before the first request');
    assert.deepEqual(outcomes(await request(alice)), [['applied', null]]);
    assert.equal(await state(ONE), 'Requested');
    const first = rt.takeAuthorizations();
    assert.equal(first.length, 1);
    // The token endpoint answers the holder's consent; the one grant is Granted.
    await consent(['refunds.write'], first[0].url);
    assert.equal(await state(ONE), 'Granted');
    // Another holder, while the instance is not Revoked: refused, and nothing moves.
    assert.deepEqual(outcomes(await request(bob)), [['refused', 'holder-mismatch']]);
    assert.equal(await state(ONE), 'Granted');
    assert.equal(rt.takeAuthorizations().length, 0);
    const journal = (await rt.chain('runtime:approvals')).map((e) => e.body);
    assert.ok(journal.some((b) => b?.stage === 'grant-request' && b.outcome === 'refused' && b.reason === 'holder-mismatch'), JSON.stringify(journal));
    const text = JSON.stringify(journal);
    assert.ok(!text.includes(bob) && !text.includes(alice), 'the journal holds neither holder\'s value');
    // The same holder: taken, and the grant is asked again as rt.requestGrant does.
    assert.deepEqual(outcomes(await request(alice)), [['applied', null]]);
    assert.equal(await state(ONE), 'Requested');
    const again = rt.takeAuthorizations();
    assert.equal(again.length, 1);
    await consent(['refunds.write'], again[0].url);
    // After a revocation, another holder's request is taken and creates the next instance.
    answers.push(() => ({ status: 200, headers: {}, body: '' }));
    await rt.revokeGrant('payments', null, { source: 'provider' });
    await rt.advance();
    assert.equal(await state(ONE), 'Revoked');
    assert.deepEqual(outcomes(await request(bob)), [['applied', null]]);
    assert.equal(await state(TWO), 'Requested');
    assert.equal(await state(ONE), 'Revoked', 'the revoked instance stays revoked');
    // And now alice is the other holder: refused while grant:payments#2 is not Revoked.
    assert.deepEqual(outcomes(await request(alice)), [['refused', 'holder-mismatch']]);
    // The runtime keeps each holder by its keyed digest: no table it keeps holds a holder's value.
    const rows = rt.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().flatMap(({ name }) => rt.store.db.prepare(`SELECT * FROM "${name}"`).all().map((r) => JSON.stringify(r)));
    assert.ok(rows.length > 0);
    assert.ok(!rows.some((r) => r.includes(alice) || r.includes(bob)), 'no stored row holds a holder in clear');
  } finally { await rt.close(); }
});

// 6. PT10g: only a person's signed request creates the instance.
test('S457, PT10g: rt.requestGrant(c, null) is refused before a signed request fixed the holder, and returns an authorization URL after', { timeout: 300_000 }, async () => {
  const { rt, request, state } = await nhDesk('nh-requestgrant');
  try {
    await assert.rejects(rt.requestGrant('payments', null));
    assert.equal(await state(ONE), null, 'the refused call created no instance');
    assert.equal(rt.takeAuthorizations().length, 0);
    assert.deepEqual(outcomes(await request(person('alice'))), [['applied', null]]);
    rt.takeAuthorizations();
    const url = await rt.requestGrant('payments', null);
    assert.equal(typeof url, 'string');
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, GENERIC.authorization);
    assert.ok(u.searchParams.get('state'));
  } finally { await rt.close(); }
});

// 7. PS16.3: the holder is never readable; the proposal carries the name, the grant's state and the scopes only.
test('S457, PS16.3: the proposal of the refund carries credential { name, grantState, scopes } and never the holder', { timeout: 300_000 }, async () => {
  const { rt, request, consent } = await nhDesk('nh-proposal');
  const alice = person('alice');
  try {
    handleWith(rt, 'payments.refund', async () => ({}));
    assert.deepEqual(outcomes(await request(alice)), [['applied', null]]);
    await consent(['refunds.write']);
    await rt.create('nh.Desk', { id: 'd-1' });
    await rt.dispatch('d-1', 'Refund', { amount: 1 });
    await rt.advance();
    const allowed = (await rt.chain('d-1')).find((e) => e.kind === 'verdict' && e.body.outcome === 'allowed');
    assert.ok(allowed, JSON.stringify(await verdicts(rt, 'd-1')));
    const proposal = await rt.store.body(allowed.body.proposal);
    assert.deepEqual(proposal.credential, { name: 'payments', grantState: 'Granted', scopes: ['refunds.write'] });
    assert.ok(!JSON.stringify(proposal).includes(alice), 'the proposal does not hold the holder');
  } finally { await rt.close(); }
});
