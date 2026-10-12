// W1-W10: workflow budget tests (M7.5, PS18.7, K15, K16, PT10, PT24.6).
// Written from spec text alone; all tests fail during admission because feature not yet implemented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { load } from '@poly/runtime';
import { workflowTools } from '@poly/agent';
import { admit } from '@poly/check';
import { loaded, approveAs, makeKey, project } from './runtime-helpers.mjs';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';

const SRC = 'test/fixtures/m7/workflow-budget/desk.poly';
const M = 'desk.Desk';

/** The desk project: the source and the participant's price table beside it (a price table is read from beside the source), admitted. */
async function admittedDesk(name, text = readFileSync(join(ROOT, SRC), 'utf8')) {
  const key = makeKey(name);
  const dir = project(name, [], key, 'test-runtime');
  writeFileSync(join(dir, 'src', 'desk.poly'), text);
  cpSync(join(ROOT, 'test', 'fixtures', 'm7', 'workflow-budget', 'prices'), join(dir, 'src', 'prices'), { recursive: true });
  const r = await admit(dir);
  return { dir, key, build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey }, cert: r.certificate };
}

/** The desk with a run key (a run is named by its input), which the tool needs to show a run (PT10). */
const KEYED = readFileSync(join(ROOT, SRC), 'utf8').replace('  action Start()', '  action Start(n: 1..3)').replace('  on Start {', '  on Start(n) {').replace('  input Start\n', '  input Start\n  key "{n}" where n matches "^[1-3]$"\n');
let keyed;
const buildKeyed = async () => (keyed ??= await admittedDesk('workflow-budget-keyed', KEYED));

let built;
const build = async () => (built ??= await admittedDesk('workflow-budget'));

function budgetInstance(rt, scope) {
  const rows = rt.store.db.prepare("SELECT instance_id FROM pr_instance WHERE machine_id = ? ORDER BY instance_id").all('desk.spend.Budget');
  return rows.find((r) => r.instance_id.includes(scope));
}

async function budgetState(rt, instanceId) {
  if (!instanceId) return null;
  const chain = await rt.chain(instanceId);
  const steps = chain.filter((e) => e.kind === 'step' && e.body.stepKind === 'accepted');
  if (!steps.length) return null;
  const last = steps[steps.length - 1];
  return await rt.store.body(last.body.post);
}

async function verdictEvents(rt, id, stage = null) {
  const chain = await rt.chain(id);
  return chain.filter((e) => e.kind === 'verdict' && (stage === null || e.body.stage === stage)).map((e) => e.body);
}

async function allBudgetVerdicts(rt, id) {
  return (await verdictEvents(rt, id)).filter((v) => v.stage === 'budget');
}

test('W1: reservation at issue: after the first order is issued, budget instances hold a reservation of the cap', async () => {
  const { rt } = await loaded(await build());
  try {
    await rt.create(M, { id: 'w1-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order] = await rt.workOrders('w1-1');
    assert.ok(order, 'first order is issued');
    const run = budgetInstance(rt, ':run:w1-1');
    const month = budgetInstance(rt, ':month:');
    assert.ok(run && month, 'both instances exist');
    const runState = await budgetState(rt, run.instance_id);
    const monthState = await budgetState(rt, month.instance_id);
    assert.equal(runState.reserved, 50000, 'run reserved equals cap 50000');
    assert.equal(monthState.reserved, 50000, 'month reserved equals cap 50000');
    const allowed = (await verdictEvents(rt, 'w1-1')).filter((v) => v.outcome === 'allowed');
    assert.ok(allowed.length >= 1);
    const proposal = await rt.store.body(allowed[0].proposal);
    assert.equal(proposal.budget?.budget, 'spend', 'the proposal the gate saw names the budget');
    assert.equal(proposal.budget.remaining, 100000, 'and what remained of the least cap when it was checked');
  } finally { await rt.close(); }
});

test('W2.a: spend is the cap: report first order ok with usage { step: 2000 }, under the cap', async () => {
  const { rt } = await loaded(await build());
  try {
    await rt.create(M, { id: 'w2a-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order] = await rt.workOrders('w2a-1');
    assert.ok(order);
    const result = await rt.reportWorkOrder(order.orderId, { ok: true, result: {}, usage: { step: 2000 } });
    assert.equal(result.status, 'settled');
    const budgetVerdicts = await allBudgetVerdicts(rt, 'w2a-1');
    assert.ok(budgetVerdicts.length > 0, 'budget verdict recorded');
    const settle = budgetVerdicts.find((v) => v.outcome === 'settled');
    assert.ok(settle, 'outcome is settled');
    assert.equal(settle.reconciled, 'under', 'reconciled as under');
    assert.equal(settle.attempt, 1, 'attempt 1');
    assert.deepEqual(settle.reported, { usage: { step: 2000 }, units: 20000 }, 'reported usage and priced units');
    const runInst = budgetInstance(rt, ':run:w2a-1');
    const runState = await budgetState(rt, runInst.instance_id);
    assert.equal(runState.spent, 50000, 'spent is the cap, not the reported units');
    assert.equal(runState.reserved, 0, 'reserved is released to 0');
  } finally { await rt.close(); }
});

test('W2.b: spend is the cap: report equal usage { step: 5000 }', async () => {
  const { rt } = await loaded(await build());
  try {
    await rt.create(M, { id: 'w2b-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order] = await rt.workOrders('w2b-1');
    await rt.reportWorkOrder(order.orderId, { ok: true, result: {}, usage: { step: 5000 } });
    const settle = (await allBudgetVerdicts(rt, 'w2b-1')).find((v) => v.outcome === 'settled');
    assert.equal(settle.reconciled, 'equal');
    assert.equal(settle.reported.units, 50000);
  } finally { await rt.close(); }
});

test('W2.c: spend is the cap: report over usage { step: 6000 }', async () => {
  const { rt } = await loaded(await build());
  try {
    await rt.create(M, { id: 'w2c-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order] = await rt.workOrders('w2c-1');
    await rt.reportWorkOrder(order.orderId, { ok: true, result: {}, usage: { step: 6000 } });
    const settle = (await allBudgetVerdicts(rt, 'w2c-1')).find((v) => v.outcome === 'settled');
    assert.equal(settle.reconciled, 'over');
    assert.equal(settle.reported.units, 60000);
    const runInst = budgetInstance(rt, ':run:w2c-1');
    const runState = await budgetState(rt, runInst.instance_id);
    assert.equal(runState.spent, 50000, 'spent is still the cap');
  } finally { await rt.close(); }
});

test('W2.d: spend is the cap: report with no usage', async () => {
  const { rt } = await loaded(await build());
  try {
    await rt.create(M, { id: 'w2d-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order] = await rt.workOrders('w2d-1');
    await rt.reportWorkOrder(order.orderId, { ok: true, result: {} });
    const settle = (await allBudgetVerdicts(rt, 'w2d-1')).find((v) => v.outcome === 'settled');
    assert.equal(settle.reconciled, 'unreported');
    assert.equal(settle.reported, null);
  } finally { await rt.close(); }
});

test('W2.e: spend is the cap: report unpriceable { step: 1.5 }', async () => {
  const { rt } = await loaded(await build());
  try {
    await rt.create(M, { id: 'w2e-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order] = await rt.workOrders('w2e-1');
    await rt.reportWorkOrder(order.orderId, { ok: true, result: {}, usage: { step: 1.5 } });
    const settle = (await allBudgetVerdicts(rt, 'w2e-1')).find((v) => v.outcome === 'settled');
    assert.equal(settle.reconciled, 'unpriceable');
    assert.equal(settle.reported.units, null);
  } finally { await rt.close(); }
});

test('W2.f: spend is the cap: report unpriceable { nonsense: 3 }', async () => {
  const { rt } = await loaded(await build());
  try {
    await rt.create(M, { id: 'w2f-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order] = await rt.workOrders('w2f-1');
    await rt.reportWorkOrder(order.orderId, { ok: true, result: {}, usage: { nonsense: 3 } });
    const settle = (await allBudgetVerdicts(rt, 'w2f-1')).find((v) => v.outcome === 'settled');
    assert.equal(settle.reconciled, 'unpriceable');
  } finally { await rt.close(); }
});

test('W2.g: spend is the cap: report unpriceable { step: -1 }', async () => {
  const { rt } = await loaded(await build());
  try {
    await rt.create(M, { id: 'w2g-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order] = await rt.workOrders('w2g-1');
    await rt.reportWorkOrder(order.orderId, { ok: true, result: {}, usage: { step: -1 } });
    const settle = (await allBudgetVerdicts(rt, 'w2g-1')).find((v) => v.outcome === 'settled');
    assert.equal(settle.reconciled, 'unpriceable');
  } finally { await rt.close(); }
});

test('W3: the third order of a run is denied at the gate: cap 100,000, orders 1,2 ok, order 3 denied', { timeout: 60_000 }, async () => {
  const { rt } = await loaded(await build());
  try {
    await rt.create(M, { id: 'w3-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order1] = await rt.workOrders('w3-1');
    assert.ok(order1, 'order 1 issued');
    await rt.reportWorkOrder(order1.orderId, { ok: true, result: {}, usage: { step: 2000 } });
    await rt.tick();
    await rt.dispatch('w3-1', 'Redo', {});
    await rt.tick();
    const [order2] = await rt.workOrders('w3-1');
    assert.ok(order2 && order2.orderId !== order1.orderId, 'order 2 issued');
    await rt.reportWorkOrder(order2.orderId, { ok: true, result: {}, usage: { step: 2000 } });
    await rt.tick();
    await rt.dispatch('w3-1', 'Redo', {});
    await rt.tick();
    const orders3 = await rt.workOrders('w3-1');
    assert.equal(orders3.length, 0, 'order 3 is not issued');
    const denied = (await verdictEvents(rt, 'w3-1')).find((v) => v.outcome === 'denied' && v.reason === 'budget');
    assert.ok(denied, 'order 3 verdict is denied with reason budget');
    const state = (await rt.getState('w3-1')).state;
    assert.equal(state.phase, 'Failed', 'run reaches Failed phase after denial');
    const runInst = budgetInstance(rt, ':run:w3-1');
    const runState = await budgetState(rt, runInst.instance_id);
    assert.equal(runState.spent, 100000, 'spent is 100,000 (two orders at cap)');
    assert.equal(runState.reserved, 0, 'reserved is 0 (order 3 not issued)');
  } finally { await rt.close(); }
});

test('W4: never released: failed order still spends its cap', async () => {
  const { rt } = await loaded(await build());
  try {
    await rt.create(M, { id: 'w4-fail-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order] = await rt.workOrders('w4-fail-1');
    assert.ok(order);
    await rt.reportWorkOrder(order.orderId, { ok: false });
    const runInst = budgetInstance(rt, ':run:w4-fail-1');
    const runState = await budgetState(rt, runInst.instance_id);
    assert.equal(runState.spent, 50000, 'failed order still spends the cap');
  } finally { await rt.close(); }
});

test('W4: never released: lapsed order attempt 1 settled, attempt 2 reserves again, third attempt denied', { timeout: 60_000 }, async () => {
  const { rt, clock } = await loaded(await build());
  try {
    await rt.create(M, { id: 'w4-lapse-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [attempt1] = await rt.workOrders('w4-lapse-1');
    assert.equal(attempt1.attempt, 1, 'first attempt issued');
    const attempt1Id = attempt1.orderId;
    clock.advance(31_000);
    await rt.tick();
    const ordersAfterLapse = await rt.workOrders('w4-lapse-1');
    assert.equal(ordersAfterLapse.length, 0, 'attempt 1 is no longer open');
    const settleAttempt1 = (await allBudgetVerdicts(rt, 'w4-lapse-1')).find((v) => v.outcome === 'settled' && v.attempt === 1);
    assert.ok(settleAttempt1, 'attempt 1 settle event exists');
    assert.equal(settleAttempt1.reconciled, 'unreported', 'attempt 1 reconciled unreported');
    clock.advance(2_000);
    await rt.tick();
    const [attempt2] = await rt.workOrders('w4-lapse-1');
    assert.ok(attempt2, 'attempt 2 issued');
    assert.equal(attempt2.attempt, 2, 'second attempt');
    assert.equal(attempt2.intent, attempt1.intent, 'same intent');
    assert.notEqual(attempt2.orderId, attempt1Id, 'new order id');
    const monthInst = budgetInstance(rt, ':month:');
    let monthState = await budgetState(rt, monthInst.instance_id);
    assert.equal(monthState.spent, 50000, 'attempt 1 settled for 50k');
    assert.equal(monthState.reserved, 50000, 'attempt 2 reserved for 50k');
    const lateReport = await rt.reportWorkOrder(attempt1Id, { ok: true, result: {} });
    assert.notEqual(lateReport.status, 'settled', 'report of attempt 1 order id is refused');
    clock.advance(31_000);
    await rt.tick();
    clock.advance(2_000);
    await rt.tick();
    const attempt3 = await rt.workOrders('w4-lapse-1');
    assert.equal(attempt3.length, 0, 'attempt 3 not issued when run cap (100k) is held by two attempts');
    const allVerdicts = await verdictEvents(rt, 'w4-lapse-1');
    const failureVerdicts = allVerdicts.filter((v) => v.reason === 'budget' && v.outcome === 'denied');
    assert.ok(failureVerdicts.length > 0, 'failure completion delivered with budget reason');
  } finally { await rt.close(); }
});

test('W4: never released: no verdict event has outcome released or released:true in budgets', async () => {
  const { rt } = await loaded(await build());
  try {
    await rt.create(M, { id: 'w4-no-release-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order] = await rt.workOrders('w4-no-release-1');
    await rt.reportWorkOrder(order.orderId, { ok: false });
    const allVerdicts = await verdictEvents(rt, 'w4-no-release-1');
    const released = allVerdicts.filter((v) => v.outcome === 'released');
    assert.equal(released.length, 0, 'no outcome released');
    for (const v of allVerdicts) {
      if (v.budgets) {
        for (const b of v.budgets) {
          assert.equal(b.released, undefined, `no released field on budget`);
        }
      }
    }
  } finally { await rt.close(); }
});

test('W5: per month and scope: second run accumulates on same month instance', { timeout: 60_000 }, async () => {
  const { rt, clock } = await loaded(await build());
  try {
    await rt.create(M, { id: 'w5-run1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order1] = await rt.workOrders('w5-run1');
    await rt.reportWorkOrder(order1.orderId, { ok: true, result: {}, usage: { step: 5000 } });
    let monthInst = budgetInstance(rt, ':month:');
    let monthState = await budgetState(rt, monthInst.instance_id);
    const firstMonthId = monthInst.instance_id;
    assert.equal(monthState.spent, 50000, 'first run spent 50k');
    await rt.create(M, { id: 'w5-run2', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order2] = await rt.workOrders('w5-run2');
    await rt.reportWorkOrder(order2.orderId, { ok: true, result: {}, usage: { step: 5000 } });
    monthState = await budgetState(rt, monthInst.instance_id);
    assert.equal(monthState.spent, 100000, 'month instance spent: both runs');
    clock.advance(40 * 86_400_000);
    await rt.create(M, { id: 'w5-run3', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order3] = await rt.workOrders('w5-run3');
    assert.ok(order3, 'order in new month issued');
    const months = rt.store.db.prepare("SELECT instance_id FROM pr_instance WHERE machine_id = 'desk.spend.Budget' AND instance_id LIKE '%:month:%' ORDER BY instance_id").all();
    assert.equal(months.length, 2, 'a month later is a fresh month instance');
    const newMonthInst = months.find((m) => m.instance_id !== firstMonthId);
    assert.ok(newMonthInst, 'new month instance created');
    const newMonthState = await budgetState(rt, newMonthInst.instance_id);
    assert.equal(newMonthState.reserved, 50000, 'new month reserved the order cap');
    const oldMonthState = await budgetState(rt, firstMonthId);
    assert.equal(oldMonthState.spent, 100000, 'old month instance keeps its spend');
  } finally { await rt.close(); }
});

test('W6: escalate: order that does not fit is escalated when on exhausted escalate, and denied after approval', { timeout: 60_000 }, async () => {
  const escalateSrc = readFileSync(join(ROOT, SRC), 'utf8').replace('  cap usd 0.5 per month\n', '  cap usd 0.5 per month\n  on exhausted escalate\n');
  const key = makeKey('w6-escalate');
  const dir = project('workflow-budget-w6', [SRC], key);
  writeFileSync(join(dir, 'src', 'desk.poly'), escalateSrc);
  cpSync(join(ROOT, 'test', 'fixtures', 'm7', 'workflow-budget', 'prices'), join(dir, 'src', 'prices'), { recursive: true });
  const r = await admit(dir);
  const { rt } = await loaded({ dir, key, build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey }, cert: r.certificate });
  try {
    await rt.create(M, { id: 'w6-esc-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order1] = await rt.workOrders('w6-esc-1');
    await rt.reportWorkOrder(order1.orderId, { ok: true, result: {}, usage: { step: 2000 } });
    await rt.tick();
    await rt.dispatch('w6-esc-1', 'Redo', {});
    await rt.tick();
    const [order2] = await rt.workOrders('w6-esc-1');
    await rt.reportWorkOrder(order2.orderId, { ok: true, result: {}, usage: { step: 2000 } });
    await rt.tick();
    await rt.dispatch('w6-esc-1', 'Redo', {});
    await rt.tick();
    const orders3pre = await rt.workOrders('w6-esc-1');
    assert.equal(orders3pre.length, 0, 'order 3 not issued yet');
    const escalated = (await verdictEvents(rt, 'w6-esc-1')).find((v) => v.outcome === 'escalated' && v.reason === 'budget');
    assert.ok(escalated, 'order 3 verdict is escalated with reason budget');
    const allVerdicts = await verdictEvents(rt, 'w6-esc-1');
    const escalatedIntent = allVerdicts.find((v) => v.outcome === 'escalated' && v.reason === 'budget')?.intent;
    assert.ok(escalatedIntent, 'escalated intent found');
    await approveAs(rt, escalatedIntent);
    await rt.tick();
    const orders3post = await rt.workOrders('w6-esc-1');
    assert.equal(orders3post.length, 0, 'order 3 still not issued after approval');
    const denied = (await verdictEvents(rt, 'w6-esc-1')).find((v) => v.outcome === 'denied' && v.reason === 'budget');
    assert.ok(denied, 'approved order is denied, not escalated again');
  } finally { await rt.close(); }
});

test('W7: workflow_report takes usage through the tool: it is recorded and reconciled as a direct report is', { timeout: 60_000 }, async () => {
  const { rt } = await loaded(await buildKeyed());
  try {
    const report = workflowTools(rt).find((t) => t.name === 'workflow_report');
    assert.ok(report.inputSchema.properties.usage, 'the tool declares usage');
    const run = (await rt.startWorkflow('desk', { n: 1 })).instanceId;
    await rt.tick();
    const [order] = await rt.workOrders(run);
    const view = await report.handler({ order_id: order.orderId, ok: true, result: {}, usage: { step: 2000 } });
    assert.ok(!view.error, JSON.stringify(view));
    const settle = (await allBudgetVerdicts(rt, run)).find((v) => v.outcome === 'settled');
    assert.deepEqual([settle.reconciled, settle.reported.units, settle.orderCap], ['under', 20000, 50000]);
    const runState = await budgetState(rt, budgetInstance(rt, `:run:${run}`).instance_id);
    assert.equal(runState.spent, 50000);
  } finally { await rt.close(); }
});

test('W7: a usage that is not a map from class to a number is refused as a tool error, and nothing is recorded: the order stays open', { timeout: 60_000 }, async () => {
  const { rt } = await loaded(await buildKeyed());
  try {
    const report = workflowTools(rt).find((t) => t.name === 'workflow_report');
    const run = (await rt.startWorkflow('desk', { n: 2 })).instanceId;
    await rt.tick();
    const [order] = await rt.workOrders(run);
    for (const usage of ['lots', ['step', 1], { step: 'x' }, { step: null }, null]) {
      const view = await report.handler({ order_id: order.orderId, ok: true, result: {}, usage });
      assert.ok(view.error, JSON.stringify([usage, view]));
      assert.match(view.error, /usage/);
      assert.equal((await rt.workOrders(run)).length, 1, 'the order is still open');
      assert.deepEqual(await allBudgetVerdicts(rt, run), [], 'nothing was settled');
    }
    const state = await budgetState(rt, budgetInstance(rt, `:run:${run}`).instance_id);
    assert.deepEqual([state.spent, state.reserved], [0, 50000], 'the budget is as the issue left it');
    const ok = await report.handler({ order_id: order.orderId, ok: true, result: {} });
    assert.ok(!ok.error, 'the control: without a usage the same report is taken');
  } finally { await rt.close(); }
});

test('W8: the certificate lists K16 and the workflow budget exactly, and a changed descriptor is refused at load', { timeout: 300_000 }, async () => {
  const a = await admittedDesk('workflow-budget-cert');
  const poly = a.cert.poly;
  assert.ok(poly.kernelAssumptions.includes('K16'), 'K16 is listed');
  const table = readFileSync(join(ROOT, 'test', 'fixtures', 'm7', 'workflow-budget', 'prices', 'agent.json'));
  const wf = poly.workflows.find((w) => w.name === 'desk');
  assert.deepEqual(wf.budget, { budget: 'spend', prices: { path: 'prices/agent.json', digest: 'sha256:' + createHash('sha256').update(table).digest('hex'), currency: 'usd' }, orderCap: 50000, usage: 'self-reported', bound: 'reservation' });
  const loadedOk = await load(a.build, { certificate: a.certificate, trust: a.trust });
  await loadedOk.close();
  const file = join(a.dir, wf.descriptor);
  const descriptor = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(descriptor.budget.orderCap, 50000);
  descriptor.budget.orderCap = 60000;
  writeFileSync(file, JSON.stringify(descriptor, null, 2) + '\n');
  await assert.rejects(load(a.build, { certificate: a.certificate, trust: a.trust }), /refused at load/);
});

test('W9: poly cost sums each settled attempt of a work order by run, scope and day, and counts the reconciliations', { timeout: 300_000 }, async () => {
  const a = await admittedDesk('workflow-budget-w9');
  const db = join(a.dir, 'run.db');
  rmSync(db, { force: true });
  const T0 = Date.UTC(2026, 9, 7, 12);
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust, store: { sqlite: db }, now: () => T0 });
  try {
    for (const [id, usage] of [['cost-under', { step: 2000 }], ['cost-over', { step: 6000 }], ['cost-unreported', undefined]]) {
      await rt.create(M, { id, creation: { action: 'Start', data: {} } });
      await rt.tick();
      const [o] = await rt.workOrders(id);
      assert.equal((await rt.reportWorkOrder(o.orderId, { ok: true, result: {}, ...(usage ? { usage } : {}) })).status, 'settled');
    }
  } finally { await rt.close(); }
  const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, cli, 'cost', '--db', db, ...args, '--json'], { encoding: 'utf8' }));
  const report = run();
  assert.equal(report.calls, 0, 'no decision call');
  assert.deepEqual(report.total, { usd: 150000 }, 'three attempts at the cap');
  assert.deepEqual(report.byRun, { 'cost-under': { usd: 50000 }, 'cost-over': { usd: 50000 }, 'cost-unreported': { usd: 50000 } });
  assert.deepEqual(report.byScope, { desk: { usd: 150000 } });
  assert.deepEqual(report.byDay, { '2026-10-07': { usd: 150000 } });
  assert.deepEqual(report.orders, { attempts: 3, reconciled: { under: 1, equal: 0, over: 1, unreported: 1, unpriceable: 0 }, reported: { usd: 80000 } });
  assert.deepEqual(report.refused, []);
  assert.equal(run('--run', 'cost-over').orders.attempts, 1, 'by run');
  assert.equal(run('--period', '2026-11').orders.attempts, 0, 'by period');
  assert.equal(run('--scope', 'other').orders.attempts, 0, 'by scope');
});

test('W10: K16 broken variant - a report never credits a reservation: usage { step: 1 } still spends full cap', async () => {
  const { rt } = await loaded(await build());
  try {
    await rt.create(M, { id: 'w10-k16-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order] = await rt.workOrders('w10-k16-1');
    assert.ok(order);
    await rt.reportWorkOrder(order.orderId, { ok: true, result: {}, usage: { step: 1 } });
    const runInst = budgetInstance(rt, ':run:w10-k16-1');
    const runState = await budgetState(rt, runInst.instance_id);
    assert.equal(runState.spent, 50000, 'spent equals cap, not reported units');
    assert.equal(runState.reserved, 0, 'no reserved left');
    const remaining = 100000 - runState.spent;
    assert.equal(remaining, 50000, 'remaining = cap - spent = 100000 - 50000 = 50000');
  } finally { await rt.close(); }
});

test('K16: the broken variant workflow-report-credits does let a report reduce the spend, so the test above has teeth', async () => {
  const { rt } = await loaded(await build(), { fault: 'workflow-report-credits' });
  try {
    await rt.create(M, { id: 'w10-broken-1', creation: { action: 'Start', data: {} } });
    await rt.tick();
    const [order] = await rt.workOrders('w10-broken-1');
    await rt.reportWorkOrder(order.orderId, { ok: true, result: {}, usage: { step: 1 } });
    const runState = await budgetState(rt, budgetInstance(rt, ':run:w10-broken-1').instance_id);
    assert.equal(runState.spent, 10, 'the broken runtime charged the reported 10 micro-usd, not the cap');
  } finally { await rt.close(); }
});
