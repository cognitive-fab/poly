// S461 (PS17.0, PT10j, ruled 2026-10-10): per owner. When an owned source's credential names `holder Principal`, each
// owner of the source's items has a grant of its own, the instance of m.c.Grant for c and that owner (PS16.2). A
// retrieval from such a source names its owner (PL1201 otherwise) and its requests run under that owner's grant only:
// a request of one owner's retrieval through another owner's handle is refused, so one account's grant never reaches
// another's items. Revoking one owner's grant (PS16.4) stops that owner's requests, its sync included, and no other
// owner's. Written from the specification text alone, before the code. The provider is the tests' test-oauth, with
// recorded traffic only; every token is generated here and none is ever printed: a request is named by the owner whose
// token it carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { openSearchSource } from '@poly/io';
import { ROOT, TEST_STD } from './helpers.mjs';
import { desk } from './grants-helpers.mjs';

const FIX = 'test/fixtures/source-credential-owners/inbox.poly';
const INBOX = readFileSync(join(ROOT, FIX), 'utf8');
const OUT = join(ROOT, '.poly', 'test-source-credential-owners');
// As in source-credential.test.mjs: the provider profile's one base is https://api.test-oauth.example/v1/, and an
// OpenSearch base is an origin, so the index v1 puts every request of the adapter under the provider's base.
const ORIGIN = 'https://api.test-oauth.example';
const INDEX = 'v1';
const OWNERS = ['acct-a', 'acct-b', 'acct-c'];
const REQ = { method: 'GET', url: `${ORIGIN}/${INDEX}/_doc/probe`, headers: {}, body: '' };

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };
const all = (r) => [...(r.diagnostics ?? []), ...(r.machines ?? []).flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics)];
const codes = (r) => all(r).map((d) => d.code);
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
let n = 0;
async function check(src) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), src);
  return checkFile(join(d, 'm.poly'), { root: d, std: TEST_STD });
}

const OWNED_RETRIEVE = '    retrieve inbox where owner == account limit 1\n';
const BARE_RETRIEVE = '    retrieve inbox limit 1\n';

// ---------------------------------------------------------------------------------------------------------------------
// 1. The checker (PS17.0, PT10j).
// ---------------------------------------------------------------------------------------------------------------------

test('S461, PS17.0: an owned documents source whose credential names holder Principal, retrieved by owner, checks CLEAN', { timeout: 300_000 }, async () => {
  const r = await check(INBOX);
  assert.ok(!codes(r).includes('PL1201') && !codes(r).includes('PL1001'), text(r));
  assert.equal(r.verdict, 'CLEAN', text(r));
});

test('S461, PS17.0: the same credential with a holder on a source that is not owned is PL1201', { timeout: 300_000 }, async () => {
  // The owner predicate goes with owned (PL6835 otherwise, S303), so the retrieval names none here.
  const src = swap(swap(INBOX, '  audience staff owned\n  credential payments\n', '  audience staff\n  credential payments\n'), OWNED_RETRIEVE, BARE_RETRIEVE);
  const r = await check(src);
  assert.equal(r.verdict, 'REFUSED', text(r));
  assert.ok(codes(r).includes('PL1201'), text(r));
});

test('S461, PS17.0, PT10j: a retrieval with no owner predicate from an owned source whose credential names a holder is PL1201', { timeout: 300_000 }, async () => {
  // The control first: with the owner predicate the module is CLEAN, so the refusal below is the retrieval's and not
  // the holder's (before S461 every credential with a holder on a source was PL1201).
  assert.equal((await check(INBOX)).verdict, 'CLEAN');
  const r = await check(swap(INBOX, OWNED_RETRIEVE, BARE_RETRIEVE));
  assert.equal(r.verdict, 'REFUSED', text(r));
  assert.ok(codes(r).includes('PL1201'), text(r));
});

test('S461, PT10j: the instance line of the credential\'s Grant says one instance per owner, and the service\'s credential\'s does not', { timeout: 300_000 }, async () => {
  const r = await check(INBOX);
  assert.equal(r.verdict, 'CLEAN', text(r));
  const grant = (c) => r.machines.find((m) => m.machine === `${c}.Grant`);
  assert.ok(grant('payments'), r.machines.map((m) => m.machine).join(', '));
  // PS17.0: check explores m.c.Grant alone, as for any credential with a holder (M9).
  assert.equal(r.machines.filter((m) => m.machine === 'payments.Grant').length, 1);
  assert.match(JSON.stringify(grant('payments').instance), /one instance per owner \(S461\)/, JSON.stringify(grant('payments').instance));
  assert.doesNotMatch(JSON.stringify(grant('reports').instance), /one instance per owner/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. The runtime: three accounts own items of one source (PT10j, PT10g, PS16.4).
// ---------------------------------------------------------------------------------------------------------------------

/** The desk of this fixture, admitted with both credentials in the KMS store and a vault per credential (grants-helpers). */
const ownDesk = (name) => desk(name, {}, [FIX]);

/**
 * Each owner's grant, requested and granted per owner (PT10g), and a function naming the owner whose token a request
 * carried: 'none' with no authorization, 'unknown' with a token no owner was given. No token is ever printed.
 */
async function grantAll(d, owners = OWNERS) {
  const byToken = new Map();
  for (const o of owners) {
    const tokens = await d.grant('payments', o, ['charges.read']);
    byToken.set(`Bearer ${tokens.access}`, o);
  }
  const whose = (q) => { const a = q?.headers?.authorization; return a ? (byToken.get(a) ?? 'unknown') : 'none'; };
  return whose;
}

/** The inbox adapter, built over a transport (PT10j: the routing handle for an owned source with a holder). */
const inbox = (transport) => openSearchSource({ base: ORIGIN, index: INDEX, transport, owner: 'account', asOf: 'asof', body: 'body' });

/** One recorded search and one recorded document of an owner's own item, as the cluster answers them. */
function ownerAnswers(d, owner, onSearch = null) {
  const asof = new Date(d.clock.now()).toISOString();
  const id = `m-${owner}`;
  d.answers.push(async (q) => {
    assert.equal(q.url, `${ORIGIN}/${INDEX}/_search`);
    if (onSearch) await onSearch(q);
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hits: { hits: [{ _id: id, _source: { account: owner, asof } }] } }) };
  });
  d.answers.push((q) => { assert.equal(q.url, `${ORIGIN}/${INDEX}/_doc/${id}`); return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ found: true, _source: { account: owner, asof, body: `Mail of ${owner}.` } }) }; });
}

async function search(rt, id, account) {
  await rt.dispatch(id, 'Search', { account });
  for (let k = 0; k < 6; k++) { await rt.advance(); await rt.worker.tick(); }
  return (await rt.getState(id)).state;
}

/** PT10j: a handle refuses before sending; a refusal may reject or resolve to one, provided it names the reason. */
async function refused(d, call, reason) {
  const before = d.sent.length;
  let out;
  try { out = await call(); } catch (e) { assert.match(String(e?.message ?? e), reason); assert.equal(d.sent.length, before, 'nothing was sent'); return; }
  assert.match(JSON.stringify(out), reason);
  assert.ok(!(out?.status >= 200 && out?.status < 300), `status ${out?.status}`);
  assert.equal(d.sent.length, before, 'nothing was sent');
}

/** A request through a handle that is expected to go through, answered by the recorded transport; the owner it carried. */
async function through(d, whose, handle) {
  d.answers.push(() => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }));
  const before = d.sent.length;
  const res = await handle.request(REQ);
  assert.equal(res.status, 200);
  assert.equal(d.sent.length, before + 1, 'one request reached the transport');
  return whose(d.sent.at(-1));
}

test('S461, PT10j: each owner\'s retrieval sends its requests under that owner\'s grant, through the routing handle', { timeout: 300_000 }, async () => {
  const d = await ownDesk('sco-each');
  const { rt } = d;
  try {
    const whose = await grantAll(d);
    // PT10g: one Grant instance per owner, grant:payments:<keyed digest of the owner>#<n>.
    const grants = rt.store.db.prepare('SELECT instance_id FROM pr_instance').all().map((r) => r.instance_id).filter((i) => i.startsWith('grant:payments:'));
    assert.equal(new Set(grants).size, 3, grants.join(', '));
    rt.connectSource('inbox', inbox(rt.credentialHandle('payments')));
    for (const o of OWNERS) {
      const id = `d-${o}`;
      await rt.create('srcown.Desk', { id });
      d.answers.length = 0;
      const before = d.sent.length;
      ownerAnswers(d, o);
      const st = await search(rt, id, o);
      assert.deepEqual([st.phase, st.found], ['Idle', 1], `${o}: ${JSON.stringify(st)}`);
      const reached = d.sent.slice(before);
      assert.ok(reached.length >= 1, `${o}'s retrieval reached the cluster`);
      assert.ok(reached.every((q) => q.url.startsWith(`${ORIGIN}/${INDEX}/`)), JSON.stringify(reached.map((q) => q.url)));
      // The owner's own grant, and no other's, carried every request of its retrieval.
      assert.deepEqual([...new Set(reached.map(whose))], [o]);
      // The term filter asks for that owner's items only (K14).
      assert.match(reached[0].body, new RegExp(`"${o}"`));
    }
  } finally { await d.rt.close(); }
});

test('S461, PT10j: inside a retrieval for one owner, a request through another owner\'s handle is refused owner-mismatch and nothing is sent; the routing handle outside a retrieval is refused credential-unavailable', { timeout: 300_000 }, async () => {
  const d = await ownDesk('sco-mismatch');
  const { rt } = d;
  try {
    const whose = await grantAll(d);
    // Outside any retrieval the routing handle has no owner to send under, though every grant is Granted.
    await refused(d, () => rt.credentialHandle('payments').request(REQ), /credential-unavailable/);
    rt.connectSource('inbox', inbox(rt.credentialHandle('payments')));
    await rt.create('srcown.Desk', { id: 'd-b' });
    // While the cluster answers B's search, so inside B's retrieval, a request is made for A's items through A's handle.
    let inner = null;
    const onSearch = async () => {
      try { await refused(d, () => rt.credentialHandle('payments', 'acct-a').request(REQ), /owner-mismatch/); inner = 'refused'; } catch (e) { inner = e; }
    };
    d.answers.length = 0;
    const before = d.sent.length;
    ownerAnswers(d, 'acct-b', onSearch);
    const st = await search(rt, 'd-b', 'acct-b');
    assert.equal(inner, 'refused', String(inner?.message ?? inner));
    // B's own retrieval still went through, under B's grant only: A's grant reached nothing.
    assert.deepEqual([st.phase, st.found], ['Idle', 1], JSON.stringify(st));
    assert.deepEqual([...new Set(d.sent.slice(before).map(whose))], ['acct-b']);
    // A's handle outside any retrieval is the host's sync of A, and sends under A's grant.
    assert.equal(await through(d, whose, rt.credentialHandle('payments', 'acct-a')), 'acct-a');
  } finally { await d.rt.close(); }
});

test('S461, PS16.4: revoking one owner\'s grant stops only that owner\'s requests and retrievals; the other accounts still sync', { timeout: 300_000 }, async () => {
  const d = await ownDesk('sco-revoke');
  const { rt } = d;
  try {
    const whose = await grantAll(d);
    rt.connectSource('inbox', inbox(rt.credentialHandle('payments')));
    for (const o of OWNERS) await rt.create('srcown.Desk', { id: `d-${o}` });
    // Before the revocation, every owner's handle sends under its own grant.
    for (const o of OWNERS) assert.equal(await through(d, whose, rt.credentialHandle('payments', o)), o);
    // PS16.4: the provider's notice that A withdrew the grant.
    d.answers.length = 0;
    d.answers.push(() => ({ status: 200, headers: {}, body: '' }));
    await rt.revokeGrant('payments', 'acct-a', { source: 'provider' });
    await rt.advance();
    d.answers.length = 0;
    // A's handle is refused, and A's retrieval fails, with nothing sent.
    await refused(d, () => rt.credentialHandle('payments', 'acct-a').request(REQ), /credential-unavailable/);
    const before = d.sent.length;
    ownerAnswers(d, 'acct-a');
    const stA = await search(rt, 'd-acct-a', 'acct-a');
    assert.deepEqual([stA.phase, stA.found], ['Idle', 2], JSON.stringify(stA));
    assert.equal(d.sent.length, before, 'no request of A reached the transport after the revocation');
    // B and C still sync: their handles and their retrievals go through, each under its own grant.
    for (const o of ['acct-b', 'acct-c']) {
      d.answers.length = 0;
      assert.equal(await through(d, whose, rt.credentialHandle('payments', o)), o);
      const at = d.sent.length;
      ownerAnswers(d, o);
      const st = await search(rt, `d-${o}`, o);
      assert.deepEqual([st.phase, st.found], ['Idle', 1], `${o}: ${JSON.stringify(st)}`);
      const reached = d.sent.slice(at);
      assert.ok(reached.length >= 1, `${o}'s retrieval reached the cluster`);
      assert.deepEqual([...new Set(reached.map(whose))], [o]);
    }
  } finally { await d.rt.close(); }
});

test('S461, PT10j: connectSource takes the routing handle for an owned source with a holder, and refuses (PL6408) an adapter built with an owner\'s handle', { timeout: 300_000 }, async () => {
  const d = await ownDesk('sco-connect');
  const { rt } = d;
  try {
    await grantAll(d);
    assert.throws(() => rt.connectSource('inbox', inbox(rt.credentialHandle('payments', 'acct-a'))), /PL6408/);
    rt.connectSource('inbox', inbox(rt.credentialHandle('payments')));
  } finally { await d.rt.close(); }
});
