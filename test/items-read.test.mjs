// S462 (PS17.4b, PT10j): a handler reads its own payload's item sets, and exactly one item.
// Written from the specification text alone. An effect with `one p` declares it acts on exactly
// one item; the checker narrows p's count to {1}, an accepted step emitting with another count
// is PL6847 with witness. At run time the second layer denies items-count if the payload's
// item set is not stored with exactly one. The handler calls items.read(x) to get items'
// ids, owners and keys, refuses any outside the payload before reading (PL6406, audited),
// and records each read with its digest on runtime:content. No test reaches a database or
// calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { digest } from '@poly/core';
import { parse, format } from '@poly/lang';
import { checkFile } from '@poly/check';
import { postgresSource } from '@poly/io';
import { CapabilityRefused } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { admitted, handleWith, loaded } from './runtime-helpers.mjs';
import { FAULT_SOURCES } from './toolchain-faults.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'items-read');
const GUARDED = readFileSync(join(FIX, 'refund.poly'), 'utf8');
const UNGUARDED = readFileSync(join(FIX, 'refund-unguarded.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-items-read');

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
const all = (r) => [...(r.diagnostics ?? []), ...(r.machines ?? []).flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
const codes = (r) => all(r).map((d) => d.code);
let n = 0;
async function check(src) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), src);
  return { r: await checkFile(join(d, 'm.poly'), { root: d }), build: join(d, '.poly', 'build') };
}

// -----------------------------------------------------------------------------------------------------------------
// Check layer: the guarded fixture checks CLEAN, unguarded has PL6847 with witness
// -----------------------------------------------------------------------------------------------------------------

test('S462, PT10j: `one order` in an effect checks CLEAN when the emit is guarded by require order.count == 1', { timeout: 300_000 }, async () => {
  const { r } = await check(GUARDED);
  assert.ok(!codes(r).includes('PL6847'), text(r));
  assert.equal(r.verdict, 'CLEAN', text(r));
});

test('S462, PT10j: without the guard, the step emits with a count that may not be 1, so PL6847 ONE_ITEM_COUNT', { timeout: 300_000 }, async () => {
  const { r } = await check(UNGUARDED);
  assert.ok(['REFUSED', 'FINDINGS'].includes(r.verdict), `verdict: ${text(r)}`);
  assert.ok(codes(r).includes('PL6847'), text(r));
  const f = all(r).find((d) => d.code === 'PL6847');
  assert.ok(f, JSON.stringify(all(r)));
  // The finding has a witness (the path to the step that emits with count != 1).
  assert.ok(f.witness, `PL6847 must have witness: ${f.message}`);
  assert.match(f.message, /refund|order/, f.message);
});

// -----------------------------------------------------------------------------------------------------------------
// Check layer: compile-time errors for `one p` grammar
// -----------------------------------------------------------------------------------------------------------------

test('S462, PT10j: `one p` naming a parameter that does not exist is PL1001', { timeout: 300_000 }, async () => {
  const { r } = await check(readFileSync(join(FIX, 'refund-error-no-param.poly'), 'utf8'));
  assert.equal(r.verdict, 'REFUSED', text(r));
  assert.ok(codes(r).includes('PL1001'), text(r));
  const f = all(r).find((d) => d.code === 'PL1001');
  assert.ok(f?.message.includes('nonexistent') || f?.message.includes('one'), f?.message);
});

test('S462, PT10j: `one p` naming a parameter that is not Items is PL1201', { timeout: 300_000 }, async () => {
  const { r } = await check(readFileSync(join(FIX, 'refund-error-non-items.poly'), 'utf8'));
  assert.equal(r.verdict, 'REFUSED', text(r));
  assert.ok(codes(r).includes('PL1201'), text(r));
  const f = all(r).find((d) => d.code === 'PL1201');
  assert.ok(f?.message.includes('one') || f?.message.includes('Items'), f?.message);
});

test('S462, PT10j: `one p` written twice is PL1002 at the second occurrence', { timeout: 300_000 }, async () => {
  const { r } = await check(readFileSync(join(FIX, 'refund-error-duplicate-one.poly'), 'utf8'));
  assert.equal(r.verdict, 'REFUSED', text(r));
  assert.ok(codes(r).includes('PL1002'), text(r));
  const f = all(r).find((d) => d.code === 'PL1002');
  assert.ok(f?.message.includes('one') || f?.message.includes('twice'), f?.message);
});

// -----------------------------------------------------------------------------------------------------------------
// Runtime: valid read, refusals, and two items scenario
// -----------------------------------------------------------------------------------------------------------------

// Two customers' orders: order o-1 and o-2 for customer c-a, o-3 for c-b.
const ORDERS = [
  { order_id: 'o-1', customer_id: 'c-a', amount: 100, updated_at: '2026-10-01T09:00:00Z', body: 'First order from customer A' },
  { order_id: 'o-2', customer_id: 'c-a', amount: 200, updated_at: '2026-10-03T09:00:00Z', body: 'Second order from customer A' },
  { order_id: 'o-3', customer_id: 'c-b', amount: 300, updated_at: '2026-10-05T09:00:00Z', body: 'Order from customer B' },
];
const KEYS = { order: 'order_id' };

/**
 * A query function that answers any SELECT the adapter writes over "orders" by reading it:
 * its column list, its `"col" = $n` equalities, ORDER BY and LIMIT.
 */
function pgOrders({ ignore = [] } = {}) {
  const rows = ORDERS.map((r) => ({ ...r }));
  const seen = [];
  const query = async (q, params) => {
    seen.push({ text: q, params });
    if (!q.startsWith('SELECT ')) throw new Error(`unexpected query ${q}`);
    const [head, rest = ''] = q.split(' FROM ');
    const cols = [...head.matchAll(/"(\w+)" AS (\w+)/g)].map((m) => [m[1], m[2]]);
    const eqs = [...rest.matchAll(/"(\w+)" = \$(\d+)/g)].map((m) => [m[1], params[Number(m[2]) - 1]]).filter(([c]) => !ignore.includes(c));
    const order = /ORDER BY "(\w+)" DESC/.exec(rest)?.[1];
    const lim = /LIMIT \$(\d+)/.exec(rest);
    let out = rows.filter((r) => eqs.every(([c, v]) => r[c] === v));
    if (order) out = out.sort((x, y) => (x[order] < y[order] ? 1 : -1));
    if (lim) out = out.slice(0, params[Number(lim[1]) - 1]);
    return { rows: out.map((r) => Object.fromEntries(cols.map(([c, a]) => [a, r[c]]))) };
  };
  return { query, seen };
}

const source = (query) => postgresSource({ query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'body', keys: KEYS });

/**
 * RFC 8785 canonical JSON: objects with sorted keys, strings and lists. Items are sorted by id
 * in the canonical form before digesting.
 */
const canon = (v) => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};
const itemsDigest = (items) => {
  const sorted = items.slice().sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(canon(sorted)).digest('hex');
};

const outcome = (p) => p.then((v) => ({ read: v }), (e) => e);
const verifier = (c) => (c ? { principal: c.principal } : null);

/**
 * Loads an admitted refund desk, connects its source, and scripts the refund effect's handler.
 */
async function deskWithRefund(a, { rows = ORDERS, ignore = [], script } = {}) {
  const { rt } = await loaded(a, { verifier });
  const db = pgOrders({ ignore });
  rt.connectSource('orders', source(db.query));
  const provided = [];
  rt.provide('answer', {
    provider: (q, m) => {
      provided.push(m);
      // Return only the first cited item (to match the `one order` guard).
      const cited = Object.values(m.items).flat();
      const first = cited.length > 0 ? [cited[0]] : [];
      return {
        answer: `Processed ${first.length} item(s)`,
        distribution: [[`Processed ${first.length} item(s)`, 0.9]],
        cites: first.map((i) => i.id),
        reported: 'flash-2026-09',
        latencyMs: 4,
      };
    },
    model: 'flash',
  });
  const refunds = [];
  handleWith(rt, 'support.refund', async (payload, caps, ctx) => {
    const seen = { payload, caps, out: script ? await script(payload, caps, ctx) : null };
    refunds.push(seen);
    return { ok: true };
  });
  return { rt, db, provided, refunds };
}

async function askForRefund(rt, id, customer = 'c-a', ticks = 20) {
  await rt.create('refund_desk.Desk', { id });
  const q = await rt.putContent('I want a refund for order o-1');
  await rt.dispatch(id, 'Ask', { question: q }, { credentials: { principal: customer } });
  for (let k = 0; k < ticks; k++) await rt.worker.tick();
  return q;
}

const journal = (rt, id) => rt.store.db.prepare('SELECT action, data FROM pr_journal WHERE instance_id = ?').all(id);
const verdicts = (rt, id) => rt.store.db.prepare("SELECT event FROM poly_ledger WHERE run = ? AND kind = 'verdict'").all(id).map((r) => JSON.parse(r.event).body);

test('S462, PS17.4b: items.read in the refund handler gives ids, owners and keys of its own payload', async () => {
  const a = await admitted('items-read-valid', ['test/fixtures/items-read/refund.poly']);
  const { rt, refunds } = await deskWithRefund(a, {
    script: async (payload, caps) => {
      try {
        if (!caps.items) {
          return { error: 'items capability missing', keys: Object.keys(caps) };
        }
        return {
          keys: Object.keys(caps),
          items: await caps.items.read(payload.order),
        };
      } catch (e) {
        return { error: String(e), keys: Object.keys(caps) };
      }
    },
  });
  try {
    await askForRefund(rt, 'desk-1');
    assert.equal(refunds.length, 1, JSON.stringify(verdicts(rt, 'desk-1').map((v) => [v.effectKind, v.outcome])));
    const { payload, out } = refunds[0];
    assert.ok(!out.error, `handler error: ${out.error}`);
    assert.ok(out.keys.includes('items'), JSON.stringify(out.keys));
    // The refund reads one order (the one cited by the decision).
    assert.equal(out.items.length, 1, JSON.stringify(out.items));
    const item = out.items[0];
    assert.equal(item.id, 'o-2', JSON.stringify(item)); // o-2 is the newest of c-a's orders (limit 2)
    assert.equal(item.owner, 'c-a');
    assert.equal(item.keys.order, 'o-2');
    // Each read is recorded by digest on runtime:content.
    const chain = await rt.chain('runtime:content');
    const reads = chain.filter((ev) => ev.body?.stage === 'read');
    assert.ok(reads.length > 0, 'No reads in runtime:content chain');
    const computedDigest = `sha256:${itemsDigest(out.items)}`;
    assert.ok(out.items && out.items.length > 0, `out.items: ${JSON.stringify(out.items)}`);
    const readDigests = reads.map((r) => r.body.digest).join(', ');
    assert.ok(reads.some((r) => r.body.digest === computedDigest), `Computed: ${computedDigest}, found: ${readDigests}`);
    // Each read records the intent id and items ref, but not the bodies.
    assert.ok(reads.every((r) => r.body.items && r.body.intent), 'reads must have items ref and intent');
    assert.ok(!JSON.stringify(reads).includes(item.id), 'item id should not be journaled');
    assert.ok(!JSON.stringify(reads).includes(item.owner), 'item owner should not be journaled');
  } finally { await rt.close(); }
});

test('S462, PS17.4b: items.read refuses a forged ref (PL6406, audited)', async () => {
  const a = await admitted('items-read-forged', ['test/fixtures/items-read/refund.poly']);
  const { rt, refunds } = await deskWithRefund(a, {
    script: async (payload, caps) => ({
      forged: await outcome(caps.items.read({ ref: 'items:forged', count: 1 })),
    }),
  });
  try {
    await askForRefund(rt, 'desk-forged');
    assert.equal(refunds.length, 1);
    assert.ok(refunds[0].out.forged instanceof CapabilityRefused, `no refusal: ${JSON.stringify(refunds[0].out.forged)}`);
    const audit = await rt.audit('desk-forged');
    const rows = audit.filter((r) => r.rule === 'PL6406');
    assert.ok(rows.length > 0, JSON.stringify(audit));
  } finally { await rt.close(); }
});

test('S462, PS17.4b: items.read refuses an unstored ref (PL6406, audited)', async () => {
  const a = await admitted('items-read-unstored', ['test/fixtures/items-read/refund.poly']);
  const { rt, refunds } = await deskWithRefund(a, {
    script: async (payload, caps) => ({
      unstored: await outcome(caps.items.read({ ref: 'items:0000000000000000000000000000000000000000000000000000000000000000', count: 1 })),
    }),
  });
  try {
    await askForRefund(rt, 'desk-unstored');
    assert.equal(refunds.length, 1);
    assert.ok(refunds[0].out.unstored instanceof CapabilityRefused, `no refusal: ${JSON.stringify(refunds[0].out.unstored)}`);
    const audit = await rt.audit('desk-unstored');
    const rows = audit.filter((r) => r.rule === 'PL6406');
    assert.ok(rows.length > 0, JSON.stringify(audit));
  } finally { await rt.close(); }
});

test("S462, PS17.4b: items.read refuses a stored set that is not in the intent's own payload (PL6406, audited)", async () => {
  const a = await admitted('items-read-other-instance', ['test/fixtures/items-read/refund.poly']);
  // The set the retrieval kept, of both of c-a's orders, is stored by the runtime but is not the refund's order, which
  // is the one cited. The handler reads it from the journal of the step that carried it.
  const box = {};
  const { rt, refunds } = await deskWithRefund(a, {
    script: async (payload, caps) => {
      const found = journal(box.rt, 'desk-other').find((s) => s.action === 'Found');
      const stored = JSON.parse(found.data).items;
      return { stored, other: await outcome(caps.items.read(stored)), own: await caps.items.read(payload.order) };
    },
  });
  box.rt = rt;
  try {
    await askForRefund(rt, 'desk-other');
    assert.equal(refunds.length, 1);
    const { stored, other, own } = refunds[0].out;
    assert.equal(stored.count, 2, 'the retrieval kept both orders');
    assert.notEqual(stored.ref, refunds[0].payload.order.ref, "a set other than the payload's");
    assert.ok(other instanceof CapabilityRefused, `read of a stored set outside the payload gave no refusal: ${JSON.stringify(other)}`);
    assert.equal(own.length, 1, "the payload's own set still reads");
    const audit = await rt.audit('desk-other');
    const rows = audit.filter((r) => r.rule === 'PL6406');
    assert.ok(rows.length > 0, JSON.stringify(audit));
  } finally { await rt.close(); }
});

test('S462, PT10j: the toolchain fault one-dropped is in the explicit list of toolchain faults', () => {
  // The manifest's one dropped would let the runtime skip the count check; translation validation must catch it.
  assert.ok(Object.hasOwn(FAULT_SOURCES, 'one-dropped'), Object.keys(FAULT_SOURCES).join(', '));
});

// The runtime's second layer (PS17.4b): the checker's PL6847 makes another count unwritable in an admitted program, so
// each case replaces the pending refund's order in the outbox before the worker reads it, as the S459 test does for an
// envelope: the count check must hold by itself, and the handler never runs.
test('S462, PS17.4b: a refund whose order holds two items, or claims one over a set of two, or is forged, is denied items-count before its handler', async () => {
  const a = await admitted('items-read-two', ['test/fixtures/items-read/refund.poly']);
  for (const what of ['two', 'claims-one', 'forged']) {
    const { rt, refunds } = await deskWithRefund(a);
    try {
      await rt.create('refund_desk.Desk', { id: 'desk-two' });
      const q = await rt.putContent('I want a refund for order o-1');
      await rt.dispatch('desk-two', 'Ask', { question: q }, { credentials: { principal: 'c-a' } });
      let row;
      for (let k = 0; k < 20 && !row; k++) {
        await rt.worker.tick();
        row = rt.store.db.prepare("SELECT intent_id, payload FROM pr_outbox WHERE instance_id = 'desk-two' AND kind = 'support.refund'").get();
      }
      assert.ok(row, `${what}: the refund is pending`);
      assert.equal(refunds.length, 0, `${what}: the refund has not run yet`);
      // The retrieval's set holds both of c-a's orders.
      const found = journal(rt, 'desk-two').find((s) => s.action === 'Found');
      const both = JSON.parse(found.data).items;
      assert.equal(both.count, 2);
      const payload = JSON.parse(row.payload);
      if (what === 'two') payload.order = both;
      if (what === 'claims-one') payload.order = { ref: both.ref, count: 1 };
      if (what === 'forged') payload.order = { ref: 'items:forged', count: 1 };
      rt.store.db.prepare('UPDATE pr_outbox SET payload = ? WHERE intent_id = ?').run(JSON.stringify(payload), row.intent_id);
      for (let k = 0; k < 4; k++) await rt.worker.tick();
      assert.equal(refunds.length, 0, `${what}: the handler never ran`);
      const v = verdicts(rt, 'desk-two').find((x) => x.effectKind === 'support.refund');
      assert.ok(v, `${what}: ${JSON.stringify(verdicts(rt, 'desk-two'))}`);
      assert.deepEqual([v.outcome, v.reason], ['denied', 'items-count'], what);
    } finally { await rt.close(); }
  }
});
