// M10 at run time (PT10j, PS17.2, PS17.4, S302, S308, S310): the concierge with memory admitted with its source and flow
// descriptors, its Postgres source connected over a host query function with two customers' orders seeded, and its
// decision answered by a recorded provider. No test reaches a database or calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postgresSource } from '@poly/io';
import { admitted, loaded } from './runtime-helpers.mjs';
import { pgOrders } from './memory-helpers.mjs';

const a = await admitted('memory-runtime', ['test/fixtures/m10/concierge-memory.poly']);

/** A recorded provider for the answer: it gives a text, and keeps what it was asked and what it read. */
function answering(text = (m) => `Your orders: ${Object.values(m.items).flat().map((i) => i.body).join(' ')}`) {
  const asked = [];
  const provider = (q, materials) => { asked.push({ q, materials }); return { answer: text(materials), distribution: [[text(materials), 0.9]], cites: Object.values(materials.items).flat().map((i) => i.id), reported: 'flash-2026-09', latencyMs: 4 }; };
  return { provider, asked };
}

async function concierge(opts = {}) {
  const { rt, clock } = await loaded(a, { verifier: (c) => (c ? { principal: c.principal } : null) });
  const db = pgOrders();
  rt.connectSource('orders', postgresSource({ query: opts.query ?? db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
  const p = answering(opts.text);
  rt.provide('answer', { provider: p.provider, model: 'flash' });
  return { rt, clock, db, asked: p.asked };
}

async function ask(rt, id, customer, question = 'Where is my order?') {
  await rt.create('concierge_memory.Desk', { id });
  const q = await rt.putContent(question);
  await rt.dispatch(id, 'Ask', { question: q }, { credentials: { principal: customer } });
  for (let k = 0; k < 4; k++) await rt.worker.tick();
}

test('PT10j: the desk retrieves its customer\'s orders by reference, its decision reads their bodies, and its answer is a body with their taint', async () => {
  const { rt, asked } = await concierge();
  try {
    await ask(rt, 'desk-a', 'cust-a');
    const st = (await rt.getState('desk-a')).state;
    assert.equal(st.phase, 'Idle');
    // The provider read cust-a's two orders, and only those.
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].materials.items.context.map((i) => i.id), ['o-2', 'o-1']);
    assert.deepEqual(asked[0].materials.items.context.map((i) => i.body), ['Order 2: two lamps.', 'Order 1: a lamp.']);
    // S310: the question the decision records holds the item set's reference and the Content, never a body.
    assert.ok(!JSON.stringify(asked[0].q).includes('lamp'));
    const journal = rt.store.db.prepare('SELECT data FROM pr_journal WHERE instance_id = ?').all('desk-a').map((r) => r.data).join('\n');
    const ledger = rt.store.db.prepare('SELECT event FROM poly_ledger').all().map((r) => r.event).join('\n');
    const kept = rt.store.db.prepare('SELECT body FROM poly_kept').all().map((r) => r.body).join('\n');
    for (const where of [journal, ledger, kept]) assert.ok(!where.includes('lamp'), 'no item body or answer text in the journal, the ledger or the kept records');
    // PS17.4: the answer is a body with the join of what the decision read: class customer, owner cust-a.
    const reply = rt.store.db.prepare("SELECT payload FROM pr_outbox WHERE instance_id = 'desk-a' AND kind = 'support.reply'").get();
    const body = JSON.parse(reply.payload).body;
    assert.match(body, /^sha256:/);
    assert.equal(await rt.contentBody(body), 'Your orders: Order 2: two lamps. Order 1: a lamp.');
    assert.deepEqual(rt.memory.taintOf(body), { c: 1, o: ['cust-a'] });
    // The question entered by putContent, and carries ⊥.
    const question = rt.store.db.prepare("SELECT data FROM pr_journal WHERE instance_id = 'desk-a' AND action = 'Ask'").get();
    assert.deepEqual(rt.memory.taintOf(JSON.parse(question.data).question), { c: 0, o: [] });
  } finally { await rt.close(); }
});

test('K14: a source that answers another owner\'s item for a retrieval by owner is refused, and the lookup fails', async () => {
  const db = pgOrders();
  const leaky = async (text, params) => (text.startsWith('SELECT "order_id"') ? { rows: [{ id: 'o-3', owner: 'cust-b', as_of: '2026-10-05T08:00:00Z' }] } : db.query(text, params));
  const { rt, asked } = await concierge({ query: leaky });
  try {
    await ask(rt, 'desk-b', 'cust-a');
    assert.equal((await rt.getState('desk-b')).state.phase, 'Idle');
    assert.equal(asked.length, 0, 'no decision read another customer\'s order');
    const dead = rt.store.db.prepare("SELECT last_error FROM pr_outbox WHERE instance_id = 'desk-b' AND kind = 'source.orders.retrieve'").get();
    assert.match(dead.last_error, /another owner/);
  } finally { await rt.close(); }
});

test('PS17.4, S308: only the runtime completes a retrieval, runs it, and binds its source to a certified adapter', async () => {
  const { rt } = await concierge();
  try {
    await rt.create('concierge_memory.Desk', { id: 'desk-c' });
    // Since PT10j as amended 2026-10-10 a forged reference is also outside the type (S140), which may refuse it first;
    // either refusal comes before any step. test/items-type.test.mjs shows K10 alone with a stored reference.
    await assert.rejects(rt.dispatch('desk-c', 'Found', { items: { ref: 'items:forged', count: 1 } }), /only the outbox worker delivers it|no item set the runtime stored/);
    assert.throws(() => rt.handle('source.orders.retrieve', () => ({})), /the runtime runs it/);
    assert.throws(() => rt.connectSource('orders', { kind: 'postgres', retrieve: async () => [], resolve: async () => null, forget: async () => ({ removed: 0 }) }), /PL6408/);
    assert.throws(() => rt.connectSource('nowhere', postgresSource({ query: async () => ({ rows: [] }), table: 't', id: 'i', asOf: 'a', body: 'b' })), /no source nowhere/);
  } finally { await rt.close(); }
});

test('AC23, S304: an answer citing the items it was given completes with them; one citing an item it was not given is refused uncited, and the failed path runs', async () => {
  const cited = (ids) => (m) => ids;
  for (const [ids, phase, outcome] of [[['o-2'], 'Idle', 'ok'], [['o-3'], 'Idle', 'uncited'], [['o-2', 'nope'], 'Idle', 'uncited']]) {
    const { rt } = await loaded(a, { verifier: (c) => (c ? { principal: c.principal } : null) });
    try {
      const db = pgOrders();
      rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
      rt.provide('answer', { provider: (q, m) => ({ answer: 'Order 2 shipped.', distribution: [['Order 2 shipped.', 0.9]], cites: cited(ids)(m) }), model: 'flash' });
      await ask(rt, 'desk-cites', 'cust-a');
      assert.equal((await rt.getState('desk-cites')).state.phase, phase);
      const steps = rt.store.db.prepare("SELECT action, data FROM pr_journal WHERE instance_id = 'desk-cites'").all();
      const events = rt.store.db.prepare("SELECT event FROM poly_ledger WHERE run = 'desk-cites'").all().map((r) => JSON.parse(r.event).body);
      if (outcome === 'ok') {
        const answered = steps.find((s) => s.action === 'Answered');
        assert.ok(answered, JSON.stringify(steps.map((s) => s.action)));
        assert.equal(JSON.parse(answered.data).cites.count, 1);
        assert.ok(!events.some((b) => b?.stage === 'citation'));
      } else {
        assert.ok(!steps.some((s) => s.action === 'Answered'), 'the ok outcome is not delivered');
        assert.ok(steps.some((s) => s.action === 'AnswerFailed'), 'the failed outcome runs');
        assert.ok(events.some((b) => b?.stage === 'citation' && b.outcome === 'uncited'), 'the refusal is recorded on the run');
      }
    } finally { await rt.close(); }
  }
});

test('PT10j: admission certifies the memory descriptors with the source\'s adapter pinned, and load refuses a descriptor changed since', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const cert = a.cert;
  assert.deepEqual(cert.poly.memory.sources.map((s) => [s.name, s.adapter]), [['orders', 'postgres']]);
  assert.ok(cert.poly.memory.sources[0].digest?.startsWith('sha256:'));
  assert.deepEqual(cert.poly.memory.flows.map((f) => f.module), ['concierge_memory']);
  for (const d of [cert.poly.memory.sources[0].descriptor, cert.poly.memory.flows[0].descriptor]) assert.ok(cert.artefacts[d], d);
  const file = join(a.dir, cert.poly.memory.sources[0].descriptor);
  const was = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, was.replace('"owned": true', '"owned": false'));
    await assert.rejects(loaded(a), /refused at load/);
  } finally { writeFileSync(file, was); }
});
