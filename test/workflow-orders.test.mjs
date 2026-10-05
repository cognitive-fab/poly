// M8a step 1 (S173): a workflow's effects run on poly-runtime as work orders. The gate decides before an order exists;
// the agent's report settles the intent and is journaled; a lapsed order is re-issued under the same id at the next
// attempt and never proposed again, and a report against a superseded attempt is refused and audited (PF8.5a); a work
// order's completions are delivered by the runtime only (K9). A scripted agent drives the runtime API; no model runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RefusedDispatch } from '@poly/runtime';
import { admitted, loaded, approveAs, handleWith } from './runtime-helpers.mjs';

const SRC = 'conformance/m6/customer-brief.poly';
const M = 'customer_brief.Brief';
const start = (rt, id) => rt.create(M, { id, creation: { action: 'START', data: { date: '2026-10-04' } } });
const state = async (rt, id) => (await rt.instances()).find((i) => i.id === id)?.state;
const verdicts = async (rt, id) => (await rt.chain(id)).filter((e) => e.kind === 'verdict').map((e) => e.body);
const RESULTS = { fetch_tickets: { count: 2 }, draft_brief: {}, request_approval: {}, post_brief: {} };

/** The agent: takes each open order of a run, reports it done, and records the tool it was asked to call. */
async function drive(rt, id, tools, limit = 10) {
  for (let k = 0; k < limit; k++) {
    await rt.tick();
    const [order] = await rt.workOrders(id);
    if (!order) return;
    tools.push(order.tool);
    const r = await rt.reportWorkOrder(order.orderId, { attempt: order.attempt, ok: true, result: RESULTS[order.kind] });
    assert.equal(r.status, 'settled', JSON.stringify(r));
  }
}

let built;
const build = async () => (built ??= await admitted('workflow-orders', [SRC]));

test('S173: each effect of a workflow is a work order issued after the gate allows it, and the agent\'s report settles it', async () => {
  const { rt } = await loaded(await build());
  try {
    await start(rt, 'run-1');
    await rt.tick();
    const [order, ...rest] = await rt.workOrders('run-1');
    assert.equal(rest.length, 0);
    assert.deepEqual({ kind: order.kind, tool: order.tool, why: order.why, args: order.args, attempt: order.attempt }, { kind: 'fetch_tickets', tool: 'github_search_issues', why: "gather yesterday's support tickets", args: { window: 'yesterday' }, attempt: 1 });
    // The gate's allow is in the ledger before the order is issued.
    const chain = await rt.chain('run-1');
    const allowed = chain.findIndex((e) => e.kind === 'verdict' && e.body.intent === order.orderId && e.body.outcome === 'allowed');
    const issued = chain.findIndex((e) => e.kind === 'observation' && e.body.stage === 'work-order' && e.body.intent === order.orderId && e.body.outcome === 'issued');
    assert.ok(allowed >= 0 && issued > allowed, `allowed at ${allowed}, issued at ${issued}`);
    const tools = [order.tool];
    assert.equal((await rt.reportWorkOrder(order.orderId, { attempt: 1, ok: true, result: { count: 2 } })).status, 'settled');
    assert.equal((await state(rt, 'run-1')).briefState, 'drafting');
    await drive(rt, 'run-1', tools);
    assert.deepEqual(tools, ['github_search_issues', 'ask', 'ask_user', 'slack_send']);
    assert.equal((await state(rt, 'run-1')).briefState, 'posted');
    // Each report is observed on the run and its completion journaled; the chain verifies.
    const settled = (await rt.chain('run-1')).filter((e) => e.kind === 'observation' && e.body.stage === 'handler' && e.body.outcome === 'ok');
    assert.equal(settled.length, 4);
    assert.ok((await rt.verifyChain('run-1')).ok);
  } finally { await rt.close(); }
});

test('S173: a work order\'s kind takes no handler; the report is its only result', async () => {
  const { rt } = await loaded(await build());
  try {
    assert.throws(() => handleWith(rt, 'post_brief', () => ({})), /work order.*S173/);
  } finally { await rt.close(); }
});

test('S173: a denied work order is never issued; its failure completion is delivered', async () => {
  const gate = { propose: (p) => (p.effectKind === 'post_brief' ? { decision: 'deny', reason: 'no-posting' } : { decision: 'allow' }), settle: () => 'ok' };
  const { rt } = await loaded(await build(), { gate: { gate } });
  try {
    await start(rt, 'run-deny');
    const tools = [];
    await drive(rt, 'run-deny', tools);
    assert.deepEqual(tools, ['github_search_issues', 'ask', 'ask_user']);
    assert.equal((await state(rt, 'run-deny')).briefState, 'failed');
    assert.ok((await verdicts(rt, 'run-deny')).some((v) => v.effectKind === 'post_brief' && v.outcome === 'denied' && v.reason === 'no-posting'));
    const post = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'post_brief'").get('run-deny').intent_id;
    const issued = (await rt.chain('run-deny')).filter((e) => e.kind === 'observation' && e.body.stage === 'work-order').map((e) => e.body.intent);
    assert.equal(issued.length, 3);
    assert.ok(!issued.includes(post), 'no order was issued for the denied intent');
  } finally { await rt.close(); }
});

test('S173: an escalated work order is issued only after a signed approval', async () => {
  const gate = { propose: (p) => (p.effectKind === 'post_brief' && !p.approved ? { decision: 'escalate', reason: 'public-post' } : { decision: 'allow' }), settle: () => 'ok' };
  const { rt } = await loaded(await build(), { gate: { gate } });
  try {
    await start(rt, 'run-esc');
    const tools = [];
    await drive(rt, 'run-esc', tools);
    assert.deepEqual(tools, ['github_search_issues', 'ask', 'ask_user']);
    assert.equal((await state(rt, 'run-esc')).briefState, 'posting');
    assert.deepEqual(await rt.workOrders('run-esc'), [], 'no order while the escalation waits');
    const intent = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'post_brief'").get('run-esc').intent_id;
    await approveAs(rt, intent);
    await drive(rt, 'run-esc', tools);
    assert.deepEqual(tools, ['github_search_issues', 'ask', 'ask_user', 'slack_send']);
    assert.equal((await state(rt, 'run-esc')).briefState, 'posted');
  } finally { await rt.close(); }
});

test('S173, PF8.5a: a lapsed order is re-issued under the same id at the next attempt, never proposed again, and a superseded attempt\'s report is refused and audited', async () => {
  const { rt, clock } = await loaded(await build());
  try {
    await start(rt, 'run-retry');
    await rt.tick();
    const [first] = await rt.workOrders('run-retry');
    assert.equal(first.attempt, 1);
    clock.advance(120_000 + 1); // past the effect's declared timeout (2m)
    await rt.tick();
    assert.deepEqual(await rt.workOrders('run-retry'), [], 'the lapsed attempt is no longer open');
    clock.advance(1_000); // the declared backoff
    await rt.tick();
    const [second] = await rt.workOrders('run-retry');
    assert.equal(second.orderId, first.orderId);
    assert.equal(second.attempt, 2);
    const allows = (await verdicts(rt, 'run-retry')).filter((v) => v.intent === first.orderId && v.outcome === 'allowed');
    assert.equal(allows.length, 1, 'the retry is not proposed again');
    // The agent that held attempt 1 reports late: refused and audited, and nothing changes.
    const late = await rt.reportWorkOrder(first.orderId, { attempt: 1, ok: true, result: { count: 3 } });
    assert.equal(late.status, 'refused');
    assert.match(late.reason, /superseded/);
    assert.equal((await state(rt, 'run-retry')).briefState, 'gathering');
    assert.equal((await rt.reportWorkOrder(second.orderId, { attempt: 2, ok: true, result: { count: 2 } })).status, 'settled');
    // A second report of the same attempt is refused too: an agent is never credited twice.
    const again = await rt.reportWorkOrder(second.orderId, { attempt: 2, ok: true, result: { count: 1 } });
    assert.equal(again.status, 'refused');
    assert.equal((await state(rt, 'run-retry')).ticketCount, 2);
    assert.equal((await rt.reportWorkOrder('intent:no-such-order', { attempt: 1, ok: true })).status, 'refused');
    const audit = (await rt.audit('run-retry')).filter((r) => r.rule === 'S173');
    assert.equal(audit.length, 2, JSON.stringify(audit));
  } finally { await rt.close(); }
});

test('S173, PF8.5a: a report that arrives after its order\'s deadline is refused, even before the runtime re-issues the order', async () => {
  const { rt, clock } = await loaded(await build());
  try {
    await start(rt, 'run-lapse');
    await rt.tick();
    const [o] = await rt.workOrders('run-lapse');
    clock.advance(120_000);
    const late = await rt.reportWorkOrder(o.orderId, { attempt: 1, ok: true, result: { count: 2 } });
    assert.equal(late.status, 'refused');
    assert.match(late.reason, /lapsed/);
    assert.equal((await state(rt, 'run-lapse')).briefState, 'gathering');
    clock.advance(1_001);
    await rt.tick();
    await rt.tick();
    clock.advance(1_000);
    await rt.tick();
    assert.equal((await rt.workOrders('run-lapse'))[0]?.attempt, 2);
  } finally { await rt.close(); }
});

test('S173: a failed report retries under the same order, and the last attempt delivers the exhausted completion', async () => {
  const { rt, clock } = await loaded(await build());
  try {
    await start(rt, 'run-fail');
    for (let n = 1; n <= 3; n++) {
      await rt.tick();
      const [o] = await rt.workOrders('run-fail');
      assert.equal(o.attempt, n);
      assert.equal((await rt.reportWorkOrder(o.orderId, { attempt: n, ok: false, error: 'api down' })).status, n < 3 ? 'retrying' : 'failed');
      clock.advance(10_000);
    }
    assert.equal((await state(rt, 'run-fail')).briefState, 'failed');
    assert.equal((await state(rt, 'run-fail')).reason, 'api-error');
  } finally { await rt.close(); }
});

test('S173, K9: a work order\'s completion actions are delivered by the runtime only; an outside dispatch is refused and audited', async () => {
  const { rt } = await loaded(await build());
  try {
    await start(rt, 'run-k9');
    await rt.tick();
    for (const [action, data] of [['TICKETS_READY', { count: 2 }], ['TICKETS_FAILED', { reason: 'api-error' }]]) {
      await assert.rejects(rt.dispatch('run-k9', action, data, { actionId: `outside-${action}` }), (e) => e instanceof RefusedDispatch && e.rule === 'K9');
    }
    assert.equal((await state(rt, 'run-k9')).briefState, 'gathering');
    assert.deepEqual((await rt.audit('run-k9')).filter((r) => r.rule === 'K9').map((r) => r.action), ['TICKETS_READY', 'TICKETS_FAILED']);
  } finally { await rt.close(); }
});
