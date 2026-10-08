// The M10 canary (S310, plan-m10 section 5), a standing test beside AC18's: the concierge with memory runs over orders
// whose bodies carry a canary generated here, with a question and an answer that carry one too, and a scan of every
// record and output finds none of them. The records are every table of the store but the erasable content store, which
// is where bodies live by design (S205), the certificate, the build and what the process printed. The query's value, the
// customer, is a principal the module keeps in its state, so it is not scanned for; what is checked is that it reaches
// the database only as a parameter, never in the query's text. After the customer is forgotten, the content store holds
// none of the canaries either. Its seeded control, a handler that prints the body it was given, is found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { forgetSubject, signRecord } from '@poly/core';
import { postgresSource } from '@poly/io';
import { admitted, handleWith, loaded, PERSON } from './runtime-helpers.mjs';
import { ORDERS, pgOrders } from './memory-helpers.mjs';

const encodings = (s) => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), encodeURIComponent(s)];
const verifier = (c) => (c ? { principal: c.principal } : null);

/** Every text the run left outside the content store: each column of each row of the other tables, and each file. */
function outputs(rt, dir, printed, { content = false } = {}) {
  const out = [];
  for (const { name } of rt.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if ((name === 'poly_content') !== content) continue;
    for (const row of rt.store.db.prepare(`SELECT * FROM "${name}"`).all()) for (const v of Object.values(row)) if (v !== null) out.push([`table ${name}`, v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : String(v)]);
  }
  if (content) return out;
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else out.push([p, readFileSync(p, 'latin1')]); } };
  walk(dir);
  out.push(['printed', printed.join('')]);
  return out;
}
const found = (texts, tokens) => texts.flatMap(([where, text]) => tokens.flatMap((t) => (encodings(t).some((e) => text.includes(e)) ? [where] : [])));

async function suite(echo) {
  const canary = `canary-${randomBytes(12).toString('hex')}`;
  const a = await admitted(`memory-canary${echo ? '-echo' : ''}`, ['test/fixtures/m10/concierge-memory.poly']);
  const { rt } = await loaded(a, { verifier });
  const printed = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { printed.push(String(chunk)); return write(chunk, ...rest); };
  try {
    const db = pgOrders(ORDERS.map((o) => ({ ...o, summary: `${o.summary} ${canary}-item-${o.order_id}` })));
    rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
    rt.provide('answer', { provider: (_q, m) => ({ answer: `Your orders ${Object.values(m.items).flat().map((i) => i.id).join(', ')} ${canary}-answer`, distribution: [['x', 0.9]], cites: [] }), model: 'flash' });
    handleWith(rt, 'support.reply', async (payload) => {
      if (echo) console.log(`replying ${await rt.contentBody(payload.body)}`);
      return { ok: true };
    });
    await rt.create('concierge_memory.Desk', { id: 'desk' });
    const q = await rt.putContent(`Where is my order? ${canary}-question`);
    await rt.dispatch('desk', 'Ask', { question: q }, { credentials: { principal: 'cust-a' } });
    for (let k = 0; k < 8; k++) await rt.worker.tick();
    return { rt, a, db, canary, printed };
  } finally { process.stdout.write = write; }
}

test('S310: no record or output of the concierge with memory holds an item body, a question or an answer; a query value is a parameter only; forgotten, the content store holds none', { timeout: 300_000 }, async () => {
  const { rt, a, db, canary, printed } = await suite(false);
  try {
    const tokens = [`${canary}-item-o-1`, `${canary}-item-o-2`, `${canary}-question`, `${canary}-answer`];
    // The run did read the bodies, and the content store holds them, so the scan below is not empty for want of a run.
    const content = outputs(rt, a.dir, printed, { content: true });
    assert.deepEqual([...new Set(found(content, [`${canary}-item-o-2`, `${canary}-answer`]))], ['table poly_content']);
    assert.deepEqual(found(outputs(rt, a.dir, printed), tokens), []);
    // The other customer's order was never read.
    assert.deepEqual(found(content, [`${canary}-item-o-3`]), []);
    // The customer reaches the database only as a parameter of a parameterized query.
    assert.ok(db.seen.length >= 3);
    for (const s of db.seen) assert.ok(!s.text.includes('cust-a'), s.text);
    assert.ok(db.seen.some((s) => s.params.includes('cust-a')));
    // Forgotten, the customer's bodies leave the content store; the question, which no source tainted, stays.
    await rt.forget({ subject: 'cust-a' }, signRecord({ kind: 'forget', subject: forgetSubject({ subject: 'cust-a' }), by: PERSON.keyId, at: '2026-10-07T00:00:00.000Z' }, PERSON.privateKeyPem));
    assert.deepEqual(found(outputs(rt, a.dir, printed, { content: true }), tokens), ['table poly_content'], 'the question only');
    assert.deepEqual(found(outputs(rt, a.dir, printed, { content: true }), [`${canary}-question`]), ['table poly_content']);
  } finally { await rt.close(); }
});

test('S310, seeded control: a handler that prints the answer it was given is found by the scan', { timeout: 300_000 }, async () => {
  const { rt, a, canary, printed } = await suite(true);
  try {
    assert.ok(found(outputs(rt, a.dir, printed), [`${canary}-answer`]).includes('printed'));
  } finally { await rt.close(); }
});
