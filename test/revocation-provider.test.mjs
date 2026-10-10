// PS16.4 "The provider's revocation" (ruled 2026-10-10), PS17.7 "A forget uses no grant", PT10g (the provider's
// revocation, PS16.4), PT9 "Retry (S137)". The local revocation comes first and unconditionally: Revoke() makes the
// grant Revoked in its own step. The credential.revoke intent that step emits (RFC 7009) is an intent like any other,
// retried within polyrun's default bound (five attempts, since credential.revoke declares no retry) and journaled at
// each attempt. Its failure, a refusal or a timeout, never undoes the local revocation and never blocks what revoked
// the grant: rt.forget and rt.revokeGrant return once the local step is taken. Written from the specification text
// alone, before the code. The fixture and setup are forget-no-grant.test.mjs's (three owners of an owned source, a
// grant per owner, S461); the provider is the tests' test-oauth with recorded traffic only, and every token and key is
// generated here and never printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgetSubject, signRecord } from '@poly/core';
import { openSearchSource } from '@poly/io';
import { desk, GENERIC } from './grants-helpers.mjs';
import { PERSON } from './runtime-helpers.mjs';

const FIX = 'test/fixtures/source-credential-owners/inbox.poly';
const ORIGIN = 'https://api.test-oauth.example';
const INDEX = 'v1';
const OWNERS = ['acct-a', 'acct-b', 'acct-c'];
// PT9 Retry (S137), PT10g: credential.revoke declares no retry, so it runs at polyrun's default, five attempts.
const MAX_ATTEMPTS = 5;

const ownDesk = (name) => desk(name, {}, [FIX]);
const sign = (rt, subject) => signRecord({ kind: 'forget', subject: forgetSubject(rt.anchorId, { subject }), by: PERSON.keyId, at: '2026-10-10T00:00:00.000Z' }, PERSON.privateKeyPem);
const inbox = (transport) => openSearchSource({ base: ORIGIN, index: INDEX, transport, owner: 'account', asOf: 'asof', body: 'body' });

async function grantAll(d, owners = OWNERS) {
  for (const o of owners) await d.grant('payments', o, ['charges.read']);
}

function ownerAnswers(d, owner) {
  const asof = new Date(d.clock.now()).toISOString();
  const id = `m-${owner}`;
  d.answers.push(() => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hits: { hits: [{ _id: id, _source: { account: owner, asof } }] } }) }));
  d.answers.push(() => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ found: true, _source: { account: owner, asof, body: `Mail of ${owner}.` } }) }));
}

async function search(rt, id, account) {
  await rt.dispatch(id, 'Search', { account });
  for (let k = 0; k < 6; k++) { await rt.advance(); await rt.worker.tick(); }
  return (await rt.getState(id)).state;
}

async function grantStates(rt) {
  const ids = rt.store.db.prepare('SELECT instance_id FROM pr_instance').all().map((r) => r.instance_id).filter((i) => i.startsWith('grant:')).sort();
  const out = {};
  for (const id of ids) out[id] = (await rt.store.getInstance(id)).state.g;
  return out;
}
const forgetEvents = (rt) => rt.store.db.prepare("SELECT event FROM poly_ledger WHERE run = 'runtime:content' AND kind = 'verdict'").all().map((r) => JSON.parse(r.event).body).filter((x) => x.stage === 'forget');
const itemSets = (rt) => rt.store.db.prepare('SELECT owners, items FROM poly_items').all();
const revocationRequests = (d, from = 0) => d.sent.slice(from).filter((q) => q.url === GENERIC.revocation);

/** Three accounts granted, the inbox connected over the routing handle, a desk per owner, one retrieval each (S461). */
async function threeOwners(name) {
  const d = await ownDesk(name);
  await grantAll(d);
  d.rt.connectSource('inbox', inbox(d.rt.credentialHandle('payments')));
  for (const o of OWNERS) {
    await d.rt.create('srcown.Desk', { id: `d-${o}` });
    d.answers.length = 0;
    ownerAnswers(d, o);
    const st = await search(d.rt, `d-${o}`, o);
    assert.deepEqual([st.phase, st.found], ['Idle', 1], `${o}: ${JSON.stringify(st)}`);
  }
  d.answers.length = 0;
  return d;
}

/**
 * The provider's revocation endpoint (RFC 7009) answers every attempt with `answer`, and nothing else may be sent.
 * Each queued entry also counts the attempt. More entries are queued than the bound, so an extra attempt is seen.
 */
function providerAnswers(d, answer) {
  d.answers.length = 0;
  for (let k = 0; k < MAX_ATTEMPTS * 3; k++) {
    d.answers.push((q) => { assert.equal(q.url, GENERIC.revocation, `only a token revocation may be sent, not ${q.method} ${q.url}`); return answer(q); });
  }
}
const refuse = () => ({ status: 503, headers: {}, body: '{"error":"temporarily_unavailable"}' });
const timeOut = () => { const e = new Error('the provider did not answer within the timeout'); e.name = 'TimeoutError'; e.code = 'ETIMEDOUT'; throw e; };

/** Retries are due after a backoff on the runtime's clock: move it on and take every due step, well past the bound. */
async function drain(d, rounds = MAX_ATTEMPTS * 3) {
  for (let k = 0; k < rounds; k++) { d.clock.advance(120_000); await d.rt.advance(); await d.rt.worker.tick(); }
}

/** The credential.revoke row of a Grant instance's outbox (PT10g). */
async function revokeRow(rt, grant) {
  const rows = (await rt.outbox(grant)).filter((r) => r.kind === 'credential.revoke');
  assert.equal(rows.length, 1, `one credential.revoke intent for the grant: ${JSON.stringify(rows.map((r) => [r.kind, r.status]))}`);
  return rt.outboxRow(rows[0].intent_id);
}

/** Every ledger event of the revoke intent's run, by kind, to see one journaled per attempt (PS16.4). */
function ledgerOf(rt, intentId) {
  return rt.store.db.prepare('SELECT run, kind, event FROM poly_ledger ORDER BY rowid').all()
    .filter((r) => r.run.includes(intentId) || r.event.includes(intentId))
    .map((r) => ({ run: r.run, kind: r.kind, body: JSON.parse(r.event).body }));
}

/**
 * PS16.4, PS17.7: the forget of acct-a while the provider fails every revocation attempt with `answer`. The forget
 * completes, A's grant is Revoked from the forget's own step, the revocation is tried within the bound and journaled at
 * each attempt, and its final failure changes neither A's grant nor B's or C's.
 */
async function forgetWhileProviderFails(name, answer, failure) {
  const d = await threeOwners(name);
  const { rt } = d;
  try {
    const grantA = rt.grantOf('payments', 'acct-a');
    const before = await grantStates(rt);
    assert.equal(Object.values(before).filter((s) => s === 'Granted').length, 3, JSON.stringify(before));
    providerAnswers(d, answer);
    const at = d.sent.length;
    // PS16.4: the forget completes whatever the provider answers; PT10g: rt.forget returns once the local step is taken.
    await rt.forget({ subject: 'acct-a' }, sign(rt, 'acct-a'));
    // PS16.4: Revoked from the step of the forget, before the runtime is advanced and before any provider answer.
    assert.equal((await rt.store.getInstance(grantA)).state.g, 'Revoked', 'the grant is Revoked locally at once');
    const ev = forgetEvents(rt);
    assert.equal(ev.length, 1, `the forget event is written: ${JSON.stringify(ev)}`);
    assert.equal(itemSets(rt).length, 2, 'A\'s item set is erased');
    // The revocation intent exists and is tried, retried within the bound, and fails.
    await drain(d);
    const row = await revokeRow(rt, grantA);
    assert.equal(row.attempts, MAX_ATTEMPTS, `retried within polyrun's default bound: ${JSON.stringify(row)}`);
    assert.equal(row.status, 'dead', `the intent's final failure: ${JSON.stringify(row)}`);
    assert.ok(row.last_error, 'the failure is recorded');
    assert.equal(revocationRequests(d, at).length, MAX_ATTEMPTS, 'one request to the provider per attempt, no more');
    // PS16.4: journaled with each attempt.
    assert.match(row.last_error, failure, `the last failure is the provider's: ${row.last_error}`);
    const journal = ledgerOf(rt, row.intent_id);
    const steps = journal.filter((e) => e.run === `intent:${row.intent_id}` && e.kind === 'step').map((e) => e.body.action);
    assert.equal(steps.filter((a) => a === 'Start').length, MAX_ATTEMPTS, JSON.stringify(steps));
    assert.equal(steps.filter((a) => a === 'HandlerFailed').length, MAX_ATTEMPTS, JSON.stringify(steps));
    const tries = journal.filter((e) => e.run === grantA && e.kind === 'observation' && e.body?.intent === row.intent_id).map((e) => [e.body.attempt, e.body.outcome]);
    assert.deepEqual(tries, [1, 2, 3, 4, 5].map((k) => [k, 'failed']), 'one journaled observation per attempt, on the grant\'s run');
    // PS16.4: the grant's own Revoke step is journaled before any attempt of the provider's revocation.
    const ledger = rt.store.db.prepare('SELECT run, kind, event FROM poly_ledger ORDER BY rowid').all().map((r) => ({ run: r.run, kind: r.kind, body: JSON.parse(r.event).body }));
    const revoked = ledger.findIndex((e) => e.run === grantA && e.kind === 'step' && e.body?.action === 'Revoke');
    const firstStart = ledger.findIndex((e) => e.run === `intent:${row.intent_id}` && e.body?.action === 'Start');
    assert.ok(revoked >= 0 && firstStart > revoked, JSON.stringify({ revoked, firstStart }));
    // PS16.4: the failure never undoes the local revocation, and every other owner's grant is untouched (PS17.7).
    const after = await grantStates(rt);
    assert.equal(after[grantA], 'Revoked');
    for (const [id, s] of Object.entries(before)) if (id !== grantA) assert.equal(after[id], s, id);
    assert.equal(forgetEvents(rt).length, 1, 'the forget is not repeated or undone');
  } finally { await rt.close(); }
}

test('PS16.4, PS17.7, PT10g: the provider refuses every token revocation; the forget completes, the grant is Revoked at once, the revocation is retried five times and journaled, and its failure changes no grant', { timeout: 300_000 }, async () => {
  await forgetWhileProviderFails('rvp-refuse', refuse, /503/);
});

test('PS16.4, PS17.7, PT10g: the provider times out on every token revocation; the same holds, with the timeout as the failure', { timeout: 300_000 }, async () => {
  await forgetWhileProviderFails('rvp-timeout', timeOut, /timeout|timed out/i);
});

test('PS16.4, PT10g: rt.revokeGrant from the provider while the provider does not answer: the grant is Revoked locally and the call returns without waiting', { timeout: 300_000 }, async () => {
  const d = await threeOwners('rvp-provider');
  const { rt } = d;
  // The provider's endpoint holds the first request open until the test lets it go, then refuses it and the rest.
  let release;
  const held = new Promise((r) => { release = r; });
  try {
    const grantB = rt.grantOf('payments', 'acct-b');
    const before = await grantStates(rt);
    d.answers.length = 0;
    d.answers.push(async (q) => { assert.equal(q.url, GENERIC.revocation); await held; return refuse(); });
    for (let k = 0; k < MAX_ATTEMPTS * 3; k++) d.answers.push((q) => { assert.equal(q.url, GENERIC.revocation); return refuse(); });
    const at = d.sent.length;
    // PT10g: rt.revokeGrant returns once the local step is taken; a call that waited on the provider would not settle.
    const outcome = await Promise.race([
      rt.revokeGrant('payments', 'acct-b', { source: 'provider' }).then(() => 'returned'),
      new Promise((r) => setTimeout(() => r('waited'), 10_000).unref()),
    ]);
    assert.equal(outcome, 'returned', 'rt.revokeGrant did not wait for the provider');
    assert.equal((await rt.store.getInstance(grantB)).state.g, 'Revoked', 'the grant is Revoked locally at once');
    release();
    await drain(d);
    const row = await revokeRow(rt, grantB);
    assert.equal(row.status, 'dead', JSON.stringify(row));
    assert.equal(row.attempts, MAX_ATTEMPTS, JSON.stringify(row));
    assert.ok(revocationRequests(d, at).length >= 1, 'the token revocation was sent to the provider');
    const after = await grantStates(rt);
    assert.equal(after[grantB], 'Revoked');
    for (const [id, s] of Object.entries(before)) if (id !== grantB) assert.equal(after[id], s, id);
  } finally { release?.(); await rt.close(); }
});
