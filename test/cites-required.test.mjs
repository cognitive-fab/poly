// PS17.6, PT10l (ruled 2026-10-10): a citation is required. A decision with `cites x` must cite: an answer whose
// citation list is empty, or that gives none, is refused uncited by the same check that refuses an item the decision
// was not given, such as an item of another thread's retrieval. The refusal is recorded on the run as
// { stage: 'citation', outcome: 'uncited' }, the ok outcome is not delivered, and the failed outcome runs. So
// r.cites.count is at least 1 in every ok outcome. No test reaches a database or calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postgresSource } from '@poly/io';
import { admitted, loaded } from './runtime-helpers.mjs';
import { pgOrders } from './memory-helpers.mjs';

const a = await admitted('cites-required', ['test/fixtures/m10/concierge-memory.poly']);

/**
 * The concierge, its source over cust-a's and cust-b's orders, and a recorded provider whose citations `cites` gives
 * per customer: a list, or undefined for an answer with no cites field at all.
 */
async function concierge(cites) {
  const { rt } = await loaded(a, { verifier: (c) => (c ? { principal: c.principal } : null) });
  const db = pgOrders();
  rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
  rt.provide('answer', {
    provider: (q, m) => {
      const ids = Object.values(m.items).flat().map((i) => i.id);
      const c = cites(ids);
      return { answer: 'Your order shipped.', distribution: [['Your order shipped.', 0.9]], ...(c === undefined ? {} : { cites: c }) };
    },
    model: 'flash',
  });
  return rt;
}

async function ask(rt, id, customer) {
  await rt.create('concierge_memory.Desk', { id });
  const q = await rt.putContent('Where is my order?');
  await rt.dispatch(id, 'Ask', { question: q }, { credentials: { principal: customer } });
  for (let k = 0; k < 4; k++) await rt.worker.tick();
}

const stepsOf = (rt, id) => rt.store.db.prepare('SELECT action, data FROM pr_journal WHERE instance_id = ?').all(id);
const eventsOf = (rt, id) => rt.store.db.prepare('SELECT event FROM poly_ledger WHERE run = ?').all(id).map((r) => JSON.parse(r.event).body);

/** The ok outcome completed with `count` citations, and no citation refusal is on the run. */
function completed(rt, id, count) {
  const steps = stepsOf(rt, id);
  const answered = steps.find((s) => s.action === 'Answered');
  assert.ok(answered, `${id}: ${JSON.stringify(steps.map((s) => s.action))}`);
  assert.equal(JSON.parse(answered.data).cites.count, count);
  assert.ok(!steps.some((s) => s.action === 'AnswerFailed'), id);
  assert.ok(!eventsOf(rt, id).some((b) => b?.stage === 'citation'), id);
}

/** PS17.6: refused uncited. No Answered step, the AnswerFailed step runs, and the refusal is on the run's ledger. */
function refusedUncited(rt, id) {
  const steps = stepsOf(rt, id);
  assert.ok(!steps.some((s) => s.action === 'Answered'), `${id}: the ok outcome is not delivered: ${JSON.stringify(steps.map((s) => s.action))}`);
  assert.ok(steps.some((s) => s.action === 'AnswerFailed'), `${id}: the failed outcome runs`);
  assert.ok(eventsOf(rt, id).some((b) => b?.stage === 'citation' && b.outcome === 'uncited'), `${id}: the refusal is recorded on the run`);
}

test('PS17.6: an answer citing an item it was given completes, with cites.count 1 (the control)', async () => {
  const rt = await concierge(() => ['o-2']);
  try {
    await ask(rt, 'desk-ok', 'cust-a');
    assert.equal((await rt.getState('desk-ok')).state.phase, 'Idle');
    completed(rt, 'desk-ok', 1);
  } finally { await rt.close(); }
});

test('PS17.6, PT10l: an answer whose citation list is empty is refused uncited, and the failed outcome runs', async () => {
  const rt = await concierge(() => []);
  try {
    await ask(rt, 'desk-empty', 'cust-a');
    assert.equal((await rt.getState('desk-empty')).state.phase, 'Idle');
    refusedUncited(rt, 'desk-empty');
  } finally { await rt.close(); }
});

test('PS17.6, PT10l: an answer that gives no citations is refused uncited, and the failed outcome runs', async () => {
  const rt = await concierge(() => undefined);
  try {
    await ask(rt, 'desk-absent', 'cust-a');
    assert.equal((await rt.getState('desk-absent')).state.phase, 'Idle');
    refusedUncited(rt, 'desk-absent');
  } finally { await rt.close(); }
});

test('PS17.6: an answer citing an item of another thread\'s retrieval is refused uncited; that thread\'s own answer citing it completes', async () => {
  // cust-b's desk retrieves o-3 and cites it; cust-a's desk is given o-2 and o-1 and cites o-3, an item the runtime
  // stored but that this decision was not given.
  const rt = await concierge(() => ['o-3']);
  try {
    await ask(rt, 'desk-b', 'cust-b');
    completed(rt, 'desk-b', 1);
    await ask(rt, 'desk-a', 'cust-a');
    assert.equal((await rt.getState('desk-a')).state.phase, 'Idle');
    refusedUncited(rt, 'desk-a');
  } finally { await rt.close(); }
});
