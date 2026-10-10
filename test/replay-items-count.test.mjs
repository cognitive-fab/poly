// PS11.4, PT10l (ruled 2026-10-10): replay takes what the checker admits. A handler that reads the count of an Items
// of its step's data is checked and run, so replay reads that Items as the checker's value, the record whose count the
// handler reads, its ref carried and never read. The concierge here reads items.count on Found and cites.count on
// Answered; the run is driven to its end and every run replays with no diagnostic. No test reaches a database or calls
// a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postgresSource } from '@poly/io';
import { replayRuntime } from '@poly/check';
import { admitted, loaded } from './runtime-helpers.mjs';
import { pgOrders } from './memory-helpers.mjs';

const a = await admitted('replay-items-count', ['test/fixtures/replay-count/concierge-count.poly']);

/** The desk with its source connected over cust-a's and cust-b's orders, and a recorded provider that cites o-2. */
async function desk() {
  const { rt } = await loaded(a, { verifier: (c) => (c ? { principal: c.principal } : null) });
  const db = pgOrders();
  rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
  rt.provide('answer', { provider: () => ({ answer: 'Order 2 shipped.', distribution: [['Order 2 shipped.', 0.9]], cites: ['o-2'] }), model: 'flash' });
  return rt;
}

test('PS11.4: a run whose handlers read items.count and cites.count replays with no diagnostic', async () => {
  const rt = await desk();
  try {
    await rt.create('concierge_count.Desk', { id: 'desk-count' });
    const q = await rt.putContent('Where is my order?');
    await rt.dispatch('desk-count', 'Ask', { question: q }, { credentials: { principal: 'cust-a' } });
    for (let k = 0; k < 4; k++) await rt.worker.tick();
    assert.equal((await rt.getState('desk-count')).state.phase, 'Idle');
    const steps = rt.store.db.prepare("SELECT action, data, step_kind FROM pr_journal WHERE instance_id = 'desk-count'").all();
    // Found took the branch that reads items.count (two orders), and Answered passed its cites.count requirement.
    const found = steps.find((s) => s.action === 'Found');
    assert.ok(found, JSON.stringify(steps.map((s) => s.action)));
    assert.equal(JSON.parse(found.data).items.count, 2);
    const answered = steps.find((s) => s.action === 'Answered');
    assert.ok(answered, JSON.stringify(steps.map((s) => s.action)));
    assert.equal(answered.step_kind, 'accepted');
    assert.equal(JSON.parse(answered.data).cites.count, 1);
    // PS11.4: a step the runtime took and replay refuses is a fault of replay, never of the program.
    const runs = await replayRuntime(rt);
    assert.ok(runs.some((r) => r.run === 'desk-count'), JSON.stringify(runs.map((r) => r.run)));
    for (const r of runs) assert.deepEqual(r.diagnostics.map((d) => `${d.code} ${d.message}`), [], r.run);
  } finally { await rt.close(); }
});
