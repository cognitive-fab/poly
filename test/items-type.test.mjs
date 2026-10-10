// PT10j, S140 (ruled 2026-10-10), PS1.4b: an `Items` at the type check. An Items is checked as a Content is. The
// checker's domain of an Items parameter is its counts, `{ count }` for each count of 0..L, and never holds a ref. At
// run time the type check refuses an Items value whose ref is not `items:` and the key of an item set the runtime
// stored (poly_items), and one whose count lies outside 0..L. A domain count carried by a stored ref is in the type.
//
// How a value is presented to the run-time type check. Only the runtime delivers a retrieval's completion (K10), so
// an outside dispatch never reaches the type check, and @poly/runtime's exported `outside` and `dataOutside` take no
// stored lookup (types.d.ts). These tests use the check the outbox worker calls before it delivers a completion,
// `rt.worker.opts.outsideType(instance, action, data)` (the seam test/runtime-type.test.mjs already uses), which is
// bound to the runtime's own store. They call it directly, and they also wrap it so that the real check judges a
// rewritten copy of the Found completion's data, which makes the runtime refuse the real delivery when the rewritten
// value is outside the type: the refusal is then observed as S140 says (an audit row, no journal row).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { postgresSource } from '@poly/io';
import { RefusedDispatch } from '@poly/runtime';
import { admitted, loaded } from './runtime-helpers.mjs';
import { pgOrders } from './memory-helpers.mjs';
import { polyFiles, build, ROOT } from './helpers.mjs';

const CONCIERGE = 'test/fixtures/m10/concierge-memory.poly';
const a = await admitted('items-type', [CONCIERGE]);

// The concierge's own contract, as the checker lowers it: Desk.Found(items: Items), its retrieval's limit 2, so L = 2.
const deskContract = () => {
  const [desk] = build(join(ROOT, CONCIERGE), 'items-type').filter((b) => /Desk$/.test(b.dir));
  return JSON.parse(readFileSync(join(desk.dir, 'contract.json'), 'utf8'));
};

/** The concierge with its source connected and its decision answered, and the worker's type check wrapped. */
async function desk() {
  const { rt } = await loaded(a, { verifier: (c) => (c ? { principal: c.principal } : null) });
  const db = pgOrders();
  rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
  const asked = [];
  rt.provide('answer', { provider: (q, m) => { asked.push(q); return { answer: 'ok', distribution: [['ok', 0.9]] }; }, model: 'flash' });
  const real = rt.worker['opts'].outsideType;
  assert.equal(typeof real, 'function', 'the worker checks a completion\'s type before it delivers it (S140)');
  const seen = [];
  const hook = { rewrite: null };
  rt.worker['opts'].outsideType = (id, action, data) => {
    const used = action === 'Found' && hook.rewrite ? { ...data, items: hook.rewrite(data.items) } : data;
    const verdict = real(id, action, used);
    seen.push({ id, action, data, used, verdict });
    return verdict;
  };
  return { rt, real, seen, hook, asked };
}

async function ask(rt, id, customer = 'cust-a') {
  await rt.create('concierge_memory.Desk', { id });
  const q = await rt.putContent('Where is my order?');
  await rt.dispatch(id, 'Ask', { question: q }, { credentials: { principal: customer } });
  for (let k = 0; k < 4; k++) await rt.worker.tick();
}

const journal = (rt, id) => rt.store.db.prepare('SELECT action, data FROM pr_journal WHERE instance_id = ?').all(id);

/** The same key with its last character changed: a ref of the runtime's form that names no stored item set. */
const unstored = (ref) => {
  const last = ref.at(-1);
  return ref.slice(0, -1) + (last === '0' ? '1' : '0');
};

test('PT10j, S140: an Items whose ref the runtime stored and whose count is in 0..L is in the type, and the completion is delivered', async () => {
  const { rt, real, seen } = await desk();
  try {
    await ask(rt, 'it-ok');
    const found = journal(rt, 'it-ok').find((r) => r.action === 'Found');
    assert.ok(found, 'the retrieval\'s completion is a step');
    const { items } = JSON.parse(found.data);
    assert.match(items.ref, /^items:./, 'the runtime\'s form: items: and a key');
    assert.deepEqual(Object.keys(items).sort(), ['count', 'ref']);
    const check = seen.find((s) => s.action === 'Found');
    assert.equal(check?.verdict, null, 'the real Found value is in its type');
    // Every count of the checker's domain, carried by this stored ref, is in the type (PT10j: "a domain count carried
    // by a stored reference is inside it").
    const domain = deskContract().dataDomain.Found.items;
    assert.deepEqual(domain.map((v) => v.count), [0, 1, 2]);
    for (const v of domain) assert.equal(real('it-ok', 'Found', { items: { ref: items.ref, ...v } }), null, JSON.stringify(v));
  } finally { await rt.close(); }
});

test('PT10j, S140: the type check refuses an Items whose ref is forged, unstored or not of the runtime\'s form, or whose count is above L', async () => {
  const { rt, real } = await desk();
  try {
    await ask(rt, 'it-direct');
    const { items } = JSON.parse(journal(rt, 'it-direct').find((r) => r.action === 'Found').data);
    const key = items.ref.slice('items:'.length);
    const cases = {
      forged: { ref: 'items:forged', count: 1 },
      unstored: { ref: unstored(items.ref), count: 1 },
      'never stored': { ref: 'items:never-stored-0001', count: 1 },
      'no items: prefix': { ref: key, count: 1 },
      'count above L': { ref: items.ref, count: 3 },
      'negative count': { ref: items.ref, count: -1 },
      'no ref': { count: 1 },
    };
    const accepted = Object.entries(cases).filter(([, v]) => typeof real('it-direct', 'Found', { items: v }) !== 'string').map(([name]) => name);
    assert.deepEqual(accepted, [], 'each value is outside the type');
  } finally { await rt.close(); }
});

for (const [name, rewrite] of [
  ['a forged ref', (v) => ({ ...v, ref: 'items:forged' })],
  ['an unstored ref', (v) => ({ ...v, ref: unstored(v.ref) })],
  ['a ref without the items: prefix', (v) => ({ ...v, ref: v.ref.slice('items:'.length) })],
  ['a count above L with a stored ref', (v) => ({ ...v, count: 3 })],
]) {
  test(`S140: a Found completion carrying ${name} is refused before any step, with an audit row and no journal row`, async () => {
    const { rt, hook, seen, asked } = await desk();
    try {
      hook.rewrite = rewrite;
      await ask(rt, 'it-bad');
      const check = seen.find((s) => s.action === 'Found');
      assert.ok(check, 'the worker checked the Found completion');
      assert.equal(typeof check.verdict, 'string', `${JSON.stringify(check.used.items)} is outside the type`);
      assert.ok(!journal(rt, 'it-bad').some((r) => r.action === 'Found'), 'no Found step');
      assert.ok((await rt.audit('it-bad')).some((r) => r.rule === 'S140' && r.action === 'Found'), 'an S140 audit row for Found');
      assert.equal(asked.length, 0, 'no decision read the refused item set');
    } finally { await rt.close(); }
  });
}

test('PT10j, K10: an outside dispatch of a retrieval\'s completion is refused before any step, even with a stored ref', async () => {
  const { rt } = await desk();
  try {
    await ask(rt, 'it-k10');
    const { items } = JSON.parse(journal(rt, 'it-k10').find((r) => r.action === 'Found').data);
    await rt.create('concierge_memory.Desk', { id: 'it-k10b' });
    const before = journal(rt, 'it-k10b').length;
    await assert.rejects(rt.dispatch('it-k10b', 'Found', { items }), (e) => e instanceof RefusedDispatch || /only the outbox worker delivers it/.test(e.message));
    assert.equal(journal(rt, 'it-k10b').length, before);
  } finally { await rt.close(); }
});

// The sweep (S140, PT10j). conformance/ and examples/ hold no source with an Items parameter today, so the sweep also
// reads the test fixtures that declare one; without them its Items half would check nothing.
const itemsFixtures = polyFiles(join(ROOT, 'test', 'fixtures')).filter((f) => /:\s*Items\b/.test(readFileSync(f, 'utf8')));

test('S140, PT10j: no contract domain lists a ref; an Items domain is the counts 0..L, and every other domain value is in its type', async () => {
  const { actionTypes, dataOutside } = await import('../packages/poly-runtime/dist/src/types.js');
  let actions = 0;
  let itemsParams = 0;
  for (const f of [...polyFiles(join(ROOT, 'conformance')), ...polyFiles(join(ROOT, 'examples')), ...itemsFixtures]) {
    let built;
    try { built = build(f, 'items-type'); } catch { continue; } // a source the checker refuses has no build
    for (const { dir } of built) {
      const contract = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf8'));
      const types = actionTypes(contract);
      for (const [act, params] of Object.entries(contract.dataDomain ?? {})) {
        actions++;
        for (const [p, values] of Object.entries(params)) {
          const t = (types.get(act) ?? []).find(([q]) => q === p)?.[1];
          if (t?.k === 'items') {
            itemsParams++;
            // The domain holds counts only: no ref, synthetic or other, enters it.
            for (const v of values) {
              assert.ok(v && typeof v === 'object' && !('ref' in v), `${f} ${act}.${p}: ${JSON.stringify(v)} lists a ref`);
              assert.deepEqual(Object.keys(v), ['count'], `${f} ${act}.${p}: ${JSON.stringify(v)}`);
              assert.ok(Number.isInteger(v.count) && v.count >= 0, `${f} ${act}.${p}: ${JSON.stringify(v)}`);
            }
            const counts = values.map((v) => v.count).sort((x, y) => x - y);
            assert.deepEqual(counts, counts.map((_, i) => i), `${f} ${act}.${p}: the counts are 0..L`);
            continue;
          }
          // Every other domain value is in its type, as the sweep in runtime-type.test.mjs reads it.
          for (const v of values) {
            const only = new Map([[act, (types.get(act) ?? []).filter(([q]) => q === p)]]);
            if (dataOutside(only, act, { [p]: v }) !== null) assert.fail(`${f} ${act}.${p} = ${JSON.stringify(v)} is in its domain and refused`);
          }
        }
      }
    }
  }
  assert.ok(actions > 50, `${actions} actions`);
  assert.ok(itemsParams > 0, `${itemsParams} Items parameters swept`);
});
