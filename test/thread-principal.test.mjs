// S450 (PS15.0a, PS15.4, PS17.3, PS3.2, PT10a, decisions-v1.md "S450: how the application learns the thread's
// principal"): a channel may declare `principal from f`; each std kind's Sender claims are { verified, principal }; an
// application action bound to a Peer action may declare `by c: C` and receives the Inbound's verified claims restricted
// to C's fields. The thread's principal is fixed by the first message the host maps (rt.mapSenders), is the recipient
// principal of channel.c.send in the flow rule, and a later message mapped to another principal is refused
// principal-mismatch on runtime:ingress. Written from the specification text alone.
//
// The fixtures are kept small so every check and admission takes seconds: the checks of the flow rule run the desk on
// the tests' kind (test/fixtures/thread-principal/std), and only the run-time tests admit it on std's whatsapp kind.
// The run-time tests use WhatsApp, not SMS: rt.mapSenders maps only a sender the adapter verified (PT10a), and an SMS
// sender is never verified (AC14), so on SMS no thread's principal is ever fixed.
// A channel application that replies tainted content is PL6838 on the application alone (S322), so no test asserts
// CLEAN for the desk; each asserts the presence or absence of the S450 codes and of PL6831.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { admitWitness, checkFile } from '@poly/check';
import { postgresSource, whatsapp } from '@poly/io';
import { ROOT } from './helpers.mjs';
import { loaded, makeKey, project } from './runtime-helpers.mjs';
import { ORDERS, pgOrders } from './memory-helpers.mjs';
import { recorded, whatsappWebhook, WA_FROM } from './concierge-helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'thread-principal');
const STD = join(FIX, 'std');
const TICKET = readFileSync(join(FIX, 'ticket.poly'), 'utf8');
const DESK = readFileSync(join(FIX, 'desk.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-thread-principal');
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
const all = (r) => [...(r.diagnostics ?? []), ...(r.machines ?? []).flatMap((m) => m.diagnostics ?? []), ...(r.configurations ?? []).flatMap((c) => c.diagnostics ?? [])];
const codes = (r) => all(r).map((d) => d.code);
const text = (r) => `${r.verdict} ${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
const S450_CODES = ['PL1001', 'PL1201', 'PL6815'];

// The desk on the tests' kind, whose Rejected reason is also "window-closed".
const ON_TEST = swap(swap(DESK, 'channel support: whatsapp {', 'channel support: test {'), 'adapter "whatsapp"', 'adapter "test"');
// AC22: the retrieval has no owner predicate, so its taint is every principal (Ω, S326), and its answer is replied on a
// thread whose principal is one customer.
const unowned = (src) => swap(src, 'retrieve orders where owner == customer limit 1', 'retrieve orders limit 1');

let n = 0;
async function check(src, opts = {}) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), src);
  const r = await checkFile(join(d, 'm.poly'), { root: d, ...opts });
  return { r, dir: d };
}

// ── check ──

test('S450: principal from a Principal field of the kind\'s Sender is accepted and recorded in the channel\'s descriptor; from another type it is PL1201, from no field PL1001', { timeout: 120_000 }, async () => {
  const { r, dir } = await check(TICKET, { std: STD });
  assert.ok(!codes(r).some((c) => S450_CODES.includes(c)), text(r));
  assert.equal(r.verdict, 'CLEAN', text(r));
  // PT10a: the descriptor channels/<c>.json records it as principal.
  const descriptor = join(dir, '.poly', 'build', 'channels', 'support.json');
  assert.ok(existsSync(descriptor), descriptor);
  assert.equal(JSON.parse(readFileSync(descriptor, 'utf8')).principal, 'principal');

  const typed = (await check(swap(TICKET, 'principal from principal', 'principal from verified'), { std: STD })).r;
  assert.ok(codes(typed).includes('PL1201'), text(typed));
  const none = (await check(swap(TICKET, 'principal from principal', 'principal from nosuch'), { std: STD })).r;
  assert.ok(codes(none).includes('PL1001'), text(none));
});

test('S450: a std kind\'s Sender carries verified beside principal, so principal from verified on a whatsapp channel is PL1201', { timeout: 120_000 }, async () => {
  const typed = (await check(swap(DESK, 'principal from principal', 'principal from verified'))).r;
  assert.ok(codes(typed).includes('PL1201'), text(typed));
});

test('S450: an action bound to Message may declare by c: Customer with Sender\'s field principal; a claims field Sender lacks, or of another type, is PL6815', { timeout: 120_000 }, async () => {
  const { r } = await check(TICKET, { std: STD });
  assert.ok(!codes(r).includes('PL6815'), text(r));
  const absent = (await check(swap(swap(TICKET, 'claims Customer {\n  principal: Principal\n}', 'claims Customer {\n  account: Principal\n}'), "who' = c.principal", "who' = c.account"), { std: STD })).r;
  assert.ok(codes(absent).includes('PL6815'), text(absent));
  const other = (await check(swap(swap(TICKET, 'claims Customer {\n  principal: Principal\n}', 'enum Tier { Gold }\n\nclaims Customer {\n  principal: Tier\n}'), "    who' = c.principal\n", ''), { std: STD })).r;
  assert.ok(codes(other).includes('PL6815'), text(other));
});

test('S450, PS17.3: the desk replies its customer\'s own orders on the customer\'s thread with no PL6831; the AC22 variant replying orders of every principal is PL6831', { timeout: 120_000 }, async () => {
  const { r } = await check(ON_TEST, { std: STD });
  assert.ok(!codes(r).some((c) => S450_CODES.includes(c)), text(r));
  assert.ok(!r.error, text(r));
  assert.ok(!codes(r).includes('PL6831'), `the thread's principal is the reply's recipient: ${text(r)}`);
  const leak = (await check(unowned(ON_TEST), { std: STD })).r;
  assert.ok(!codes(leak).some((c) => S450_CODES.includes(c)), text(leak));
  const f = all(leak).find((d) => d.code === 'PL6831');
  assert.ok(f, text(leak));
  assert.ok(f.witness?.length > 0, JSON.stringify(f));
});

// ── run time ──

const verifier = (c) => (c ? { principal: c.principal } : null);
const once = {};
/**
 * Admits a desk program once per source, with a witness certificate (S139): the desk is PL6838 on the application alone
 * today (S322) and its AC22 variant has a finding, so neither is admitted by `admit`, and calling it first would run the
 * check twice.
 */
async function admitted(name, src) {
  once[name] ??= (async () => {
    const key = makeKey(name);
    const dir = project(name, [], key, 'test-thread-principal');
    writeFileSync(join(dir, 'src', 'desk.poly'), src);
    const w = await admitWitness(dir, { root: dir, key: { id: key.id, privateKeyPem: readFileSync(key.file, 'utf8') }, out: join(dir, '.poly', 'witness.certificate.json') });
    return { build: join(dir, '.poly', 'build'), certificate: w.certificatePath, trust: { [key.id]: key.publicKey } };
  })();
  return once[name];
}

/**
 * Loads a desk with its channel on a recorded WhatsApp transport, an orders source over `db` (the recorded rows of
 * cust-a and cust-b by default), and an answer that quotes every item it was given.
 */
async function desk(name, src, db = pgOrders()) {
  const a = await admitted(name, src);
  const { rt, clock } = await loaded(a, { allowWitness: true, verifier });
  const secret = () => randomBytes(32).toString('hex');
  const wa = { appSecret: secret(), accessToken: secret(), phoneNumberId: '106540352242922', verifyToken: secret(), apiVersion: 'v23.0' };
  const out = [];
  rt.connectChannel('support', whatsapp(wa), { http: { async request(q) { out.push(q); return { status: 200, headers: {}, body: recorded('whatsapp/send-response.json') }; } } });
  rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
  rt.provide('answer', { provider: (_q, m) => {
    const t = `Your orders: ${Object.values(m.items).flat().map((i) => i.body).join(' ')}`;
    return { answer: t, distribution: [[t, 0.9]], cites: [] };
  }, model: 'flash' });
  return { rt, clock, wa, out, db };
}
const settle = async (rt) => { for (let k = 0; k < 12; k++) { await rt.advance(); await rt.worker.tick(); } };
/** The recorded WhatsApp message from WA_FROM, with its own provider message id and text, signed under the app secret. */
function message(wa, body, k) {
  const m = JSON.parse(recorded('whatsapp/message.json'));
  Object.assign(m.entry[0].changes[0].value.messages[0], { id: `wamid.tp-${k}`, text: { body } });
  return whatsappWebhook(wa, JSON.stringify(m));
}
const sends = (out) => out.filter((q) => q.url.endsWith('/messages'));
const verdicts = (rt) => rt.store.db.prepare("SELECT event FROM poly_ledger WHERE kind = 'verdict'").all().map((x) => JSON.parse(x.event).body).filter((b) => b?.effectKind === 'channel.support.send');
const retrievals = (db) => db.seen.filter((s) => s.text.startsWith('SELECT "order_id"'));
const ownersAsked = (db) => retrievals(db).map((s) => (s.params.length === 2 ? s.params[0] : null));
const bodiesRead = (db) => db.seen.filter((s) => s.text.startsWith('SELECT "summary"')).map((s) => s.params[0]);
/** Orders whose owner is whoever asks: an unmapped sender's own principal owns a lamp order. */
function askersOrders() {
  const seen = [];
  const query = async (q, params) => {
    seen.push({ text: q, params });
    if (q.startsWith('SELECT "order_id" AS id')) return { rows: params.length === 2 ? [{ id: 'o-9', owner: params[0], as_of: '2026-10-06T12:00:00Z' }] : [] };
    if (q.startsWith('SELECT "summary" AS body')) return { rows: [{ body: 'Order 9: a lamp.' }] };
    throw new Error(`unexpected query ${q}`);
  };
  return { query, seen };
}

test('S450: the sender mapped to cust-a fixes the thread\'s principal; Got receives it as claims, and the reply citing cust-a\'s orders is sent to it', { timeout: 120_000 }, async () => {
  const { rt, wa, out, db } = await desk('tp-desk', DESK);
  try {
    const mapped = [];
    rt.mapSenders('support', (sender, verified) => { mapped.push([sender, verified]); return 'cust-a'; });
    await rt.receive('support', message(wa, 'Where is my order?', 1));
    await settle(rt);
    assert.ok(mapped.length >= 1, 'rt.receive calls the mapper for the verified sender');
    const app = await rt.threadId('support', WA_FROM);
    // PT10a: the thread's principal is kept beside the thread.
    assert.equal(await rt.threadPrincipal(app), 'cust-a');
    // PS15.4: Got takes the Inbound's verified claims restricted to Customer's fields, so the desk stores cust-a.
    assert.equal((await rt.getState(app)).state.customer, 'cust-a');
    assert.deepEqual(ownersAsked(db), ['cust-a']);
    // PS17.3: the recipient of channel.support.send has the thread's principal, cust-a, so the reply is allowed.
    assert.deepEqual(verdicts(rt).filter((v) => v.outcome === 'denied'), [], JSON.stringify(verdicts(rt)));
    assert.equal(sends(out).length, 1, `the answer reached its customer ${JSON.stringify(verdicts(rt))}`);
    // The reply's body carries cust-a's newest order and is owned by cust-a alone.
    const payloads = rt.store.db.prepare("SELECT payload FROM pr_outbox WHERE kind = 'channel.support.send'").all().map((x) => JSON.parse(x.payload));
    const bodies = [];
    for (const p of payloads) for (const v of Object.values(p)) if (typeof v === 'string' && v.startsWith('sha256:') && /lamp/.test((await rt.contentBody(v)) ?? '')) bodies.push(v);
    assert.equal(bodies.length, 1, JSON.stringify(payloads));
    assert.deepEqual(rt.memory.taintOf(bodies[0]), { c: 1, o: ['cust-a'] });
  } finally { await rt.close(); }
});

test('S450, AC22: on a thread whose principal is cust-a, a reply carrying cust-b\'s order (from a retrieval owned by every principal) is denied audience and not sent', { timeout: 120_000 }, async () => {
  // cust-b's chair is the newest order, so the retrieval with no owner predicate and limit 1 returns it.
  const rows = ORDERS.map((r) => (r.customer_id === 'cust-b' ? { ...r, updated_at: '2026-10-07T08:00:00Z' } : r));
  const { rt, wa, out, db } = await desk('tp-desk-unowned', unowned(DESK), pgOrders(rows));
  try {
    rt.mapSenders('support', () => 'cust-a');
    await rt.receive('support', message(wa, 'Where is my order?', 2));
    await settle(rt);
    const app = await rt.threadId('support', WA_FROM);
    assert.equal(await rt.threadPrincipal(app), 'cust-a');
    assert.deepEqual(ownersAsked(db), [null], 'the retrieval named no owner');
    assert.deepEqual(bodiesRead(db), ['o-3'], 'the desk read cust-b\'s order');
    assert.equal(sends(out).length, 0, 'nothing reached the customer');
    const denied = verdicts(rt).find((v) => v.outcome === 'denied');
    assert.ok(denied, JSON.stringify(verdicts(rt)));
    assert.equal(denied.reason, 'audience');
  } finally { await rt.close(); }
});

test('S450, fail closed: with no mapping the thread has no principal, so a reply carrying the customer\'s owned orders is denied audience', { timeout: 120_000 }, async () => {
  const { rt, wa, out, db } = await desk('tp-desk', DESK, askersOrders());
  try {
    let calls = 0;
    rt.mapSenders('support', () => { calls++; return null; });
    await rt.receive('support', message(wa, 'Where is my order?', 3));
    await settle(rt);
    assert.ok(calls >= 1, 'the mapper was asked');
    const app = await rt.threadId('support', WA_FROM);
    // PT10a: an unmapped sender's principal is the keyed digest of its address, which never fixes the thread's.
    assert.equal(await rt.threadPrincipal(app), null);
    const asked = ownersAsked(db);
    assert.equal(asked.length, 1, JSON.stringify(asked));
    assert.ok(typeof asked[0] === 'string' && asked[0] !== 'cust-a' && !asked[0].includes(WA_FROM), `the sender's own principal: ${asked[0]}`);
    assert.equal((await rt.getState(app)).state.customer, asked[0]);
    assert.deepEqual(bodiesRead(db), ['o-9'], 'the desk read the order its sender owns');
    assert.equal(sends(out).length, 0, 'an unmapped sender gives the recipient no principal');
    const denied = verdicts(rt).find((v) => v.outcome === 'denied');
    assert.ok(denied, JSON.stringify(verdicts(rt)));
    assert.equal(denied.reason, 'audience');
  } finally { await rt.close(); }
});

test('S450, PS15.4: a later message on the thread whose sender maps to another principal is refused principal-mismatch on runtime:ingress and does not reach the conversation; the thread keeps cust-a', { timeout: 120_000 }, async () => {
  const { rt, wa } = await desk('tp-desk', DESK);
  try {
    let who = 'cust-a';
    rt.mapSenders('support', () => who);
    await rt.receive('support', message(wa, 'Where is my order?', 4));
    await settle(rt);
    const app = await rt.threadId('support', WA_FROM);
    const inbound = async () => (await rt.getJournal(`${app}/support`)).filter((j) => j.action === 'Inbound').length;
    const got = async () => (await rt.getJournal(app)).filter((j) => j.action === 'Got').length;
    assert.equal(await inbound(), 1);
    assert.equal(await got(), 1);
    assert.equal(await rt.threadPrincipal(app), 'cust-a');

    who = 'cust-b';
    await rt.receive('support', message(wa, 'And the other one?', 5));
    await settle(rt);
    const records = (await rt.chain('runtime:ingress')).map((e) => e.body);
    const refused = records.filter((b) => b?.reason === 'principal-mismatch');
    assert.equal(refused.length, 1, JSON.stringify(records));
    assert.equal(refused[0].outcome, 'refused');
    assert.equal(await inbound(), 1, 'the refused message reached no conversation');
    assert.equal(await got(), 1);
    assert.equal(await rt.threadPrincipal(app), 'cust-a');
    assert.equal((await rt.getState(app)).state.customer, 'cust-a');
    // PT10a: the thread's principal is journaled by its keyed digest, never in the clear.
    assert.ok(!JSON.stringify(records).includes('cust-a'), JSON.stringify(records));

    // The thread keeps cust-a: a message mapped to cust-a again is not refused.
    who = 'cust-a';
    await rt.receive('support', message(wa, 'Thanks', 6));
    await settle(rt);
    const after = (await rt.chain('runtime:ingress')).map((e) => e.body).filter((b) => b?.reason === 'principal-mismatch');
    assert.equal(after.length, 1, 'only the message mapped to cust-b was refused');
    assert.equal(await inbound(), 2);
  } finally { await rt.close(); }
});
