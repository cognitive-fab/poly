// M10 step 11, S320 to S327 as ruled (decisions-m10.md, PT10m): each ruling's test, written before its change and
// failing on the code before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { admit, admitWitness, checkFile, checkProject } from '@poly/check';
import { forgetSubject, memoryVerifySubject, signRecord } from '@poly/core';
import { load } from '@poly/runtime';
import { postgresSource, openSearchSource, sms } from '@poly/io';
import { ROOT } from './helpers.mjs';
import { handleWith, loaded, makeKey, project, PERSON } from './runtime-helpers.mjs';
import { pgOrders } from './memory-helpers.mjs';
import { recorded, smsWebhook, SMS_FROM } from './concierge-helpers.mjs';

const fixture = (n) => readFileSync(join(ROOT, 'test', 'fixtures', 'm10', n), 'utf8');
const CONCIERGE = fixture('concierge-memory.poly');
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
const verifier = (c) => (c ? { principal: c.principal } : null);
const sign = (kind, subject) => signRecord({ kind, subject, by: PERSON.keyId, at: '2026-10-08T00:00:00.000Z' }, PERSON.privateKeyPem);
const REMEMBERING = swap(swap(swap(CONCIERGE, 'enum Phase', 'source memory: memory {\n  audience customer owned\n}\n\nenum Phase'),
  '    emit reply(customer: customer, body: text)\n', '    emit reply(customer: customer, body: text)\n    emit note(subject: customer, fact: text)\n'),
  '  effect reply(', '  effect note(subject: Principal, fact: Content) {\n    remember memory as derived about subject\n  }\n\n  effect reply(');

async function check(name, src) {
  const dir = join(ROOT, '.poly', 'test-runtime', name);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'm.poly'), src);
  return checkFile(join(dir, 'm.poly'), { root: dir });
}
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics)];

async function build(name, src) {
  const key = makeKey(name);
  const dir = project(name, ['test/fixtures/m10/concierge-memory.poly'], key, 'test-runtime');
  writeFileSync(join(dir, 'src', 'concierge-memory.poly'), src);
  const r = await admit(dir);
  return { ...(await loaded({ build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } }, { verifier })), r, dir, key };
}
async function ask(rt, customer, rows) {
  const db = pgOrders(rows);
  rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
  rt.provide('answer', { provider: (_q, m) => ({ answer: `About ${Object.values(m.items).flat().map((i) => i.id).join(', ')}`, distribution: [['x', 0.9]], cites: Object.values(m.items).flat().map((i) => i.id) }), model: 'flash' });
  const sent = [];
  handleWith(rt, 'support.reply', (p) => { sent.push(p); return { ok: true }; });
  await rt.create('concierge_memory.Desk', { id: 'desk' });
  await rt.dispatch('desk', 'Ask', { question: await rt.putContent('Where is my order?') }, { credentials: { principal: customer } });
  for (let k = 0; k < 8; k++) await rt.worker.tick();
  return { db, sent };
}

test('S320: remember as verified is PL6837, refused; as derived it is clean', async () => {
  const r = await check('rulings-s320', REMEMBERING.replace('remember memory as derived', 'remember memory as verified'));
  assert.equal(r.verdict, 'REFUSED');
  assert.ok(all(r).some((d) => d.code === 'PL6837'), JSON.stringify(all(r).map((d) => d.code)));
  assert.equal((await check('rulings-s320-ok', REMEMBERING)).verdict, 'CLEAN');
});

test('S321: verify and forget records are bound to the anchor; another anchor\'s record is refused wrong-project before it is taken', async () => {
  const { rt } = await build('rulings-s321', REMEMBERING);
  try {
    await ask(rt, 'cust-a');
    const anchor = rt.anchorId;
    assert.match(anchor ?? '', /\S/, 'the runtime knows its anchor');
    const item = rt.store.db.prepare('SELECT item FROM poly_memory').get().item;
    await assert.rejects(rt.verifyMemory(item, sign('verify', memoryVerifySubject('another-anchor', item))), (e) => e.reason === 'wrong-project');
    await assert.rejects(rt.forget({ subject: 'cust-a' }, sign('forget', forgetSubject('another-anchor', { subject: 'cust-a' }))), (e) => e.reason === 'wrong-project');
    assert.equal(rt.store.db.prepare('SELECT count(*) AS n FROM poly_used_record').get().n, 0);
    await rt.verifyMemory(item, sign('verify', memoryVerifySubject(anchor, item)));
    assert.ok((await rt.forget({ subject: 'cust-a' }, sign('forget', forgetSubject(anchor, { subject: 'cust-a' })))).erased.length);
  } finally { await rt.close(); }
});

test('S322: a timer\'s firing keeps the taint of the step that set it, so its leak is PL6831', async () => {
  const r = await check('rulings-s322-timer', fixture('review-timer.poly'));
  assert.ok(all(r).some((d) => d.code === 'PL6831'), `${r.verdict} ${JSON.stringify(all(r).map((d) => d.code))}`);
});

test('S322: a tainted message no configuration follows is PL6838, inconclusive, naming the message; with a configuration it is judged there', async () => {
  const r = await check('rulings-s322-message', fixture('review-message.poly'));
  const d = all(r).find((x) => x.code === 'PL6838');
  assert.ok(d, `${r.verdict} ${JSON.stringify(all(r).map((x) => x.code))}`);
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.match(d.message, /Forward/);
  assert.match(d.message, /Relay/);
  const withConfig = fixture('review-message.poly') + '\nconfiguration c {\n  d : Desk\n  y : Relay\n  inputs { d.Ask }\n  bounds { transit 1 }\n}\n';
  const c = await check('rulings-s322-config', withConfig);
  assert.ok(!all(c).some((x) => x.code === 'PL6838'), JSON.stringify(all(c).map((x) => x.code)));
  assert.ok(all(c).some((x) => x.code === 'PL6831'), JSON.stringify(all(c).map((x) => x.code)));
});

test('S324: the claims class is the claimant\'s; a staff member forwarding to another principal is judged at the effect\'s class', async () => {
  const r = await check('rulings-s324', fixture('review-staff-forward.poly'));
  assert.ok(all(r).some((d) => d.code === 'PL6831'), `${r.verdict} ${JSON.stringify(all(r).map((d) => d.code))}`);
});

test('S323, S325: the certificate lists a decision with a finite answer over tainted data, and a count over another owner\'s items; a policy denies a decision by its taint', { timeout: 300_000 }, async () => {
  let src = swap(CONCIERGE, 'enum Phase { Idle, Looking, Answering }', 'enum Phase { Idle, Looking, Answering }\nenum Verdict { Late, OnTime }');
  src = swap(src, '  effect lookup(customer: Principal) {\n    retrieve orders where owner == customer limit 2', '  effect lookup(customer: Principal) {\n    retrieve orders limit 2');
  src = swap(src, '    phase\' = Answering\n    decide answer(question: question, context: items)', '    require items.count >= 0 else reject "none"\n    phase\' = Answering\n    decide answer(question: question, context: items)\n    decide late(context: items)');
  src = swap(src, '  effect reply(', '  decision late(context: Items) -> Verdict {\n    provider "flash"\n    labels { egress:external, read:private }\n    timeout 2s\n    ok(r) -> Answered2(v: r.answer)\n    failed -> AnswerFailed()\n  }\n\n  effect reply(');
  src = swap(src, '  action AnswerFailed()', '  action AnswerFailed()\n  action Answered2(v: Verdict)');
  src = swap(src, '  on AnswerFailed {', '  on Answered2(v) {\n    require phase == Answering else reject "not-answering"\n    phase\' = Idle\n  }\n\n  on AnswerFailed {');
  const key = makeKey('rulings-s323');
  const dir = project('rulings-s323', ['test/fixtures/m10/concierge-memory.poly'], key, 'test-runtime');
  writeFileSync(join(dir, 'src', 'concierge-memory.poly'), src);
  const p = await checkProject(dir);
  const declassify = p.files.flatMap((f) => f.machines ?? []).flatMap((m) => m.declassify ? [m.declassify] : []);
  const r = await admitWitness(dir, { root: dir, key: { id: key.id, privateKeyPem: readFileSync(key.file, 'utf8') }, out: join(dir, '.poly', 'witness.certificate.json') }).catch((e) => ({ error: e }));
  const cert = r.error ? null : JSON.parse(readFileSync(r.certificatePath, 'utf8'));
  const dec = cert?.poly?.memory?.declassify;
  assert.ok(dec, `no declassify in the certificate (${r.error?.message ?? ''}) ${JSON.stringify(declassify)}`);
  assert.deepEqual(dec.decisions, [{ kind: 'decision.late', class: 'customer', answers: 2 }]);
  assert.deepEqual(dec.counts.map((c) => [c.machine, c.action, c.param, c.retrieval]), [['Desk', 'Found', 'items', 'source.orders.retrieve']]);
  // A policy can deny such a decision by its taint: the never below is refuted without a rule behind it.
  const pol = 'module concierge_memory_policy\n\npolicy p {\n  scope "concierge_memory"\n  obligation o "None." rule {\n    when proposal.kind == "effect" && effect.kind == "support.reply"\n    require true else deny\n    on unknown deny\n  }\n  never n "No late verdict over customer data.": allow when effect.kind == "decision.late" && effect.taint.class == "customer"\n}\n';
  writeFileSync(join(dir, 'src', 'p.policy.poly'), pol);
  const q = await checkProject(dir);
  assert.ok(q.files.flatMap((f) => f.policies.flatMap((x) => x.diagnostics)).some((d) => d.code === 'PL6503'));
});

test('S323: a decision is proposed with the taint of what it reads', async () => {
  const { rt } = await build('rulings-s323-run', CONCIERGE);
  try {
    const db = pgOrders();
    rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
    const set = await rt.memory.retrieve('orders', { owner: 'customer', limit: 2 }, { customer: 'cust-a' }, 'i-1');
    const r = rt.memory.check({ machineId: 'concierge_memory.Desk', kind: 'decision.answer', payload: { context: set.items }, decl: { decision: {} }, step: { action: 'Found', claims: null }, channelAudience: null, approved: false, now: rt.now(), keyed: (s) => `k(${s})` });
    assert.equal(r.fields.taint?.class, 'customer', JSON.stringify(r));
  } finally { await rt.close(); }
});

test('S326: a retrieval with no owner predicate is Ω at run time, so the leak variant\'s reply is denied even when the orders are the asker\'s; a forget still erases by the real owners', async () => {
  const key = makeKey('rulings-s326');
  const dir = project('rulings-s326', ['test/fixtures/m10/concierge-memory.poly'], key, 'test-runtime');
  writeFileSync(join(dir, 'src', 'concierge-memory.poly'), swap(CONCIERGE, ' where owner == customer', ''));
  const w = await admitWitness(dir, { root: dir, key: { id: key.id, privateKeyPem: readFileSync(key.file, 'utf8') }, out: join(dir, '.poly', 'witness.certificate.json') });
  const rt = await load(join(dir, '.poly', 'build'), { certificate: w.certificatePath, trust: { [key.id]: key.publicKey }, allowWitness: true, verifier, now: () => 1_790_000_000_000 });
  try {
    // Only cust-a's orders exist, so the set's real owners are cust-a alone.
    const { sent } = await ask(rt, 'cust-a', [{ order_id: 'o-1', customer_id: 'cust-a', updated_at: '2026-10-06T12:00:00Z', summary: 'Order 1: a lamp.' }]);
    assert.equal(sent.length, 0, 'denied audience: the set is Ω');
    const v = rt.store.db.prepare("SELECT event FROM poly_ledger WHERE run = 'desk' AND kind = 'verdict'").all().map((x) => JSON.parse(x.event).body).find((x) => x.effectKind === 'support.reply');
    assert.deepEqual([v.outcome, v.reason], ['denied', 'audience']);
    const o1 = `sha256:${createHash('sha256').update(Buffer.from('Order 1: a lamp.', 'utf8')).digest('hex')}`;
    assert.equal(await rt.contentBody(o1), 'Order 1: a lamp.');
    const { erased } = await rt.forget({ subject: 'cust-a' }, sign('forget', forgetSubject(rt.anchorId, { subject: 'cust-a' })));
    assert.ok(erased.includes(o1), 'the real owner\'s forget erases the body read under Ω');
    assert.equal(await rt.contentBody(o1), null);
  } finally { await rt.close(); }
});

test('S327: a body received on a channel is owned by its sender; the conversation answers its sender, and a forget of the sender erases it', { timeout: 300_000 }, async () => {
  const key = makeKey('rulings-s327');
  const dir = project('rulings-s327', ['test/fixtures/m10/sms-help.poly'], key, 'test-runtime');
  // The channel's configuration has vacuous properties, so the program is INCONCLUSIVE and loads through a witness.
  const w = await admitWitness(dir, { root: dir, key: { id: key.id, privateKeyPem: readFileSync(key.file, 'utf8') }, out: join(dir, '.poly', 'witness.certificate.json') });
  const { rt, clock } = await loaded({ build: join(dir, '.poly', 'build'), certificate: w.certificatePath, trust: { [key.id]: key.publicKey } }, { allowWitness: true });
  try {
    const tw = { accountSid: 'ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', authToken: randomBytes(32).toString('hex'), from: '+15557122661' };
    const out = [];
    rt.connectChannel('text', sms(tw), { http: { async request(q) { out.push(q); return { status: 201, headers: {}, body: recorded('twilio/send-response.json') }; } } });
    const docs = { async request(q) {
      if (q.url.endsWith('/_search')) return { status: 200, headers: {}, body: JSON.stringify({ hits: { hits: [{ _id: 'h-1', _source: { asof: new Date(clock.now()).toISOString() } }] } }) };
      return { status: 200, headers: {}, body: JSON.stringify({ found: true, _source: { body: 'Reset it from the settings page.' } }) };
    } };
    rt.connectSource('help', openSearchSource({ base: 'https://search.example', index: 'help', transport: docs, asOf: 'asof', body: 'body' }));
    rt.provide('answer', { provider: (_q, m) => ({ answer: 'Reset it from the settings page.', distribution: [['x', 0.9]], cites: Object.values(m.items).flat().map((i) => i.id) }), model: 'flash' });
    const text = `How do I reset ${randomBytes(4).toString('hex')}?`;
    await rt.receive('text', smsWebhook(tw, text));
    for (let k = 0; k < 10; k++) { await rt.advance(); await rt.worker.tick(); }
    const q = `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;
    const t = rt.memory.taintOf(q);
    assert.deepEqual(t, { c: 2, o: [rt.store.recipientDigest(SMS_FROM)] }, 'owned by its sender, at the channel\'s class');
    const vs = rt.store.db.prepare("SELECT run, kind, event FROM poly_ledger").all().map((x) => [x.run.slice(0, 16), x.kind, JSON.stringify(JSON.parse(x.event).body).slice(0, 160)]);
    assert.equal(out.filter((x) => /Messages\.json$/.test(x.url)).length, 1, `the answer reached its sender ${JSON.stringify(vs)} ${JSON.stringify(out.map((x) => x.url))}`);
    await rt.forget({ subject: SMS_FROM }, sign('forget', forgetSubject(rt.anchorId, { subject: SMS_FROM })));
    assert.equal(await rt.contentBody(q), null, 'the sender\'s message is erased');
  } finally { await rt.close(); }
});

test('S321 with the anchor lock (c201ccf): the anchor a record is bound to is read under the anchor\'s lock, and a lock held by another process refuses the read', { timeout: 120_000 }, async () => {
  const { COMMANDS } = await import('@poly/check');
  const { readAnchor } = await import('@poly/core');
  const { ANCHORS } = await import('./runtime-helpers.mjs');
  const { tmpdir } = await import('node:os');
  const { rt, dir } = await build('rulings-s321-lock', REMEMBERING);
  const tmp = join(tmpdir(), `poly-lock-${randomBytes(4).toString('hex')}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const keyFile = join(tmp, 'person.pem');
    writeFileSync(keyFile, PERSON.privateKeyPem);
    const file = JSON.parse(readFileSync(join(ANCHORS, 'anchors.json'), 'utf8')).anchors['rulings-s321-lock'].slice('file:'.length);
    const forget = COMMANDS.find((c) => c.name === 'forget');
    writeFileSync(`${file}.lock`, '');
    await assert.rejects(forget.run({ project: dir, subject: 'cust-a', by: PERSON.keyId, key: keyFile }), /being changed by another process/);
    assert.throws(() => readAnchor(dir, 'rulings-s321-lock'), /being changed by another process/);
    rmSync(`${file}.lock`, { force: true });
    const r = await forget.run({ project: dir, subject: 'cust-a', by: PERSON.keyId, key: keyFile });
    assert.equal(r.result.record.subject.split(':sha256:')[0], rt.anchorId);
    assert.ok(!readdirSync(dirname(file)).some((f) => f.endsWith('.lock')), 'the read leaves no lock behind');
  } finally { await rt.close(); rmSync(tmp, { recursive: true, force: true }); }
});

test('The anchor lock (polywatch on the merge): a holder removes only its own lock, a stale lock is taken over, and writeAnchorFile writes under the lock', async () => {
  const { withAnchorLock, writeAnchorFile, newAnchor } = await import('@poly/core');
  const { tmpdir } = await import('node:os');
  const { utimesSync, existsSync } = await import('node:fs');
  const dir = join(tmpdir(), `poly-anchor-lock-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  try {
    const file = join(dir, 'p.anchor');
    writeAnchorFile(file, newAnchor('p', `sha256:${'1'.repeat(64)}`, false));
    // A lock taken over while its first holder ran (it ran past a minute) is the new holder's: the first leaves it.
    withAnchorLock(file, () => { writeFileSync(`${file}.lock`, 'another-holder'); });
    assert.equal(readFileSync(`${file}.lock`, 'utf8'), 'another-holder');
    // A fresh lock refuses a write; a lock older than a minute is a dead process's, and is taken over.
    assert.throws(() => writeAnchorFile(file, newAnchor('p', `sha256:${'2'.repeat(64)}`, false)), /being changed by another process/);
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(`${file}.lock`, old, old);
    writeAnchorFile(file, newAnchor('p', `sha256:${'3'.repeat(64)}`, false));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).first, `sha256:${'3'.repeat(64)}`);
    assert.equal(existsSync(`${file}.lock`), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
