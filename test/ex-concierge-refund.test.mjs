// plan-ex.md E1, S462 (PS17.4b): the concierge's refund acts on one order. The program retrieves the customer's own
// orders, the amount decision cites the one its message is about, and the refund carries that item set (`one order`);
// the handler (examples/concierge/host/refund.mjs) reads it with items.read, refuses unless the order is the requesting
// customer's, and refunds no more than was paid on the order's charge. Tests, from the text and the reviewer's ruling:
//   check: the cut-down refund path is CLEAN; the same emit unguarded is PL6847 with its witness.
//   the handler alone: another customer's order and an amount above what was paid are each refused (the first with no
//     request sent, the second after one read of the charge, and no refund), as are a forged or unstored reference
//     (items.read refuses it), two orders, an order with no charge, and an unpaid charge; a valid refund is the control.
//   at run time over the cut-down path: the control reaches Stripe with the order's charge and the connected account; an
//     amount above what was paid is refused and the customer is told; an answer citing two orders emits nothing; and a
//     guard written with `require` strands the Desk in Extracting, which is why the concierge guards with `if`.
// Recorded traffic only: a fake Stripe, the fixture's orders and answers. No test reaches a provider or calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admit, checkFile } from '@poly/check';
import { grantRequestSubject, signRecord } from '@poly/core';
import { postgresSource, oauthVault, kmsStore, credentialIngress } from '@poly/io';
import { ROOT } from './helpers.mjs';
import { PERSON, handleWith, loaded, makeKey, project } from './runtime-helpers.mjs';
import { fakeStripe, memoryWrap, orderRows, ordersTable } from './ex-concierge-helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'ex-concierge', 'refund-order.poly');
const SRC = readFileSync(FIX, 'utf8');
const OUT = join(ROOT, '.poly', 'test-build', 'ex-concierge-refund');
const hostModule = (f) => import(pathToFileURL(join(ROOT, 'examples', 'concierge', 'host', f)).href);
const { loadAnswers, recordedConcierge } = await hostModule('recorded.mjs');
const { refund, refundForm, REFUNDS_URL, CHARGES_URL } = await hostModule('refund.mjs');
const FIXTURE = loadAnswers(join(ROOT, 'test', 'fixtures', 'concierge', 'answers.json'));
const STRIPE = JSON.parse(readFileSync(join(ROOT, 'std', 'credentials', 'providers', 'stripe-connect.json'), 'utf8'));
const GUARD = `      if cites.count == 1 {
        phase' = Refunding
        large' = value > 100
        emit refund(amount: value, customer: customer, order: cites)
      } else {
        phase' = Answering
        decide reply(question: question, outcome: Unsure)
      }`;
const swap = (src, from, to) => { assert.equal(src.split(from).length, 2, from); return src.split(from).join(to); };
const diagnostics = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics)];

// ── check ──

test('S462 at check: the guarded refund path is CLEAN, and the same emit unguarded is PL6847 with its witness', { timeout: 300_000 }, async () => {
  mkdirSync(OUT, { recursive: true });
  const clean = await checkFile(FIX, { root: join(OUT, 'guarded') });
  assert.equal(clean.verdict, 'CLEAN', JSON.stringify(diagnostics(clean).map((d) => `${d.code} ${d.message}`)));
  const file = join(OUT, 'unguarded.poly');
  writeFileSync(file, swap(SRC, GUARD, `      phase' = Refunding
      large' = value > 100
      emit refund(amount: value, customer: customer, order: cites)`));
  const r = await checkFile(file, { root: join(OUT, 'unguarded') });
  const found = diagnostics(r).filter((d) => d.code === 'PL6847');
  assert.equal(r.verdict, 'FINDINGS', JSON.stringify(diagnostics(r).map((d) => d.code)));
  assert.equal(found.length, 1, JSON.stringify(found.map((d) => d.message)));
  assert.deepEqual(found[0].witness.trace.map((s) => s.action), ['Got', 'Found', 'Amounted']);
});

// ── the handler alone ──

/** The handler's capabilities over a fake Stripe: items.read gives `items`, api answers the charge and the refund. */
function caps({ items, charge = { amount: 4500, amount_refunded: 0, paid: true }, readError = null }) {
  const sent = [];
  return {
    sent,
    items: { read: async (ref) => { if (readError) throw readError; assert.equal(ref, 'items:order'); return items; } },
    api: {
      get: async (url) => { sent.push(['GET', url]); return { status: 200, headers: {}, body: JSON.stringify(charge) }; },
      post: async (url, body) => { sent.push(['POST', url, body]); return { status: 200, headers: {}, body: '{"id":"re_1"}' }; },
    },
  };
}
const order = (o = {}) => ({ id: 'o-1001', owner: 'cust-a', keys: { charge: 'ch_ex1001' }, ...o });
const ask = (amount = 40) => ({ amount, customer: 'cust-a', order: 'items:order' });

test('S462, the handler: a valid refund reads the order\'s charge once and refunds that charge, in cents', async () => {
  const c = caps({ items: [order()] });
  assert.deepEqual(await refund(ask(40), c), { ok: true });
  assert.deepEqual(c.sent, [['GET', `${CHARGES_URL}ch_ex1001`], ['POST', REFUNDS_URL, 'charge=ch_ex1001&amount=4000&reason=requested_by_customer']]);
  // The whole amount paid, and what is left after an earlier part refund, are each allowed.
  assert.deepEqual(await refund(ask(45), caps({ items: [order()] })), { ok: true });
  assert.deepEqual(await refund(ask(30), caps({ items: [order()], charge: { amount: 4500, amount_refunded: 1500, paid: true } })), { ok: true });
});

test('S462, the handler: an order that is not the requesting customer\'s is refused, with no request sent', async () => {
  for (const owner of ['cust-b', 'none', '', null]) {
    const c = caps({ items: [order({ owner })] });
    await assert.rejects(refund(ask(), c), /not the requesting customer's/, String(owner));
    assert.deepEqual(c.sent, [], 'nothing was sent');
  }
});

test('S462, the handler: an amount above what was paid is refused after one read of the charge, and no refund is made', async () => {
  for (const [amount, charge] of [[46, { amount: 4500, amount_refunded: 0, paid: true }], [31, { amount: 4500, amount_refunded: 1500, paid: true }], [1, { amount: 4500, amount_refunded: 4500, paid: true }]]) {
    const c = caps({ items: [order()], charge });
    await assert.rejects(refund(ask(amount), c), /exceeds what was paid/, `${amount} of ${JSON.stringify(charge)}`);
    assert.deepEqual(c.sent, [['GET', `${CHARGES_URL}ch_ex1001`]], 'one read, no POST');
  }
});

test('S462, the handler: a forged or unstored reference, two orders, none, an order with no charge, and an unpaid charge are each refused, and nothing is refunded', async () => {
  const forged = new Error('PL6406 CAPABILITY_REFUSED: items.read of a reference outside the intent\'s payload');
  const c1 = caps({ items: [], readError: forged });
  await assert.rejects(refund(ask(), c1), /PL6406/);
  assert.deepEqual(c1.sent, []);
  for (const [items, why] of [[[order(), order({ id: 'o-1002', keys: { charge: 'ch_ex1002' } })], /exactly one order/], [[], /exactly one order/], [[order({ keys: {} })], /no Stripe charge/], [[order({ keys: { charge: '../refunds' } })], /no Stripe charge/]]) {
    const c = caps({ items });
    await assert.rejects(refund(ask(), c), why);
    assert.deepEqual(c.sent, []);
  }
  const unpaid = caps({ items: [order()], charge: { amount: 4500, amount_refunded: 0, paid: false } });
  await assert.rejects(refund(ask(), unpaid), /not a paid charge/);
  assert.deepEqual(unpaid.sent.map((x) => x[0]), ['GET']);
  assert.throws(() => refundForm('ch_ex1001', 501), /0\.\.500/);
  assert.throws(() => refundForm('ch_ex1001&amount=1', 5), /names a Stripe charge/);
});

// ── at run time over the cut-down path ──

const admitted = {};
async function admittedFix(name, src) {
  admitted[name] ??= (async () => {
    const key = makeKey(name);
    const dir = project(name, [], key, 'test-ex-concierge');
    writeFileSync(join(dir, 'src', 'concierge.poly'), src);
    writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8')), credentials: { payments: { store: 'kms' } } }, null, 2));
    const r = await admit(dir);
    return { dir, build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } };
  })();
  return admitted[name];
}

/** Loads the cut-down path with the merchant's grant, a fake Stripe over `charges`, and the recorded providers of `fixture`. */
async function desk(name, src, fixture = FIXTURE, charges = {}) {
  const a = await admittedFix(name, src);
  const { rt } = await loaded(a, { verifier: (c) => (c ? { principal: c.principal } : null) });
  const table = ordersTable(orderRows(FIXTURE));
  rt.connectSource('orders', postgresSource({ query: table.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary', keys: { charge: 'charge_id' } }));
  const p = recordedConcierge(fixture);
  rt.provide('amount', p.decisions.amount);
  rt.provide('reply', p.decisions.reply);
  handleWith(rt, 'payments.refund', refund);
  const { http, sent: stripe } = fakeStripe(FIXTURE, STRIPE, charges);
  const vault = oauthVault(STRIPE, { clientId: 'ca_concierge', redirectUri: 'https://concierge.example/credentials/payments', clientSecret: `sk_test_${randomBytes(12).toString('hex')}` }, kmsStore(memoryWrap()), { http });
  rt.connectVault('payments', vault);
  const callback = credentialIngress(rt, { payments: vault }, () => rt.now());
  const approvals = join(a.dir, 'approvals');
  mkdirSync(approvals, { recursive: true });
  writeFileSync(join(approvals, '00.json'), JSON.stringify({ kind: 'grant-request', credential: 'payments', holder: 'merchant-1', record: signRecord({ kind: 'grant-request', subject: grantRequestSubject('payments', 'merchant-1'), by: PERSON.keyId, at: '2026-10-10T00:00:00.000Z' }, PERSON.privateKeyPem) }));
  assert.deepEqual((await rt.takeApprovals(approvals)).map((x) => x.outcome), ['applied']);
  const url = rt.takeAuthorizations().find((x) => x.credential === 'payments').url;
  assert.equal((await callback('payments', { method: 'GET', url: `https://concierge.example/credentials/payments?code=ac_${randomBytes(6).toString('hex')}&state=${new URL(url).searchParams.get('state')}`, headers: {}, body: '' })).status, 200);
  const say = async (id, customer, message) => {
    await rt.create('concierge.Desk', { id });
    await rt.dispatch(id, 'Got', { body: await rt.putContent(FIXTURE.messages.find((m) => m.id === message).text) }, { credentials: { principal: customer } });
    for (let k = 0; k < 30; k++) { await rt.advance(); await rt.worker.tick(); }
    return (await rt.getState(id)).state.phase;
  };
  return { rt, p, stripe, say };
}
const withAmount = (value, cites) => {
  const f = structuredClone(FIXTURE);
  const m = f.messages.find((x) => x.id === 'refund-small');
  if (value !== undefined) m.amount.answer = value;
  if (cites) m.amount.cites = cites;
  m.replies.Unsure = 'We could not work out the refund you asked for. A member of staff will contact you.';
  return f;
};
/** What the gate and the steps did on an instance, for a failure's message. */
const outbox = (rt) => [...rt.store.db.prepare('SELECT kind, status, attempts, last_error FROM pr_outbox').all(), ...rt.store.db.prepare('SELECT action, rule, reason FROM pr_audit').all()].map((r) => JSON.stringify(r)).join('; ');
const trace = async (rt, id) => (await rt.chain(id)).map((e) => [e.kind, e.body?.effectKind ?? e.body?.action ?? e.body?.stage, e.body?.outcome ?? e.body?.stepKind, e.body?.reason ?? null, ...(process.env.EX_DEBUG ? [JSON.stringify(e.body).slice(0, 300)] : [])]);
const replies = (p) => p.asked.filter((a) => a.decision === 'reply').map((a) => a.outcome);

test('S462 at run time: the control. A refund of 40 on cust-a\'s lamp reads its charge, refunds that charge through the grant, and the customer is told', { timeout: 300_000 }, async () => {
  const { rt, stripe, p, say } = await desk('ex-refund-control', SRC);
  try {
    assert.equal(await say('d-1', 'cust-a', 'refund-small'), 'Idle');
    assert.deepEqual(stripe.map((q) => [q.method, q.url, q.account]), [['GET', `${CHARGES_URL}ch_ex1001`, 'acct_1Merchant'], ['POST', REFUNDS_URL, 'acct_1Merchant']], JSON.stringify(await trace(rt, 'd-1')) + (process.env.EX_DEBUG ? outbox(rt) : ''));
    assert.deepEqual(Object.fromEntries(new URLSearchParams(stripe[1].body)), { charge: 'ch_ex1001', amount: '4000', reason: 'requested_by_customer' });
    // The refund is idempotent: a retried POST of the intent is the same refund.
    assert.match(stripe[1].key, /^[0-9a-f]{16,}$/);
    assert.equal(stripe[0].key, undefined);
    assert.deepEqual(replies(p), ['Refunded']);
  } finally { await rt.close(); }
});

test('S462 at run time: an amount above what was paid on the order\'s charge is refused after one read; no refund is made, and the customer is told it was declined', { timeout: 300_000 }, async () => {
  const { rt, stripe, p, say } = await desk('ex-refund-over', SRC, withAmount(60));
  try {
    assert.equal(await say('d-1', 'cust-a', 'refund-small'), 'Idle');
    assert.deepEqual(stripe.map((q) => [q.method, q.url]), [['GET', `${CHARGES_URL}ch_ex1001`]]);
    assert.deepEqual(replies(p), ['Declined']);
  } finally { await rt.close(); }
});

test('S462 at run time: an answer citing two orders emits no refund, reads no charge, and is answered Unsure', { timeout: 300_000 }, async () => {
  const { rt, stripe, p, say } = await desk('ex-refund-two', SRC, withAmount(undefined, ['o-1001', 'o-1002']));
  try {
    assert.equal(await say('d-1', 'cust-a', 'refund-small'), 'Idle');
    assert.deepEqual(stripe, []);
    assert.equal(rt.store.db.prepare("SELECT COUNT(*) AS n FROM pr_outbox WHERE kind = 'payments.refund'").get().n, 0, 'no refund intent was made');
    assert.deepEqual(replies(p), ['Unsure']);
  } finally { await rt.close(); }
});

test('S462 at run time: a message about an order the customer does not have is uncited and answered Unsure, with nothing sent to Stripe', { timeout: 300_000 }, async () => {
  const { rt, stripe, p, say } = await desk('ex-refund-none', SRC, withAmount(undefined, ['o-2001']));
  try {
    assert.equal(await say('d-1', 'cust-a', 'refund-small'), 'Idle');
    assert.deepEqual(stripe, []);
    assert.deepEqual(replies(p), ['Unsure']);
  } finally { await rt.close(); }
});

test('S462: a guard written with require checks CLEAN, but a rejected completion leaves the Desk in Extracting with no reply, which is why the concierge guards with if', { timeout: 300_000 }, async () => {
  const strict = swap(swap(SRC, `    if conf >= 0.8 {
${GUARD}
    } else {`, `    require cites.count == 1 else reject "not-one"
    if conf >= 0.8 {
      phase' = Refunding
      large' = value > 100
      emit refund(amount: value, customer: customer, order: cites)
    } else {`), `    require phase == Extracting else reject "not-extracting"
    require cites.count == 1`, `    require phase == Extracting else reject "not-extracting"
    require cites.count == 1`);
  const file = join(OUT, 'require.poly');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(file, strict);
  const r = await checkFile(file, { root: join(OUT, 'require') });
  assert.equal(r.verdict, 'CLEAN', JSON.stringify(diagnostics(r).map((d) => `${d.code} ${d.message}`)));
  const { rt, stripe, p, say } = await desk('ex-refund-require', strict, withAmount(undefined, ['o-1001', 'o-1002']));
  try {
    assert.equal(await say('d-1', 'cust-a', 'refund-small'), 'Extracting');
    assert.deepEqual(stripe, []);
    assert.deepEqual(replies(p), [], 'the customer is never answered');
  } finally { await rt.close(); }
});

test('AC30 at run time: an amount outside 0..500 is refused as the completion\'s type, journaled in the audit, and nothing is sent to Stripe; the customer is answered Unsure', { timeout: 300_000 }, async () => {
  const { rt, stripe, p, say } = await desk('ex-refund-outside', SRC);
  try {
    assert.equal(await say('d-1', 'cust-b', 'refund-outside'), 'Idle');
    const audit = rt.store.db.prepare('SELECT action, rule, reason FROM pr_audit').all();
    assert.ok(audit.some((a) => a.action === 'Amounted' && a.rule === 'S140' && /outside 0\.\.500/.test(a.reason)), JSON.stringify(audit));
    assert.deepEqual(stripe, []);
    assert.equal(rt.store.db.prepare("SELECT COUNT(*) AS n FROM pr_outbox WHERE kind = 'payments.refund'").get().n, 0);
    assert.deepEqual(replies(p), ['Unsure']);
  } finally { await rt.close(); }
});
