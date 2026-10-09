// The work order's idempotency key (PT10, S173 as amended, accepted with V5), written from the specification text
// before the change. Each issued work order carries `idempotency_key`, the intent's id, the same for every attempt of
// the intent; the order id stays per attempt and is still the only name a report gives. The key grants nothing: a
// report is accepted only under the open attempt's order id. The order schema served by `poly run --mcp` gains the
// field. A scripted agent drives the runtime and the MCP server; no model runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { mcpClient } from './mcp-client.mjs';
import { admitted, loaded } from './runtime-helpers.mjs';

const SRC = 'conformance/m6/customer-brief.poly';
const M = 'customer_brief.Brief';
const SERVER = join(ROOT, 'test', 'fixtures', 'workflow-server.mjs');
const start = (rt, id) => rt.create(M, { id, creation: { action: 'START', data: { date: '2026-10-04' } } });
const state = async (rt, id) => (await rt.instances()).find((i) => i.id === id)?.state;
// The runtime API names its fields in camelCase (orderId), the MCP order in snake_case (order_id); the
// specification names the field `idempotency_key`, so the runtime's order may carry either spelling.
const keyOf = (order) => order.idempotencyKey ?? order.idempotency_key;

let built;
const build = async () => (built ??= await admitted('order-key', [SRC]));

test('S173 as amended: the first order of an intent carries idempotency_key, the intent\'s id', async () => {
  const { rt } = await loaded(await build());
  try {
    await start(rt, 'key-1');
    await rt.tick();
    const [order] = await rt.workOrders('key-1');
    assert.ok(order, 'an order is issued');
    assert.equal(keyOf(order), order.intent, JSON.stringify(order));
    assert.notEqual(keyOf(order), order.orderId, 'the key is not the order id');
  } finally { await rt.close(); }
});

test('S173 as amended: a lapsed attempt is re-issued under a new order id with the same idempotency_key', async () => {
  const { rt, clock } = await loaded(await build());
  try {
    await start(rt, 'key-retry');
    await rt.tick();
    const [first] = await rt.workOrders('key-retry');
    clock.advance(120_000 + 1); // past the effect's declared timeout (2m)
    await rt.tick();
    clock.advance(1_000); // the declared backoff
    await rt.tick();
    const [second] = await rt.workOrders('key-retry');
    assert.equal(second?.attempt, 2, JSON.stringify(second));
    assert.notEqual(second.orderId, first.orderId, 'the order id stays per attempt');
    assert.equal(keyOf(first), first.intent, JSON.stringify(first));
    assert.equal(keyOf(second), keyOf(first), 'the key is the same across attempts');
    // The open attempt's order id is still the name a report gives.
    assert.equal((await rt.reportWorkOrder(second.orderId, { ok: true, result: { count: 2 } })).status, 'settled');
  } finally { await rt.close(); }
});

test('S173 as amended, confirmation: a report naming the idempotency key (the intent\'s id) instead of the order id is refused and grants nothing', async () => {
  const { rt } = await loaded(await build());
  try {
    await start(rt, 'key-report');
    await rt.tick();
    const [order] = await rt.workOrders('key-report');
    // The key is the intent's id (PT10); order.intent is that value whether or not the order carries the key yet.
    const r = await rt.reportWorkOrder(order.intent, { ok: true, result: { count: 2 } });
    assert.equal(r.status, 'refused', JSON.stringify(r));
    assert.equal((await state(rt, 'key-report')).briefState, 'gathering', 'nothing settled');
    assert.equal((await rt.workOrders('key-report'))[0]?.orderId, order.orderId, 'the attempt is still open');
    assert.equal((await rt.reportWorkOrder(order.orderId, { ok: true, result: { count: 2 } })).status, 'settled');
  } finally { await rt.close(); }
});

test('S173 as amended, S174: the order an agent sees over poly run --mcp includes idempotency_key, the intent\'s id', async () => {
  const a = await build();
  const dir = mkdtempSync(join(tmpdir(), 'poly-order-key-'));
  const trust = join(dir, 'admission.pub.pem');
  writeFileSync(trust, a.trust[a.key.id]);
  const c = mcpClient(process.execPath, [...ACCEPT_TEST_ANCHORS, SERVER, a.build, a.certificate, a.key.id, trust, join(dir, 'store.sqlite')], { cwd: dir });
  try {
    await c.initialize();
    const v = await c.call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-10-05' } });
    const [o] = v.next;
    assert.ok(o, JSON.stringify(v));
    assert.equal(typeof o.idempotency_key, 'string', JSON.stringify(o));
    assert.notEqual(o.idempotency_key, o.order_id);
    // The order id is derived from the intent and the attempt (`<intent>#<attempt>`, as workflow-runtime.test.mjs reads it).
    assert.equal(o.idempotency_key, o.order_id.slice(0, o.order_id.lastIndexOf('#')));
    // A report naming the key is refused; the order id still settles it.
    const byKey = await c.call('workflow_report', { order_id: o.idempotency_key, ok: true, result: { count: 2 } });
    assert.ok(byKey.error, JSON.stringify(byKey));
    const ok = await c.call('workflow_report', { order_id: o.order_id, ok: true, result: { count: 2 } });
    assert.equal(ok.error, undefined, JSON.stringify(ok));
  } finally { await c.close(); rmSync(dir, { recursive: true, force: true }); }
});
