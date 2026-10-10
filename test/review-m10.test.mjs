// M10 step 11: the review's findings, each a reviewer's probe made a test, written before its fix and failing on the
// code it found (decisions-m10.md, "Step 11: the code review of M10").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit, replayRuntime } from '@poly/check';
import { forgetSubject, signRecord } from '@poly/core';
import { postgresSource } from '@poly/io';
import { ROOT } from './helpers.mjs';
import { handleWith, loaded, makeKey, project, PERSON } from './runtime-helpers.mjs';
import { pgOrders } from './memory-helpers.mjs';

const CONCIERGE = readFileSync(join(ROOT, 'test', 'fixtures', 'm10', 'concierge-memory.poly'), 'utf8');
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
const verifier = (c) => (c ? { principal: c.principal } : null);
const REMEMBERING = swap(swap(swap(CONCIERGE, 'enum Phase', 'source memory: memory {\n  audience customer owned\n}\n\nenum Phase'),
  '    emit reply(customer: customer, body: text)\n', '    emit reply(customer: customer, body: text)\n    emit note(subject: customer, fact: text)\n'),
  '  effect reply(', '  effect note(subject: Principal, fact: Content) {\n    remember memory as derived about subject\n  }\n\n  effect reply(');
const sign = (kind, subject) => signRecord({ kind, subject, by: PERSON.keyId, at: '2026-10-07T00:00:00.000Z' }, PERSON.privateKeyPem);

async function build(name, src = REMEMBERING) {
  const key = makeKey(name);
  const dir = project(name, ['test/fixtures/m10/concierge-memory.poly'], key, 'test-runtime');
  writeFileSync(join(dir, 'src', 'concierge-memory.poly'), src);
  const r = await admit(dir);
  return loaded({ build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } }, { verifier });
}

async function ask(rt, customer, query) {
  rt.connectSource('orders', postgresSource({ query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
  rt.provide('answer', { provider: (_q, m) => ({ answer: `About ${Object.values(m.items).flat().map((i) => i.id).join(', ')}`, distribution: [['x', 0.9]], cites: Object.values(m.items).flat().map((i) => i.id) }), model: 'flash' });
  handleWith(rt, 'support.reply', () => ({ ok: true }));
  await rt.create('concierge_memory.Desk', { id: 'desk' });
  const q = await rt.putContent('Where is my order?');
  await rt.dispatch('desk', 'Ask', { question: q }, { credentials: { principal: customer } });
  for (let k = 0; k < 8; k++) await rt.worker.tick();
}

test('review C1: a forget whose adapter fails is not used up; the same record completes it, with one forget event', async () => {
  const { rt } = await build('review-m10-c1');
  try {
    const db = pgOrders();
    let down = true;
    const query = async (text, params) => { if (down && text.startsWith('DELETE')) throw new Error('connection reset'); return db.query(text, params); };
    await ask(rt, 'cust-a', query);
    const rec = sign('forget', forgetSubject(rt.anchorId, { subject: 'cust-a' }));
    await assert.rejects(rt.forget({ subject: 'cust-a' }, rec), /connection reset/);
    down = false;
    const { erased } = await rt.forget({ subject: 'cust-a' }, rec);
    assert.ok(erased.length >= 3);
    const ev = rt.store.db.prepare("SELECT event, hash FROM poly_ledger WHERE run = 'runtime:content' AND kind = 'verdict'").all().map((r) => ({ ...JSON.parse(r.event).body, hash: r.hash })).filter((x) => x.stage === 'forget');
    assert.equal(ev.length, 1);
    assert.equal(rt.store.db.prepare('SELECT count(*) AS n FROM poly_memory').get().n, 0);
    assert.deepEqual(db.rows.map((r) => r.order_id), ['o-3']);
    const desk = (await replayRuntime(rt)).find((r) => r.run === 'desk');
    assert.ok(desk.forgotten?.length && desk.forgotten.every((f) => f.forget === ev[0].hash), JSON.stringify(desk.forgotten));
    // Taken once the forget is done: the same record again is a replay.
    await assert.rejects(rt.forget({ subject: 'cust-a' }, rec), (e) => e.reason === 'replayed');
  } finally { await rt.close(); }
});

test('review C4: a remember into an owned source with no subject is denied audience, and the builtin refuses to write it', async () => {
  const { rt } = await build('review-m10-c4');
  try {
    const body = await rt.putContent('An answer.');
    rt.store.db.exec('BEGIN'); rt.memory.taint(body, { c: 0, o: [] }); rt.store.db.exec('COMMIT');
    const decl = { remember: { source: 'memory', provenance: 'derived', about: 'subject' } };
    const r = rt.memory.check({ machineId: 'concierge_memory.Desk', kind: 'source.memory.remember', payload: { subject: null, fact: body }, decl, step: { action: 'Answered', claims: null }, channelAudience: null, approved: false, now: rt.now(), keyed: (s) => s });
    assert.deepEqual(r, { deny: 'audience' });
    await assert.rejects(rt.memory.remember(decl.remember, { subject: null, fact: body }, 'desk', 'i-1', rt.now()), /owned/);
    assert.equal(rt.store.db.prepare('SELECT count(*) AS n FROM poly_memory').get().n, 0);
  } finally { await rt.close(); }
});

test('review C5, S2, S4: a forget drops the erased bodies\' taint records, lists only what it erased, and refuses a source the build does not have before taking the record', async () => {
  const { rt } = await build('review-m10-c5');
  try {
    const db = pgOrders();
    await ask(rt, 'cust-a', db.query);
    // S2: a body tainted with the subject that is not erasable is not listed as erased.
    const kept = `sha256:${'c'.repeat(64)}`;
    rt.store.db.exec('BEGIN'); rt.memory.taint(kept, { c: 1, o: ['cust-a'] }); rt.store.db.exec('COMMIT');
    // S4: an unknown source is refused, and the record stays usable.
    const bad = sign('forget', forgetSubject(rt.anchorId, { source: 'nope' }));
    await assert.rejects(rt.forget({ source: 'nope' }, bad), /no source nope/);
    assert.equal(rt.store.db.prepare('SELECT count(*) AS n FROM poly_used_record').get().n, 0);
    const { erased } = await rt.forget({ subject: 'cust-a' }, sign('forget', forgetSubject(rt.anchorId, { subject: 'cust-a' })));
    assert.ok(!erased.includes(kept));
    for (const d of erased) assert.equal(rt.store.db.prepare('SELECT 1 FROM poly_erased WHERE digest = ?').get(d) !== undefined, true, d);
    // C5: no taint record of an erased body names the subject any more.
    const left = rt.store.db.prepare('SELECT digest, owners FROM poly_taint').all().filter((r) => erased.includes(r.digest));
    assert.deepEqual(left, []);
  } finally { await rt.close(); }
});

test('review D1: in a program with memory, a send from a module with no flow descriptor is judged by the flow rule too, fail closed', async () => {
  const key = makeKey('review-m10-d1');
  const dir = project('review-m10-d1', ['test/fixtures/m10/concierge-memory.poly', 'test/fixtures/m10/relay.poly'], key, 'test-runtime');
  const r = await admit(dir);
  const { rt } = await loaded({ build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } }, { verifier });
  try {
    const sent = [];
    handleWith(rt, 'relay.send', (p) => { sent.push(p); return { ok: true }; });
    const tainted = await rt.putContent('Order 3: a chair.');
    rt.store.db.exec('BEGIN'); rt.memory.taint(tainted, { c: 1, o: ['cust-b'] }); rt.store.db.exec('COMMIT');
    const bare = await rt.putContent('no record');
    rt.store.db.prepare('DELETE FROM poly_taint WHERE digest = ?').run(bare);
    const open = await rt.putContent('A public note.');
    for (const [id, body] of [['r1', tainted], ['r2', bare], ['r3', open]]) {
      await rt.create('relay.Relay', { id });
      await rt.dispatch(id, 'Forward', { body });
    }
    for (let k = 0; k < 6; k++) await rt.worker.tick();
    const v = rt.store.db.prepare("SELECT run, event FROM poly_ledger WHERE kind = 'verdict' AND run LIKE 'r%'").all().map((x) => [x.run, JSON.parse(x.event).body.outcome, JSON.parse(x.event).body.reason ?? null]);
    assert.deepEqual(v, [['r1', 'denied', 'audience'], ['r2', 'denied', 'audience'], ['r3', 'allowed', null]]);
    assert.deepEqual(sent.map((p) => p.body), [open]);
  } finally { await rt.close(); }
});

test('review D2: edit-check writes only a module of the project: never poly.json, a certificate, a key, or a file outside the project', async () => {
  const { commandNamed } = await import('@poly/check');
  const { mkdirSync, rmSync, copyFileSync } = await import('node:fs');
  const W = join(ROOT, '.poly', 'test-runtime', 'review-m10-d2');
  rmSync(W, { recursive: true, force: true });
  mkdirSync(join(W, 'proj', 'src'), { recursive: true });
  mkdirSync(join(W, 'proj', '.poly'), { recursive: true });
  const ROUTER = readFileSync(join(ROOT, 'conformance', 'm4', 'router.poly'), 'utf8');
  copyFileSync(join(ROOT, 'conformance', 'm4', 'router.poly'), join(W, 'proj', 'src', 'router.poly'));
  copyFileSync(join(ROOT, 'conformance', 'm4', 'router.poly'), join(W, 'outside.poly'));
  writeFileSync(join(W, 'proj', 'poly.json'), JSON.stringify({ poly: '1', name: 'ec', modules: ['src/*.poly'] }));
  writeFileSync(join(W, 'proj', '.poly', 'certificate.json'), '{"subject":{}}\n');
  writeFileSync(join(W, 'admission.pem'), '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n');
  const ec = commandNamed('edit-check');
  for (const f of [join(W, 'proj', 'poly.json'), join(W, 'proj', '.poly', 'certificate.json'), join(W, 'admission.pem')]) {
    const before = readFileSync(f, 'utf8');
    const r = await ec.run({ module: f, text: ROUTER, apply: true });
    assert.equal(r.result.status, 'refused', f);
    assert.equal(readFileSync(f, 'utf8'), before, f);
  }
  const out = await ec.run({ module: join(W, 'outside.poly'), text: ROUTER.replace('module ', '// moved\nmodule '), project: join(W, 'proj'), apply: true });
  assert.equal(out.result.status, 'refused');
  assert.match(out.result.reason, /not a module of the project/);
  const ok = await ec.run({ module: join(W, 'proj', 'src', 'router.poly'), text: ROUTER.replace('module ', '// edited\nmodule '), project: join(W, 'proj'), apply: true });
  assert.equal(ok.result.written, true, JSON.stringify(ok.result));
});

test('review D3: a host check with type checking switched off, by noCheck or @ts-nocheck, is never clean', async () => {
  const { commandNamed } = await import('@poly/check');
  const { mkdirSync, rmSync, copyFileSync } = await import('node:fs');
  const W = join(ROOT, '.poly', 'test-runtime', 'review-m10-d3');
  const run = async (name, opts, pre = '') => {
    const dir = join(W, name);
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    copyFileSync(join(ROOT, 'conformance', 'm4', 'router.poly'), join(dir, 'router.poly'));
    await commandNamed('check').run({ target: join(dir, 'router.poly'), root: dir });
    writeFileSync(join(dir, 'host.ts'), [pre, "import type { PolyRuntime } from '@poly/runtime';", "import type { Action, State } from './.poly/build/support.Ticket/types.js';", 'export async function route(rt: PolyRuntime, id: string): Promise<State | null> {', "  await rt.dispatch<Action>(id, 'Received', { text: 7 });", '  return null;', '}', ''].join('\n'));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', skipLibCheck: true, noEmit: true, ...opts }, files: ['host.ts'] }));
    return (await commandNamed('check').run({ target: join(dir, 'router.poly'), root: dir, host: join(dir, 'tsconfig.json') })).result;
  };
  for (const [name, opts, pre] of [['control', {}, ''], ['noCheck', { noCheck: true }, ''], ['ts-nocheck', {}, '// @ts-nocheck']]) {
    const r = await run(name, opts, pre);
    assert.notEqual(r.verdict, 'CLEAN', name);
    assert.ok(r.host.diagnostics.some((d) => d.code === 'PL6836'), name);
  }
});

test('review D4, D5 and suspicions: the OpenSearch source refuses CR or LF in authorization, a dot id, and a partial delete; a zoneless asOf is UTC', async () => {
  const { openSearchSource } = await import('@poly/io');
  const transport = (answer) => ({ request: async (q) => { transport.last = q; return answer(q); } });
  const cfg = (t, extra = {}) => ({ base: 'https://os.example', index: 'orders', transport: t, owner: 'owner', asOf: 'asof', body: 'body', ...extra });
  assert.throws(() => openSearchSource(cfg(transport(() => ({ status: 200, headers: {}, body: '{}' })), { authorization: 'Basic x\r\nX-Evil: 1' })), /line/);
  const os = openSearchSource(cfg(transport(() => ({ status: 200, headers: {}, body: '{}' }))));
  for (const id of ['.', '..']) await assert.rejects(os.resolve(id), /id/);
  const partial = openSearchSource(cfg(transport(() => ({ status: 200, headers: {}, body: JSON.stringify({ deleted: 1, total: 3, failures: [{ cause: { type: 'x' } }] }) }))));
  await assert.rejects(partial.forget('cust-a'), /failures/);
  const hits = openSearchSource(cfg(transport(() => ({ status: 200, headers: {}, body: JSON.stringify({ hits: { hits: [{ _id: 'o-1', _source: { owner: 'cust-a', asof: '2026-10-01 09:30:00' } }] } }) }))));
  assert.equal((await hits.retrieve({ owner: 'cust-a', limit: 1 }))[0].asOf, Date.parse('2026-10-01T09:30:00Z'));
});

/** A project of the concierge (as changed) and a policy, checked; the policies' diagnostics. */
async function policyCheck(name, src, pol) {
  const { checkProject } = await import('@poly/check');
  const { mkdirSync, rmSync } = await import('node:fs');
  const dir = join(ROOT, '.poly', 'test-runtime', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'concierge-memory.poly'), src);
  writeFileSync(join(dir, 'src', 'policy.poly'), pol);
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name, modules: ['src/*.poly'] }, null, 2));
  const p = await checkProject(dir);
  return p.files.flatMap((f) => f.policies.flatMap((x) => x.diagnostics)).map((d) => d.code);
}
const NEVER = (cond) => `module concierge_memory_policy

policy memory-rules {
  scope "concierge_memory"
  obligation nothing "No rule about items." rule {
    when proposal.kind == "effect" && effect.kind == "support.reply"
    require true else deny
    on unknown deny
  }
  never items-never "Never allowed.": allow when ${cond}
}
`;

test('review A F3: the decision table gives effect.items to an effect that carries an Items, as the runtime proposes it', { timeout: 300_000 }, async () => {
  let src = swap(CONCIERGE, '    decide answer(question: question, context: items)', '    emit note(customer: customer, ctx: items)\n    decide answer(question: question, context: items)');
  src = swap(src, '  effect reply(', '  effect note(customer: Principal, ctx: Items) {\n    kind "support.note"\n    labels { egress:external }\n  }\n\n  effect reply(');
  assert.ok((await policyCheck('review-m10-f3', src, NEVER('effect.kind == "support.note" && effect.items.count > 0'))).includes('PL6503'));
});

test('review A F4: effect.items.count is the sum over the Items of a payload, so the table counts past one limit', { timeout: 300_000 }, async () => {
  let src = swap(CONCIERGE, '  action Found(items: Items)', '  action Found(items: Items, more: Items)');
  src = swap(src, '  on Found(items) {', '  on Found(items, more) {');
  src = swap(src, '    decide answer(question: question, context: items)', '    decide answer(question: question, context: items, extra: more)');
  src = swap(src, '    ok(r) -> Found(items: r.items)', '    ok(r) -> Found(items: r.items, more: r.items)');
  src = swap(src, 'decision answer(question: Content, context: Items) -> Content {', 'decision answer(question: Content, context: Items, extra: Items) -> Content {');
  assert.ok((await policyCheck('review-m10-f4', src, NEVER('effect.kind == "decision.answer" && effect.items.count > 2'))).includes('PL6503'));
});

test('review B1: an approval of a policy\'s escalation does not let stale items through; the re-proposal is denied escalate-once', { timeout: 300_000 }, async () => {
  const { signPolicies } = await import('./runtime-helpers.mjs');
  const key = makeKey('review-m10-b1');
  const dir = project('review-m10-b1', ['test/fixtures/m10/concierge-memory.poly'], key, 'test-runtime');
  writeFileSync(join(dir, 'src', 'review.policy.poly'), 'module concierge_memory_policy\n\npolicy review-answers {\n  scope "concierge_memory"\n  obligation person-reviews "Every answer waits for a person." rule {\n    when proposal.kind == "effect" && effect.kind == "decision.answer"\n    require false else escalate\n    on unknown escalate\n  }\n}\n');
  await signPolicies(dir);
  const r = await admit(dir);
  const { rt, clock } = await loaded({ build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } }, { verifier });
  try {
    const { approveAs } = await import('./runtime-helpers.mjs');
    const db = pgOrders([{ order_id: 'o-1', customer_id: 'cust-a', updated_at: new Date(clock.now()).toISOString(), summary: 'Order 1: a lamp.' }]);
    const asked = [];
    rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
    rt.provide('answer', { provider: (_q, m) => { asked.push(1); return { answer: 'ok', distribution: [['ok', 0.9]], cites: Object.values(m.items).flat().map((i) => i.id) }; }, model: 'flash' });
    handleWith(rt, 'support.reply', () => ({ ok: true }));
    await rt.create('concierge_memory.Desk', { id: 'desk' });
    await rt.dispatch('desk', 'Ask', { question: await rt.putContent('Where is my order?') }, { credentials: { principal: 'cust-a' } });
    for (let k = 0; k < 6; k++) await rt.worker.tick();
    clock.advance(2 * 3600_000);
    const intent = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = 'desk' AND kind = 'decision.answer'").get().intent_id;
    await approveAs(rt, intent);
    for (let k = 0; k < 6; k++) await rt.worker.tick();
    const v = rt.store.db.prepare("SELECT event FROM poly_ledger WHERE run = 'desk' AND kind = 'verdict'").all().map((x) => JSON.parse(x.event).body).filter((x) => x.effectKind === 'decision.answer');
    assert.deepEqual(v.map((x) => x.outcome), ['escalated', 'approved', 'denied']);
    assert.equal(v.at(-1).reason, 'escalate-once');
    assert.equal(asked.length, 0, 'the model was not asked over stale orders');
  } finally { await rt.close(); }
});

test('review B3: a body a decision reads is stored with its taint and its source in one transaction, so a fault leaves no body with a lower taint', async () => {
  const { rt } = await build('review-m10-b3', CONCIERGE);
  try {
    const db = pgOrders();
    const orig = rt.memory.taint.bind(rt.memory);
    let thrown = 0;
    rt.memory.taint = (d, t) => { if (t.o.length && thrown === 0) { thrown++; throw new Error('a fault between the body and its taint'); } return orig(d, t); };
    await ask(rt, 'cust-a', db.query);
    const { createHash } = await import('node:crypto');
    const o2 = `sha256:${createHash('sha256').update(Buffer.from('Order 2: two lamps.', 'utf8')).digest('hex')}`;
    const body = await rt.contentBody(o2);
    const t = rt.memory.taintOf(o2);
    assert.ok(body === null || (t && t.o.includes('cust-a')), `body ${body} with taint ${JSON.stringify(t)}`);
  } finally { await rt.close(); }
});

test('review B, suspicion: a decision over a Content with no taint record fails closed; review polywatch: an empty item set is not verified', async () => {
  const { rt } = await build('review-m10-b4', CONCIERGE);
  try {
    const db = pgOrders();
    rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
    const none = await rt.memory.retrieve('orders', { owner: 'customer', limit: 2 }, { customer: 'cust-z' }, 'i-empty');
    assert.equal(none.items.count, 0);
    const r = rt.memory.check({ machineId: 'concierge_memory.Desk', kind: 'decision.answer', payload: { context: none.items }, decl: { decision: {} }, step: { action: 'Found', claims: null }, channelAudience: null, approved: false, now: rt.now(), keyed: (s) => s });
    assert.equal(r.fields.items.provenance, 'observed');
    const bare = `sha256:${'d'.repeat(64)}`;
    await assert.rejects(rt.memory.materials({ question: bare }, async () => null, async () => bare), /taint/);
  } finally { await rt.close(); }
});
