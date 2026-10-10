// PS17.7 "A forget uses no grant" (ruled 2026-10-10), PS16.4, PS17.0 per owner (S461), PT10l, PT10g, PT10j. A forget erases
// what the runtime holds for its subject and never sends a request under a grant: each adapter's forget(subject) runs
// with no credential, so a request it makes through a credential handle is refused before anything is sent
// (`forget-no-grant`), and the refusal does not cut the forget short. When the subject owns items of a source whose
// credential has a grant per owner, the forget first revokes that owner's grant (recorded on runtime:ingress with source
// `forget`), so no later sync brings the items back; every other owner's grant is untouched. A subject that holds no
// such grant revokes nothing. Written from the specification text alone, before the code. The fixture is S461's; the
// provider is the tests' test-oauth with recorded traffic only, and every token and key is generated here and never
// printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgetSubject, signRecord } from '@poly/core';
import { openSearchSource } from '@poly/io';
import { desk, GENERIC } from './grants-helpers.mjs';
import { PERSON } from './runtime-helpers.mjs';

const FIX = 'test/fixtures/source-credential-owners/inbox.poly';
// As in source-credential-owners.test.mjs: the provider's base is https://api.test-oauth.example/v1/, and the index v1
// puts every request of the adapter under it.
const ORIGIN = 'https://api.test-oauth.example';
const INDEX = 'v1';
const OWNERS = ['acct-a', 'acct-b', 'acct-c'];
const REQ = { method: 'GET', url: `${ORIGIN}/${INDEX}/_doc/probe`, headers: {}, body: '' };
const toCluster = (q) => q.url.startsWith(`${ORIGIN}/${INDEX}/`);

const ownDesk = (name) => desk(name, {}, [FIX]);
const sign = (rt, subject) => signRecord({ kind: 'forget', subject: forgetSubject(rt.anchorId, { subject }), by: PERSON.keyId, at: '2026-10-10T00:00:00.000Z' }, PERSON.privateKeyPem);

async function grantAll(d, owners = OWNERS) {
  const byToken = new Map();
  for (const o of owners) {
    const tokens = await d.grant('payments', o, ['charges.read']);
    byToken.set(`Bearer ${tokens.access}`, o);
  }
  return (q) => { const a = q?.headers?.authorization; return a ? (byToken.get(a) ?? 'unknown') : 'none'; };
}

const inbox = (transport) => openSearchSource({ base: ORIGIN, index: INDEX, transport, owner: 'account', asOf: 'asof', body: 'body' });

function ownerAnswers(d, owner) {
  const asof = new Date(d.clock.now()).toISOString();
  const id = `m-${owner}`;
  d.answers.push((q) => {
    assert.equal(q.url, `${ORIGIN}/${INDEX}/_search`);
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hits: { hits: [{ _id: id, _source: { account: owner, asof } }] } }) };
  });
  d.answers.push((q) => { assert.equal(q.url, `${ORIGIN}/${INDEX}/_doc/${id}`); return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ found: true, _source: { account: owner, asof, body: `Mail of ${owner}.` } }) }; });
}

async function search(rt, id, account) {
  await rt.dispatch(id, 'Search', { account });
  for (let k = 0; k < 6; k++) { await rt.advance(); await rt.worker.tick(); }
  return (await rt.getState(id)).state;
}

async function refused(d, call, reason) {
  const before = d.sent.length;
  let out;
  try { out = await call(); } catch (e) { assert.match(String(e?.message ?? e), reason); assert.equal(d.sent.length, before, 'nothing was sent'); return; }
  assert.match(JSON.stringify(out), reason);
  assert.ok(!(out?.status >= 200 && out?.status < 300), `status ${out?.status}`);
  assert.equal(d.sent.length, before, 'nothing was sent');
}

async function through(d, whose, handle) {
  d.answers.length = 0;
  d.answers.push(() => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }));
  const before = d.sent.length;
  const res = await handle.request(REQ);
  assert.equal(res.status, 200);
  assert.equal(d.sent.length, before + 1, 'one request reached the transport');
  return whose(d.sent.at(-1));
}

/** A body the runtime holds for a subject: stored with a taint that names it among its owners (PS17.7). */
async function bodyOf(rt, subject) {
  const digest = await rt.putContent(`A note about ${subject}.`);
  rt.store.db.exec('BEGIN'); rt.memory.taint(digest, { c: 1, o: [subject] }); rt.store.db.exec('COMMIT');
  return digest;
}

/** Every Grant instance of the credential, with its state. */
async function grantStates(rt) {
  const ids = rt.store.db.prepare('SELECT instance_id FROM pr_instance').all().map((r) => r.instance_id).filter((i) => i.startsWith('grant:')).sort();
  const out = {};
  for (const id of ids) out[id] = (await rt.store.getInstance(id)).state.g;
  return out;
}
const revocationsOn = async (rt) => (await rt.chain('runtime:ingress')).map((e) => e.body).filter((b) => b?.stage === 'revocation');
const forgetEvents = (rt) => rt.store.db.prepare("SELECT event FROM poly_ledger WHERE run = 'runtime:content' AND kind = 'verdict'").all().map((r) => JSON.parse(r.event).body).filter((x) => x.stage === 'forget');
const itemSets = (rt) => rt.store.db.prepare('SELECT owners, items FROM poly_items').all();

/** Three accounts granted, the inbox connected over the routing handle, a desk per owner, one retrieval each. */
async function threeOwners(name) {
  const d = await ownDesk(name);
  const whose = await grantAll(d);
  d.rt.connectSource('inbox', inbox(d.rt.credentialHandle('payments')));
  for (const o of OWNERS) {
    await d.rt.create('srcown.Desk', { id: `d-${o}` });
    d.answers.length = 0;
    ownerAnswers(d, o);
    const st = await search(d.rt, `d-${o}`, o);
    assert.deepEqual([st.phase, st.found], ['Idle', 1], `${o}: ${JSON.stringify(st)}`);
  }
  d.answers.length = 0;
  const bodies = {};
  for (const o of OWNERS) bodies[o] = await bodyOf(d.rt, o);
  return { ...d, whose, bodies };
}

/** The forget of a subject, with an answer queued for the provider's revocation endpoint (RFC 7009) should one go. */
async function forget(d, subject) {
  d.answers.length = 0;
  d.answers.push((q) => { assert.equal(q.url, GENERIC.revocation, `only a token revocation may be sent, not ${q.method} ${q.url}`); return { status: 200, headers: {}, body: '' }; });
  const r = await d.rt.forget({ subject }, sign(d.rt, subject));
  await d.rt.advance();
  d.answers.length = 0;
  return r;
}

test('PS17.7, PS16.4, S461: forgetting one owner erases their items and bodies, revokes their grant only (recorded with source forget), and the other two accounts still sync', { timeout: 300_000 }, async () => {
  const d = await threeOwners('fng-owner');
  const { rt, whose, bodies } = d;
  try {
    const sets = itemSets(rt);
    assert.equal(sets.length, 3, JSON.stringify(sets));
    const grantA = rt.grantOf('payments', 'acct-a');
    const before = await grantStates(rt);
    assert.deepEqual(Object.values(before).filter((s) => s === 'Granted').length, 3, JSON.stringify(before));
    const { erased } = await forget(d, 'acct-a');
    // Erased: A's body, and A's item set; B's and C's stay.
    assert.ok(erased.includes(bodies['acct-a']), JSON.stringify(erased));
    assert.equal(await rt.contentBody(bodies['acct-a']), null);
    for (const o of ['acct-b', 'acct-c']) assert.notEqual(await rt.contentBody(bodies[o]), null, o);
    const left = itemSets(rt);
    assert.equal(left.length, 2, JSON.stringify(left));
    assert.ok(!JSON.stringify(left).includes('m-acct-a'), JSON.stringify(left));
    // PS16.4, PT10g: A's Grant instance reaches Revoked; every other grant is as it was.
    const after = await grantStates(rt);
    assert.equal(after[grantA], 'Revoked');
    for (const [id, s] of Object.entries(before)) if (id !== grantA) assert.equal(after[id], s, id);
    const revs = await revocationsOn(rt);
    assert.equal(revs.length, 1, JSON.stringify(revs));
    assert.equal(revs[0].source, 'forget', JSON.stringify(revs[0]));
    assert.ok(!JSON.stringify(revs).includes('acct-a'), 'the holder is not written as itself');
    // B and C still sync: their handles and their retrievals go through under their own grants.
    for (const o of ['acct-b', 'acct-c']) {
      assert.equal(await through(d, whose, rt.credentialHandle('payments', o)), o);
      d.answers.length = 0;
      const at = d.sent.length;
      ownerAnswers(d, o);
      const st = await search(rt, `d-${o}`, o);
      assert.deepEqual([st.phase, st.found], ['Idle', 1], `${o}: ${JSON.stringify(st)}`);
      const reached = d.sent.slice(at);
      assert.ok(reached.length >= 1, `${o}'s retrieval reached the cluster`);
      assert.deepEqual([...new Set(reached.map(whose))], [o]);
    }
  } finally { await rt.close(); }
});

test('PS17.7, S461: a later sync does not bring the forgotten owner\'s items back: their handle and their retrieval are refused with nothing sent', { timeout: 300_000 }, async () => {
  const d = await threeOwners('fng-later');
  const { rt } = d;
  try {
    await forget(d, 'acct-a');
    const setsAfterForget = itemSets(rt).length;
    // The host's sync of A: refused before sending.
    await refused(d, () => rt.credentialHandle('payments', 'acct-a').request(REQ), /credential-unavailable/);
    // A's retrieval fails, and nothing reaches the cluster.
    const at = d.sent.length;
    ownerAnswers(d, 'acct-a');
    const st = await search(rt, 'd-acct-a', 'acct-a');
    assert.deepEqual([st.phase, st.found], ['Idle', 2], JSON.stringify(st));
    assert.equal(d.sent.length, at, 'no request of A reached the transport after the forget');
    // No item of A's is stored again.
    const sets = itemSets(rt);
    assert.equal(sets.length, setsAfterForget, JSON.stringify(sets));
    assert.ok(!JSON.stringify(sets).includes('m-acct-a'), JSON.stringify(sets));
  } finally { await rt.close(); }
});

test('PS17.7, PT10l: an adapter request inside a forget is refused forget-no-grant with nothing sent, and the forget still completes', { timeout: 300_000 }, async () => {
  const d = await ownDesk('fng-adapter');
  const { rt } = d;
  try {
    await grantAll(d);
    // The OpenSearch adapter's forget issues _delete_by_query through its transport, here the routing handle (PT10j).
    // An adapter made by poly-io cannot be wrapped (connectSource refuses one this package did not make, PL6408), so
    // the refusal is read from the forget event, which records it by the source's name (PT10l).
    const adapter = inbox(rt.credentialHandle('payments'));
    rt.connectSource('inbox', adapter);
    const body = await bodyOf(rt, 'acct-a');
    const at = d.sent.length;
    const { erased } = await forget(d, 'acct-a');
    assert.deepEqual(d.sent.slice(at).filter(toCluster).map((q) => `${q.method} ${q.url}`), [], 'nothing reached the cluster');
    assert.deepEqual(d.sent.slice(at).filter((q) => q.url !== GENERIC.revocation).map((q) => q.url), [], 'only a token revocation, if any, was sent');
    // The forget completed: its body erased, its event written, the refusal recorded by the source's name.
    assert.ok(erased.includes(body));
    const ev = forgetEvents(rt);
    assert.equal(ev.length, 1, JSON.stringify(ev));
    assert.match(JSON.stringify(ev[0]), /inbox/, JSON.stringify(ev[0]));
    assert.match(JSON.stringify(ev[0]), /forget-no-grant/, JSON.stringify(ev[0]));
    // B's grant is untouched (only the subject's grant is revoked, PS16.4).
    assert.equal((await rt.store.getInstance(rt.grantOf('payments', 'acct-b'))).state.g, 'Granted');
  } finally { await rt.close(); }
});

test('PS17.7: forgetting a subject that holds no grant erases their bodies and revokes nothing', { timeout: 300_000 }, async () => {
  const d = await threeOwners('fng-sender');
  const { rt, bodies } = d;
  try {
    // A channel's sender, or any principal with no grant: a body stored with that principal's taint.
    const theirs = await bodyOf(rt, 'sender-x');
    const before = await grantStates(rt);
    const revsBefore = (await revocationsOn(rt)).length;
    const at = d.sent.length;
    const { erased } = await forget(d, 'sender-x');
    assert.ok(erased.includes(theirs), JSON.stringify(erased));
    assert.equal(await rt.contentBody(theirs), null);
    for (const o of OWNERS) assert.notEqual(await rt.contentBody(bodies[o]), null, o);
    assert.deepEqual(await grantStates(rt), before);
    assert.equal((await revocationsOn(rt)).length, revsBefore, 'no revocation was recorded');
    assert.deepEqual(d.sent.slice(at).filter((q) => q.url === GENERIC.revocation).length, 0, 'no token was revoked at the provider');
    assert.equal(itemSets(rt).length, 3, 'every owner\'s item set stays');
  } finally { await rt.close(); }
});
