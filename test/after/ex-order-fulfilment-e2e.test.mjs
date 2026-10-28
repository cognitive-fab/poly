// Order-fulfilment end-to-end test over recorded traffic.
// Tests the machines through handlers and recorded services with no network calls.
// Rule 7a: Written from spec alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayRuntime, replaySessions } from '@poly/check';
import { ROOT } from '../helpers.mjs';
import { loadExample, settle } from '../ex-kit.mjs';
import { admitExample } from '../ex-kit.mjs';

let cachedAdmission;
/** One admission for the whole file: each test loads its own runtime from the same certified build. */
const admitted = () => (cachedAdmission ??= admitExample('order-fulfilment'));

const EX_DIR = join(ROOT, 'examples', 'order-fulfilment');

test('order-fulfilment: admission checks the program and policy; the example admits', { timeout: 60_000 }, async () => {
  const a = await admitted();
  assert.ok(a.dir);
  assert.ok(a.report);
  assert.equal(a.report.verdict, 'CLEAN', JSON.stringify(a.report.diagnostics));
});

test('order-fulfilment: main path - Place, Reserve, Charge, Ship to Done with no refund', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://payments.example/v1/charges': 201,
    'https://carrier.example/v1/shipments': 201,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    // Set up handlers.
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payments.charge', handlers.charge);
    rt.handle('carrier.ship', handlers.ship);
    rt.handle('payments.refund', handlers.refund);

    // Create stock (one unit).
    const stock = await rt.create('fulfilment.Stock', { id: 'stock-1' });
    const stockId = stock.id;

    // Create order.
    const order = await rt.create('fulfilment.Order', { id: 'order-1' });
    const orderId = order.id;

    // Place order with stock reference.
    await rt.dispatch(orderId, 'Place', { warehouse: stockId });
    await settle(rt);

    // One settle runs the whole saga: each step completes and the next begins.
    let state;
    let stockState;
    // After ship effect completes, order should be Done.
    state = (await rt.getState(orderId)).state;
    assert.equal(state.st, 'Done', 'order is Done after Shipped');
    assert.equal(state.charged, true, 'order remains charged');
    assert.equal(state.held, 1, 'order still held (no release on success)');
    stockState = (await rt.getState(stockId)).state;
    assert.equal(stockState.onHand, 0, 'the stock stays reserved for a shipped order');

    // Check requests: one charge, one ship, no refund.
    const chargeReqs = sent.filter((s) => s.url === 'https://payments.example/v1/charges');
    const shipReqs = sent.filter((s) => s.url === 'https://carrier.example/v1/shipments');
    const refundReqs = sent.filter((s) => s.url === 'https://payments.example/v1/refunds');
    assert.equal(chargeReqs.length, 1, 'one charge request');
    assert.equal(shipReqs.length, 1, 'one ship request');
    assert.equal(refundReqs.length, 0, 'no refund request');
  } finally {
    await rt.close();
  }
});

test('order-fulfilment: refusal - out of stock ends in Rejected with no requests', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {};
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payments.charge', handlers.charge);
    rt.handle('carrier.ship', handlers.ship);
    rt.handle('payments.refund', handlers.refund);

    // Create stock (one unit).
    const stock = await rt.create('fulfilment.Stock', { id: 'stock-2' });
    const stockId = stock.id;

    // Create two orders.
    const order1 = await rt.create('fulfilment.Order', { id: 'order-2a' });
    const orderId1 = order1.id;
    const order2 = await rt.create('fulfilment.Order', { id: 'order-2b' });
    const orderId2 = order2.id;

    // First order places and completes.
    await rt.dispatch(orderId1, 'Place', { warehouse: stockId });
    await settle(rt);
    // Run through charge and ship.
    await settle(rt);
    await settle(rt);

    let state1 = (await rt.getState(orderId1)).state;
    assert.equal(state1.st, 'Done', 'first order is Done');

    // Second order places but runs out of stock.
    await rt.dispatch(orderId2, 'Place', { warehouse: stockId });
    await settle(rt);

    let state2 = (await rt.getState(orderId2)).state;
    assert.equal(state2.st, 'Rejected', 'second order is Rejected (out of stock)');

    // Check requests: first order had one charge and one ship, second order had no requests.
    const chargeReqs = sent.filter((s) => s.url === 'https://payments.example/v1/charges');
    const shipReqs = sent.filter((s) => s.url === 'https://carrier.example/v1/shipments');
    const refundReqs = sent.filter((s) => s.url === 'https://payments.example/v1/refunds');
    assert.equal(chargeReqs.length, 1, 'only first order charged');
    assert.equal(shipReqs.length, 1, 'only first order shipped');
    assert.equal(refundReqs.length, 0, 'no refunds');
  } finally {
    await rt.close();
  }
});

test('order-fulfilment: charge failure (402) cancels with no ship, no refund', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://payments.example/v1/charges': 402,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payments.charge', handlers.charge);
    rt.handle('carrier.ship', handlers.ship);
    rt.handle('payments.refund', handlers.refund);

    // Create stock.
    const stock = await rt.create('fulfilment.Stock', { id: 'stock-3' });
    const stockId = stock.id;

    // Create order.
    const order = await rt.create('fulfilment.Order', { id: 'order-3' });
    const orderId = order.id;

    // Place order.
    await rt.dispatch(orderId, 'Place', { warehouse: stockId });
    await settle(rt);

    // Charge should fail with 402 (permanent), going to Cancelled.
    await settle(rt);

    let state = (await rt.getState(orderId)).state;
    assert.equal(state.st, 'Cancelled', 'order is Cancelled after charge failure');
    assert.equal(state.held, 0, 'held is cleared');
    assert.equal(state.charged, false, 'charged is false');

    // Stock should be back to 1.
    let stockState = (await rt.getState(stockId)).state;
    assert.equal(stockState.onHand, 1, 'stock is released');

    // Check requests: one charge, no ship, no refund.
    const chargeReqs = sent.filter((s) => s.url === 'https://payments.example/v1/charges');
    const shipReqs = sent.filter((s) => s.url === 'https://carrier.example/v1/shipments');
    const refundReqs = sent.filter((s) => s.url === 'https://payments.example/v1/refunds');
    assert.equal(chargeReqs.length, 1, 'one charge attempt (no retry for 402)');
    assert.equal(shipReqs.length, 0, 'no ship');
    assert.equal(refundReqs.length, 0, 'no refund');
  } finally {
    await rt.close();
  }
});

test('order-fulfilment: compensation - shipment refused (402), triggers refund', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://payments.example/v1/charges': 201,
    'https://carrier.example/v1/shipments': 402,
    'https://payments.example/v1/refunds': 201,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payments.charge', handlers.charge);
    rt.handle('carrier.ship', handlers.ship);
    rt.handle('payments.refund', handlers.refund);

    // Create stock (PS23.4: one attempt means the carrier refuses with 402).
    const stock = await rt.create('fulfilment.Stock', { id: 'stock-4' });
    const stockId = stock.id;

    // Create order.
    const order = await rt.create('fulfilment.Order', { id: 'order-4' });
    const orderId = order.id;

    // Place order.
    await rt.dispatch(orderId, 'Place', { warehouse: stockId });
    await settle(rt);

    // Charge succeeds, ship is refused with 402, triggering ShipFailed and compensations.
    await settle(rt);

    let state;

    state = (await rt.getState(orderId)).state;
    assert.equal(state.st, 'Cancelled', 'order is Cancelled after refund succeeds');
    assert.equal(state.held, 0, 'held cleared by ShipFailed');
    assert.equal(state.charged, false, 'charged cleared by Refunded');

    // Stock should be back to 1.
    let stockState = (await rt.getState(stockId)).state;
    assert.equal(stockState.onHand, 1, 'stock is released by ShipFailed compensation');

    // Check requests: one charge, one ship attempt (refused), one refund.
    const chargeReqs = sent.filter((s) => s.url === 'https://payments.example/v1/charges');
    const shipReqs = sent.filter((s) => s.url === 'https://carrier.example/v1/shipments');
    const refundReqs = sent.filter((s) => s.url === 'https://payments.example/v1/refunds');
    assert.equal(chargeReqs.length, 1, 'one charge');
    assert.equal(shipReqs.length, 1, 'one ship attempt (no retry, PS23.4)');
    assert.equal(refundReqs.length, 1, 'one refund');
  } finally {
    await rt.close();
  }
});

test('order-fulfilment: one attempt, unknown shipment: sent 500, ends ShipUnknown with Resolve(done: true) -> Done', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://payments.example/v1/charges': 201,
    'https://carrier.example/v1/shipments': 500,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payments.charge', handlers.charge);
    rt.handle('carrier.ship', handlers.ship);
    rt.handle('payments.refund', handlers.refund);

    // Create stock (PS23.4: one attempt, exhausted 500 becomes ShipUncertain).
    const stock = await rt.create('fulfilment.Stock', { id: 'stock-5' });
    const stockId = stock.id;

    // Create order.
    const order = await rt.create('fulfilment.Order', { id: 'order-5' });
    const orderId = order.id;

    // Place order.
    await rt.dispatch(orderId, 'Place', { warehouse: stockId });
    await settle(rt);

    // Charge succeeds, ship gets 500 (transient error, exhausted = ShipUncertain).
    await settle(rt);

    let state = (await rt.getState(orderId)).state;
    assert.equal(state.st, 'ShipUnknown', 'order is ShipUnknown after exhausted shipment');
    assert.equal(state.held, 1, 'held still 1 (not released yet)');
    assert.equal(state.charged, true, 'charged still true');

    // Stock should still be 0.
    let stockState = (await rt.getState(stockId)).state;
    assert.equal(stockState.onHand, 0, 'stock still reserved');

    // Resolve with done: true.
    const resolveResult = await rt.dispatch(orderId, 'Resolve', { done: true });
    assert.equal(resolveResult.stepKind, 'accepted', 'Resolve(done: true) is accepted');
    await settle(rt);

    state = (await rt.getState(orderId)).state;
    assert.equal(state.st, 'Done', 'order is Done after Resolve(done: true)');
    assert.equal(state.held, 1, 'held still 1 (Resolve does not release)');
    assert.equal(state.charged, true, 'charged still true');

    // Check requests: one charge, one ship (no refund because Resolve done).
    const chargeReqs = sent.filter((s) => s.url === 'https://payments.example/v1/charges');
    const shipReqs = sent.filter((s) => s.url === 'https://carrier.example/v1/shipments');
    const refundReqs = sent.filter((s) => s.url === 'https://payments.example/v1/refunds');
    assert.equal(chargeReqs.length, 1, 'one charge');
    assert.equal(shipReqs.length, 1, 'one ship attempt');
    assert.equal(refundReqs.length, 0, 'no refund on Resolve(done: true)');
  } finally {
    await rt.close();
  }
});

test('order-fulfilment: one attempt, unknown shipment: Resolve(done: false) runs compensations', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://payments.example/v1/charges': 201,
    'https://carrier.example/v1/shipments': 500,
    'https://payments.example/v1/refunds': 201,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payments.charge', handlers.charge);
    rt.handle('carrier.ship', handlers.ship);
    rt.handle('payments.refund', handlers.refund);

    // Create stock.
    const stock = await rt.create('fulfilment.Stock', { id: 'stock-5b' });
    const stockId = stock.id;

    // Create order.
    const order = await rt.create('fulfilment.Order', { id: 'order-5b' });
    const orderId = order.id;

    // Place order.
    await rt.dispatch(orderId, 'Place', { warehouse: stockId });
    await settle(rt);

    // Charge succeeds, ship gets 500 (exhausted = ShipUncertain).
    await settle(rt);

    let state = (await rt.getState(orderId)).state;
    assert.equal(state.st, 'ShipUnknown', 'order is ShipUnknown');

    // Resolve with done: false, which runs compensations.
    const resolveResult = await rt.dispatch(orderId, 'Resolve', { done: false });
    assert.equal(resolveResult.stepKind, 'accepted', 'Resolve(done: false) is accepted');
    await settle(rt);

    state = (await rt.getState(orderId)).state;
    assert.equal(state.st, 'Cancelled', 'order is Cancelled after Resolve(done: false) completes compensation');
    assert.equal(state.held, 0, 'held cleared by compensation');
    assert.equal(state.charged, false, 'charged cleared by refund');

    // Stock should be back to 1.
    let stockState = (await rt.getState(stockId)).state;
    assert.equal(stockState.onHand, 1, 'stock released by compensation');

    // Check requests: one charge, one ship, one refund (from compensation).
    const chargeReqs = sent.filter((s) => s.url === 'https://payments.example/v1/charges');
    const shipReqs = sent.filter((s) => s.url === 'https://carrier.example/v1/shipments');
    const refundReqs = sent.filter((s) => s.url === 'https://payments.example/v1/refunds');
    assert.equal(chargeReqs.length, 1, 'one charge');
    assert.equal(shipReqs.length, 1, 'one ship attempt');
    assert.equal(refundReqs.length, 1, 'one refund (from Resolve(done: false) compensation)');
  } finally {
    await rt.close();
  }
});

test('order-fulfilment: one attempt, refund refused (402), ends Stuck (still charged)', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://payments.example/v1/charges': 201,
    'https://carrier.example/v1/shipments': 402,
    'https://payments.example/v1/refunds': 402,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payments.charge', handlers.charge);
    rt.handle('carrier.ship', handlers.ship);
    rt.handle('payments.refund', handlers.refund);

    // Create stock.
    const stock = await rt.create('fulfilment.Stock', { id: 'stock-6' });
    const stockId = stock.id;

    // Create order.
    const order = await rt.create('fulfilment.Order', { id: 'order-6' });
    const orderId = order.id;

    // Place order.
    await rt.dispatch(orderId, 'Place', { warehouse: stockId });
    await settle(rt);

    // Charge succeeds, ship is refused (402), triggers RefundFailed because refund also refused.
    await settle(rt);

    let state = (await rt.getState(orderId)).state;
    assert.equal(state.st, 'Stuck', 'order is Stuck after refund refused (402)');
    assert.equal(state.charged, true, 'charged still true (refund failed)');

    // Check requests: one charge, one ship (refused), one refund attempt (refused).
    const chargeReqs = sent.filter((s) => s.url === 'https://payments.example/v1/charges');
    const shipReqs = sent.filter((s) => s.url === 'https://carrier.example/v1/shipments');
    const refundReqs = sent.filter((s) => s.url === 'https://payments.example/v1/refunds');
    assert.equal(chargeReqs.length, 1, 'one charge');
    assert.equal(shipReqs.length, 1, 'one ship (refused)');
    assert.equal(refundReqs.length, 1, 'one refund attempt (refused with 402, no retry)');
  } finally {
    await rt.close();
  }
});

test('order-fulfilment: one attempt, unknown refund: sent 500, ends RefundUnknown with Resolve(done: true) -> Cancelled', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://payments.example/v1/charges': 201,
    'https://carrier.example/v1/shipments': 402,
    'https://payments.example/v1/refunds': 500,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payments.charge', handlers.charge);
    rt.handle('carrier.ship', handlers.ship);
    rt.handle('payments.refund', handlers.refund);

    // Create stock.
    const stock = await rt.create('fulfilment.Stock', { id: 'stock-7' });
    const stockId = stock.id;

    // Create order.
    const order = await rt.create('fulfilment.Order', { id: 'order-7' });
    const orderId = order.id;

    // Place order.
    await rt.dispatch(orderId, 'Place', { warehouse: stockId });
    await settle(rt);

    // Charge succeeds, ship is refused (402), refund gets 500 (exhausted = RefundUncertain).
    await settle(rt);

    let state = (await rt.getState(orderId)).state;
    assert.equal(state.st, 'RefundUnknown', 'order is RefundUnknown after exhausted refund');
    assert.equal(state.charged, true, 'charged still true (refund uncertain)');

    // Resolve with done: true (assume refund succeeded).
    const resolveResult = await rt.dispatch(orderId, 'Resolve', { done: true });
    assert.equal(resolveResult.stepKind, 'accepted', 'Resolve(done: true) is accepted');
    await settle(rt);

    state = (await rt.getState(orderId)).state;
    assert.equal(state.st, 'Cancelled', 'order is Cancelled after Resolve(done: true)');
    assert.equal(state.charged, false, 'charged cleared by Resolve(done: true)');

    // Check requests: one charge, one ship (refused), one refund attempt (uncertain).
    const chargeReqs = sent.filter((s) => s.url === 'https://payments.example/v1/charges');
    const shipReqs = sent.filter((s) => s.url === 'https://carrier.example/v1/shipments');
    const refundReqs = sent.filter((s) => s.url === 'https://payments.example/v1/refunds');
    assert.equal(chargeReqs.length, 1, 'one charge');
    assert.equal(shipReqs.length, 1, 'one ship (refused)');
    assert.equal(refundReqs.length, 1, 'one refund attempt (exhausted with 500)');
  } finally {
    await rt.close();
  }
});

test('order-fulfilment: one attempt, unknown refund: Resolve(done: false) ends Stuck', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://payments.example/v1/charges': 201,
    'https://carrier.example/v1/shipments': 402,
    'https://payments.example/v1/refunds': 500,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payments.charge', handlers.charge);
    rt.handle('carrier.ship', handlers.ship);
    rt.handle('payments.refund', handlers.refund);

    // Create stock.
    const stock = await rt.create('fulfilment.Stock', { id: 'stock-7b' });
    const stockId = stock.id;

    // Create order.
    const order = await rt.create('fulfilment.Order', { id: 'order-7b' });
    const orderId = order.id;

    // Place order.
    await rt.dispatch(orderId, 'Place', { warehouse: stockId });
    await settle(rt);

    // Charge succeeds, ship is refused (402), refund gets 500 (exhausted = RefundUncertain).
    await settle(rt);

    let state = (await rt.getState(orderId)).state;
    assert.equal(state.st, 'RefundUnknown', 'order is RefundUnknown');

    // Resolve with done: false (assume refund did not happen).
    const resolveResult = await rt.dispatch(orderId, 'Resolve', { done: false });
    assert.equal(resolveResult.stepKind, 'accepted', 'Resolve(done: false) is accepted');
    await settle(rt);

    state = (await rt.getState(orderId)).state;
    assert.equal(state.st, 'Stuck', 'order is Stuck after Resolve(done: false)');
    assert.equal(state.charged, true, 'charged still true (refund presumed not sent)');

    // Check requests: one charge, one ship (refused), one refund attempt.
    const chargeReqs = sent.filter((s) => s.url === 'https://payments.example/v1/charges');
    const shipReqs = sent.filter((s) => s.url === 'https://carrier.example/v1/shipments');
    const refundReqs = sent.filter((s) => s.url === 'https://payments.example/v1/refunds');
    assert.equal(chargeReqs.length, 1, 'one charge');
    assert.equal(shipReqs.length, 1, 'one ship (refused)');
    assert.equal(refundReqs.length, 1, 'one refund attempt');
  } finally {
    await rt.close();
  }
});

test('order-fulfilment: Resolve on a non-unknown order is rejected not-unknown', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {};
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payments.charge', handlers.charge);
    rt.handle('carrier.ship', handlers.ship);
    rt.handle('payments.refund', handlers.refund);

    // Create order but do not place it (still in Placed state).
    const order = await rt.create('fulfilment.Order', { id: 'order-8' });
    const orderId = order.id;

    // Attempt Resolve on a Placed order (not in unknown state).
    const result = await rt.dispatch(orderId, 'Resolve', { done: true });

    // The action should be rejected with reason not-unknown.
    assert.equal(result.stepKind, 'rejected', 'the dispatch is rejected');
    assert.equal(result.rejectReason, 'not-unknown', 'the reason is not-unknown');

    // No request should be sent for a rejected action.
    assert.equal(sent.length, 0, 'no request sent on rejected Resolve');

    // Check state: should still be Placed.
    let state = (await rt.getState(orderId)).state;
    assert.equal(state.st, 'Placed', 'order is still Placed after rejected Resolve');
  } finally {
    await rt.close();
  }
});

test('order-fulfilment: keyed - same idempotency key for retried charge; different keys for different orders', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://payments.example/v1/charges': [503, 201],
    // The first order's shipment is refused for good, so its compensation gives the one unit back to the second order.
    'https://carrier.example/v1/shipments': 402,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payments.charge', handlers.charge);
    rt.handle('carrier.ship', handlers.ship);
    rt.handle('payments.refund', handlers.refund);

    // Create stock.
    const stock = await rt.create('fulfilment.Stock', { id: 'stock-6' });
    const stockId = stock.id;

    // Create two orders.
    const order1 = await rt.create('fulfilment.Order', { id: 'order-6a' });
    const orderId1 = order1.id;
    const order2 = await rt.create('fulfilment.Order', { id: 'order-6b' });
    const orderId2 = order2.id;

    // First order: Place and charge (will fail first, then retry and succeed).
    await rt.dispatch(orderId1, 'Place', { warehouse: stockId });
    await settle(rt);

    // First charge attempt fails with 503.
    await settle(rt);

    // Retry after backoff.
    clock.advance(200);
    await settle(rt);

    // Get the two charge requests for order 1 and check they have the same idempotency key.
    const order1Charges = sent.filter((s) => s.url === 'https://payments.example/v1/charges' && s.body.order === orderId1);
    assert.equal(order1Charges.length, 2, 'order 1 has two charge requests (retry)');
    const key1 = order1Charges[0].headers['idempotency-key'];
    const key1Retry = order1Charges[1].headers['idempotency-key'];
    assert.equal(key1, key1Retry, 'same idempotency key for retried charge');

    // Second order: Place (only one charge will be sent because script is exhausted).
    await rt.dispatch(orderId2, 'Place', { warehouse: stockId });
    await settle(rt);
    await settle(rt);

    // Get charge requests for order 2.
    const order2Charges = sent.filter((s) => s.url === 'https://payments.example/v1/charges' && s.body.order === orderId2);
    assert.ok(order2Charges.length > 0, 'order 2 has charge request');
    const key2 = order2Charges[0].headers['idempotency-key'];
    assert.notEqual(key1, key2, 'different orders have different idempotency keys');
  } finally {
    await rt.close();
  }
});

test('order-fulfilment: journal replays with no divergence', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://payments.example/v1/charges': 201,
    'https://carrier.example/v1/shipments': 201,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payments.charge', handlers.charge);
    rt.handle('carrier.ship', handlers.ship);
    rt.handle('payments.refund', handlers.refund);

    // Run a simple scenario.
    const stock = await rt.create('fulfilment.Stock', { id: 'stock-replay' });
    const stockId = stock.id;
    const order = await rt.create('fulfilment.Order', { id: 'order-replay' });
    const orderId = order.id;

    await rt.dispatch(orderId, 'Place', { warehouse: stockId });
    await settle(rt);
    await settle(rt);
    await settle(rt);

    // Replay the runtime.
    const replays = await replayRuntime(rt);
    for (const r of replays) {
      assert.deepEqual([r.diagnostics, r.notRun ?? null, r.gateNotRun], [[], null, 0], `divergence in ${r.machine}: ${JSON.stringify(r.diagnostics)}`);
    }

    // Check that fulfilment.Stock and fulfilment.Order are among the replayed machines.
    const kinds = new Set(replays.map((x) => x.machine));
    assert.ok(kinds.has('fulfilment.Stock'), `fulfilment.Stock should be in replayed machines; got ${[...kinds].join(', ')}`);
    assert.ok(kinds.has('fulfilment.Order'), `fulfilment.Order should be in replayed machines; got ${[...kinds].join(', ')}`);

    // Replay sessions (policies).
    const sessions = await replaySessions(rt);
    assert.ok(sessions.length > 0, 'there are gate sessions to replay (policy gates the effects)');
    for (const s of sessions) {
      assert.deepEqual([s.diagnostics.length, s.notRun.length], [0, 0], `session divergence: ${JSON.stringify(s.diagnostics)}`);
    }

    console.log(`replay: ${replays.length} runs, ${replays.reduce((n, x) => n + x.rows, 0)} rows; ${sessions.length} gate sessions; divergences: ${replays.reduce((n, x) => n + x.diagnostics.length, 0) + sessions.reduce((n, s) => n + s.diagnostics.length, 0)}`);
  } finally {
    await rt.close();
  }
});
