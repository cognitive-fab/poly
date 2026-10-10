// M10 steps 9 and 10 (PT10l, PS17.5, PS17.7, PS11.3a, S306, S309): remembering, verifying a memory item, and forgetting a
// subject. AC24: after a forget, no body about the customer is readable, the items that named the customer are gone, the
// source adapter was asked to forget, and replay still folds every run, listing the forgotten steps and no divergence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS, admit, replayRuntime } from '@poly/check';
import { forgetSubject, memoryVerifySubject, signRecord } from '@poly/core';
import { postgresSource } from '@poly/io';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { handleWith, loaded, makeKey, project, PERSON, AGENT } from './runtime-helpers.mjs';
import { pgOrders } from './memory-helpers.mjs';

const CONCIERGE = readFileSync(join(ROOT, 'test', 'fixtures', 'm10', 'concierge-memory.poly'), 'utf8');
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
const verifier = (c) => (c ? { principal: c.principal } : null);
// The concierge that remembers each answer about the customer it answered (PS17.5).
const REMEMBERING = swap(swap(swap(CONCIERGE, 'enum Phase', 'source memory: memory {\n  audience customer owned\n}\n\nenum Phase'),
  '    emit reply(customer: customer, body: text)\n', '    emit reply(customer: customer, body: text)\n    emit note(subject: customer, fact: text)\n'),
  '  effect reply(', '  effect note(subject: Principal, fact: Content) {\n    remember memory as derived about subject\n  }\n\n  effect reply(');

async function build(name, src = REMEMBERING, extra = {}) {
  const key = makeKey(name);
  const dir = project(name, ['test/fixtures/m10/concierge-memory.poly'], key, 'test-runtime');
  writeFileSync(join(dir, 'src', 'concierge-memory.poly'), src);
  const r = await admit(dir);
  const a = { build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } };
  return { ...(await loaded(a, { verifier, ...extra })), a, dir, key };
}

async function ask(rt, customer) {
  rt.provide('answer', { provider: (_q, m) => ({ answer: `About ${Object.values(m.items).flat().map((i) => i.id).join(', ')}`, distribution: [['x', 0.9]], cites: Object.values(m.items).flat().map((i) => i.id) }), model: 'flash' });
  handleWith(rt, 'support.reply', () => ({ ok: true }));
  const q = await rt.putContent('Where is my order?');
  await rt.dispatch('desk', 'Ask', { question: q }, { credentials: { principal: customer } });
  for (let k = 0; k < 8; k++) await rt.worker.tick();
}

const sign = (kind, subject, who = PERSON) => signRecord({ kind, subject, by: who.keyId, at: '2026-10-07T00:00:00.000Z' }, who.privateKeyPem);

test('PS17.5: an answer is remembered about its customer, derived, read back from memory, and verified once by a person', async () => {
  const { rt } = await build('memory-remember');
  try {
    const db = pgOrders();
    rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
    await rt.create('concierge_memory.Desk', { id: 'desk' });
    await ask(rt, 'cust-a');
    const rows = rt.store.db.prepare('SELECT item, subject, provenance, digest FROM poly_memory').all();
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.deepEqual([rows[0].subject, rows[0].provenance], ['cust-a', 'derived']);
    assert.match(await rt.contentBody(rows[0].digest), /^About o-2, o-1$/);
    // A retrieval from memory reads the item, by owner, and only that owner's.
    const mine = await rt.memory.retrieve('memory', { owner: 'customer', limit: 5 }, { customer: 'cust-a' }, 'k-a');
    const theirs = await rt.memory.retrieve('memory', { owner: 'customer', limit: 5 }, { customer: 'cust-b' }, 'k-b');
    assert.deepEqual([mine.items.count, theirs.items.count], [1, 0]);
    // Verified once, by a person; an agent's key and a replay are refused.
    const item = rows[0].item;
    await assert.rejects(rt.verifyMemory(item, sign('verify', memoryVerifySubject(rt.anchorId, item), AGENT)), (e) => e.reason === 'wrong-key');
    await assert.rejects(rt.verifyMemory(item, sign('verify', memoryVerifySubject(rt.anchorId, 'mem:other'))), (e) => e.reason === 'wrong-key');
    const rec = sign('verify', memoryVerifySubject(rt.anchorId, item));
    await rt.verifyMemory(item, rec);
    assert.equal(rt.memory.memoryItem(item).provenance, 'verified');
    await assert.rejects(rt.verifyMemory(item, rec), (e) => e.reason === 'replayed');
    const ev = rt.store.db.prepare("SELECT event FROM poly_ledger WHERE run = 'runtime:memory' AND kind = 'verdict'").all().map((r) => JSON.parse(r.event).body);
    assert.deepEqual(ev.map((x) => [x.stage, x.outcome, x.item]), [['memory', 'verified', item]]);
  } finally { await rt.close(); }
});

test('AC24: forgetting a customer erases every body about them, removes their items, asks the source, and replay lists the steps as forgotten', async () => {
  const { rt } = await build('memory-forget');
  try {
    const db = pgOrders();
    rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
    await rt.create('concierge_memory.Desk', { id: 'desk' });
    await ask(rt, 'cust-a');
    const answer = rt.store.db.prepare('SELECT digest FROM poly_memory').get().digest;
    const before = await replayRuntime(rt);
    assert.ok(before.every((r) => !r.diagnostics.length && !r.forgotten), JSON.stringify(before));
    // An unsigned forget, and one over another subject, are refused.
    await assert.rejects(rt.forget({ subject: 'cust-a' }, { kind: 'forget' }), (e) => e.reason === 'not-a-record');
    await assert.rejects(rt.forget({ subject: 'cust-a' }, sign('forget', forgetSubject(rt.anchorId, { subject: 'cust-b' }))), (e) => e.reason === 'wrong-key');
    const { erased } = await rt.forget({ subject: 'cust-a' }, sign('forget', forgetSubject(rt.anchorId, { subject: 'cust-a' })));
    assert.ok(erased.includes(answer));
    assert.ok(erased.length >= 3, 'the answer and the two orders the decision read');
    for (const d of erased) assert.equal(await rt.contentBody(d), null, d);
    assert.equal(rt.store.db.prepare('SELECT count(*) AS n FROM poly_memory').get().n, 0);
    // PS17.6 as ruled 2026-10-10: an answer cites, so its citations name the customer and go with the orders' set.
    assert.deepEqual(rt.store.db.prepare('SELECT owners, items FROM poly_items').all().map((r) => [r.owners, r.items]), []);
    assert.deepEqual(db.rows.map((r) => r.order_id), ['o-3'], 'the source forgot the customer\'s orders');
    // The forget event names the subject by its keyed digest, never as itself.
    const ev = rt.store.db.prepare("SELECT event, hash FROM poly_ledger WHERE run = 'runtime:content' AND kind = 'verdict'").all().map((r) => ({ ...JSON.parse(r.event).body, hash: r.hash })).filter((x) => x.stage === 'forget');
    assert.equal(ev.length, 1);
    assert.match(ev[0].subject, /^hmac-sha256:/);
    assert.ok(!JSON.stringify(ev).includes('cust-a'));
    // The journal and the ledger hold only digests, so every chain still verifies (PS17.7).
    for (const run of ['desk', 'runtime:content']) assert.equal((await rt.verifyChain(run)).ok, true, run);
    assert.deepEqual(await rt.verifyProvenance('desk'), []);
    // PS11.3a: replay folds as before; the step that carried the answer is forgotten, by that event, and is no divergence.
    const after = await replayRuntime(rt);
    const desk = after.find((r) => r.run === 'desk');
    assert.deepEqual(desk.diagnostics, []);
    assert.ok(desk.forgotten?.some((f) => f.digest === answer && f.forget === ev[0].hash), JSON.stringify(desk.forgotten));
  } finally { await rt.close(); }
});

test('PS17.5: a remember of a body wider than its item is denied audience at run time, before it writes', async () => {
  const { rt } = await build('memory-downgrade');
  try {
    const decl = { remember: { source: 'memory', provenance: 'derived', about: 'subject' } };
    const check = (payload) => rt.memory.check({ machineId: 'concierge_memory.Desk', kind: 'source.memory.remember', payload, decl, step: { action: 'Answered', claims: null }, channelAudience: null, approved: false, now: rt.now(), keyed: (s) => s });
    const staff = await rt.putContent('Staff notes.');
    const own = await rt.putContent('Order 2: two lamps.');
    rt.store.db.exec('BEGIN'); rt.memory.taint(staff, { c: 2, o: [] }); rt.memory.taint(own, { c: 1, o: ['cust-a'] }); rt.store.db.exec('COMMIT');
    assert.deepEqual(check({ subject: 'cust-a', fact: staff }), { deny: 'audience' }, 'a staff body would reach the customer');
    assert.deepEqual(check({ subject: 'cust-b', fact: own }), { deny: 'audience' }, 'an order of cust-a would reach cust-b');
    assert.equal(check({ subject: 'cust-a', fact: own }), null);
    assert.deepEqual(check({ subject: 'cust-a', fact: `sha256:${'b'.repeat(64)}` }), { deny: 'audience' }, 'no taint record, fail closed');
  } finally { await rt.close(); }
});

test('PT10l: poly memory-verify and poly forget sign records, never over MCP; forgetting a source erases what was read from it, and journal replay prints the forgotten steps', { timeout: 300_000 }, async () => {
  const verify = COMMANDS.find((c) => c.name === 'memory-verify');
  const forget = COMMANDS.find((c) => c.name === 'forget');
  assert.deepEqual([verify?.mcp, forget?.mcp], [null, null]);
  const tmp = mkdtempSync(join(tmpdir(), 'poly-forget-'));
  const db = join(tmp, 'run.db');
  const { rt, a, dir, key } = await build('memory-forget-cli', REMEMBERING, { store: { sqlite: db } });
  try {
    // The person's key is written outside the repository for the commands, which read a file, and deleted (as ruled).
    const keyFile = join(tmp, 'person.pem');
    writeFileSync(keyFile, PERSON.privateKeyPem);
    const orders = pgOrders();
    rt.connectSource('orders', postgresSource({ query: orders.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
    await rt.create('concierge_memory.Desk', { id: 'desk' });
    await ask(rt, 'cust-a');
    const item = rt.store.db.prepare('SELECT item FROM poly_memory').get().item;
    const v = await verify.run({ project: dir, item, by: PERSON.keyId, key: keyFile });
    await rt.verifyMemory(item, v.result.record);
    assert.equal(rt.memory.memoryItem(item).provenance, 'verified');
    await assert.rejects(forget.run({ project: dir, by: PERSON.keyId, key: keyFile }), /a subject or a source/);
    const f = await forget.run({ project: dir, source: 'orders', by: PERSON.keyId, key: keyFile });
    const { erased } = await rt.forget({ source: 'orders' }, f.result.record);
    assert.equal(erased.length, 2, 'the two orders the decision read, and not the answer, which memory holds');
    assert.ok(rt.memory.memoryItem(item), 'the memory item stays');
    assert.equal(orders.rows.length, 3, 'a source forgotten whole is not asked to forget a subject');
    const ev = rt.store.db.prepare("SELECT event FROM poly_ledger WHERE run = 'runtime:content' AND kind = 'verdict'").all().map((r) => JSON.parse(r.event).body).filter((x) => x.stage === 'forget');
    assert.deepEqual(ev.map((x) => x.source), ['orders']);
    // The orders' bodies are in no step's data; the answer is, and forgetting the customer erases it.
    const s = await forget.run({ project: dir, subject: 'cust-a', by: PERSON.keyId, key: keyFile });
    assert.ok((await rt.forget({ subject: 'cust-a' }, s.result.record)).erased.length >= 1);
  } finally { await rt.close(); }
  try {
    const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
    const adm = join(tmp, 'admission.pub');
    writeFileSync(adm, key.publicKey);
    let out;
    try { out = execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, 'journal', 'replay', '--db', db, '--build', a.build, '--certificate', a.certificate, '--trust', `${key.id}=${adm}`, '--run', 'desk'], { encoding: 'utf8', cwd: dir }); } catch (e) { out = `${e.stdout}${e.stderr}`; }
    assert.doesNotMatch(out, /PL9001/, out);
    assert.match(out, /seq \d+: forgotten, sha256:[0-9a-f]{64} erased by the forget event /, out);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('PT10l: a policy reads effect.items.provenance; its never is proved over the decision table, admitted, and denies an answer over observed orders', { timeout: 300_000 }, async () => {
  const policy = [
    'module concierge_provenance_policy',
    '',
    'policy provenance-rules {',
    '  scope "concierge_memory"',
    '  obligation verified-only "An answer is asked over verified items only." rule {',
    '    when proposal.kind == "effect" && effect.kind == "decision.answer" && effect.items.provenance != "verified"',
    '    require false else deny',
    '    on unknown deny',
    '  }',
    '  never unverified "An answer over unverified items is never allowed.": allow when effect.kind == "decision.answer" && effect.items.provenance == "observed"',
    '}',
    '',
  ].join('\n');
  const key = makeKey('memory-provenance');
  const dir = project('memory-provenance', ['test/fixtures/m10/concierge-memory.poly', 'test/fixtures/m10/concierge-memory.policy.poly'], key, 'test-runtime');
  writeFileSync(join(dir, 'src', 'concierge-memory.policy.poly'), policy);
  const { signPolicies } = await import('./runtime-helpers.mjs');
  await signPolicies(dir);
  const r = await admit(dir);
  const { rt } = await loaded({ build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } }, { verifier });
  try {
    const orders = pgOrders();
    rt.connectSource('orders', postgresSource({ query: orders.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
    await rt.create('concierge_memory.Desk', { id: 'desk' });
    await ask(rt, 'cust-a');
    const v = rt.store.db.prepare("SELECT event FROM poly_ledger WHERE run = 'desk' AND kind = 'verdict'").all().map((x) => JSON.parse(x.event).body).filter((x) => x.effectKind === 'decision.answer');
    assert.equal(v.at(-1).outcome, 'denied', JSON.stringify(v));
    const proposal = JSON.parse(rt.store.db.prepare('SELECT body FROM poly_kept WHERE digest = ?').get(v.at(-1).proposal).body);
    assert.equal(proposal.items.provenance, 'observed');
  } finally { await rt.close(); }
  // The seeded control: without the rule, the never is refuted over the decision table.
  writeFileSync(join(dir, 'src', 'concierge-memory.policy.poly'), policy.replace(/  obligation verified-only[\s\S]*?on unknown deny\n  \}\n/, ''));
  const { checkProject } = await import('@poly/check');
  const p = await checkProject(dir);
  assert.ok(p.files.flatMap((x) => x.policies.flatMap((y) => y.diagnostics)).some((d) => d.code === 'PL6503'));
});
