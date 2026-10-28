// Subscription-cancel end-to-end test over recorded traffic.
// Tests the machine through its handlers and recorded services with no network calls.
// Rule 7a: Written from spec alone. Finding 31 (v1.4 amendment): completions are never
// dispatched by hand; the recorded services' statuses run through the runtime's effects logic.
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
const admitted = () => (cachedAdmission ??= admitExample('subscription-cancel'));

const EX_DIR = join(ROOT, 'examples', 'subscription-cancel');

test('subscription-cancel: admission checks the program and policy; the example admits', { timeout: 60_000 }, async () => {
  const a = await admitted();
  assert.ok(a.dir);
  assert.ok(a.report);
  assert.equal(a.report.verdict, 'CLEAN', JSON.stringify(a.report.diagnostics));
});

test('subscription-cancel: main path - Request, offer sent, Decline, cancel sent, Cancelled with one request to each URL', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://marketing.example/v1/offers': 201,
    'https://billing.example/v1/subscriptions/cancel': 201,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    // Set up handlers.
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('retention.offer', handlers.offer);
    rt.handle('billing.cancel', handlers.cancel);

    // Create a subscription.
    const sub = await rt.create('subscription.Subscription', { id: 'sub-main-1' });
    const subId = sub.id;

    // Request to cancel.
    await rt.dispatch(subId, 'Request', {});
    await settle(rt);

    // Should be Offering and have sent an offer.
    let state = (await rt.getState(subId)).state;
    assert.equal(state.status, 'Offered', 'the offer was sent in the same settle, so the subscription waits Offered');
    const offers = sent.filter((s) => s.url === 'https://marketing.example/v1/offers');
    assert.equal(offers.length, 1, 'one offer POST sent');

    // Decline the offer.
    await rt.dispatch(subId, 'Decline', {});
    await settle(rt);

    state = (await rt.getState(subId)).state;
    assert.equal(state.status, 'Cancelled', 'status should be Cancelled after Decline');

    // Check requests: one offer, one cancel with a key.
    const cancels = sent.filter((s) => s.url === 'https://billing.example/v1/subscriptions/cancel');
    assert.equal(offers.length, 1, 'one offer request total');
    assert.equal(cancels.length, 1, 'one cancel request total');
    const cancelKey = cancels[0].headers['idempotency-key'];
    assert.ok(cancelKey && typeof cancelKey === 'string' && cancelKey.length > 0, 'the cancellation is sent with a non-empty idempotency key');
  } finally {
    await rt.close();
  }
});

test('subscription-cancel: keep - Request, offer sent, Keep, Retained with no cancel request', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://marketing.example/v1/offers': 201,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('retention.offer', handlers.offer);
    rt.handle('billing.cancel', handlers.cancel);

    const sub = await rt.create('subscription.Subscription', { id: 'sub-keep-1' });
    const subId = sub.id;

    // Request to cancel.
    await rt.dispatch(subId, 'Request', {});
    await settle(rt);

    let state = (await rt.getState(subId)).state;
    assert.equal(state.status, 'Offered');
    const offers = sent.filter((s) => s.url === 'https://marketing.example/v1/offers');
    assert.equal(offers.length, 1, 'one offer sent');

    // Keep the subscription.
    await rt.dispatch(subId, 'Keep', {});
    await settle(rt);

    state = (await rt.getState(subId)).state;
    assert.equal(state.status, 'Retained', 'status should be Retained after Keep');

    // Check requests: one offer, no cancel.
    const cancels = sent.filter((s) => s.url === 'https://billing.example/v1/subscriptions/cancel');
    assert.equal(cancels.length, 0, 'no cancel request when Keep is chosen');
  } finally {
    await rt.close();
  }
});

test('subscription-cancel: lapse - Request, offer sent, no reply, advance 168 hours, cancel sent, Cancelled', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://marketing.example/v1/offers': 201,
    'https://billing.example/v1/subscriptions/cancel': 201,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('retention.offer', handlers.offer);
    rt.handle('billing.cancel', handlers.cancel);

    const sub = await rt.create('subscription.Subscription', { id: 'sub-lapse-1' });
    const subId = sub.id;

    // Request to cancel.
    await rt.dispatch(subId, 'Request', {});
    await settle(rt);

    let state = (await rt.getState(subId)).state;
    assert.equal(state.status, 'Offered');
    const offersInitial = sent.filter((s) => s.url === 'https://marketing.example/v1/offers');
    assert.equal(offersInitial.length, 1, 'one offer sent');

    // Advance 168 hours (the lapse timer).
    clock.advance(168 * 60 * 60 * 1000);
    await settle(rt);

    state = (await rt.getState(subId)).state;
    assert.equal(state.status, 'Cancelled', 'status should be Cancelled after lapse');

    // Check requests: one offer, one cancel.
    const offers = sent.filter((s) => s.url === 'https://marketing.example/v1/offers');
    const cancels = sent.filter((s) => s.url === 'https://billing.example/v1/subscriptions/cancel');
    assert.equal(offers.length, 1, 'one offer request total');
    assert.equal(cancels.length, 1, 'one cancel request after lapse');
  } finally {
    await rt.close();
  }
});

test('subscription-cancel: refusal - second Request on Offered is rejected "not-active", Keep on Active is rejected "not-offered"', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://marketing.example/v1/offers': 201,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('retention.offer', handlers.offer);
    rt.handle('billing.cancel', handlers.cancel);

    const sub = await rt.create('subscription.Subscription', { id: 'sub-refusal-1' });
    const subId = sub.id;

    // Request to cancel.
    await rt.dispatch(subId, 'Request', {});
    await settle(rt);

    let state = (await rt.getState(subId)).state;
    assert.equal(state.status, 'Offered', 'Request and settle bring the subscription to Offered');

    // Try another Request on Offered: should be rejected "not-active".
    const requestResult = await rt.dispatch(subId, 'Request', {});
    await settle(rt);
    assert.equal(requestResult.stepKind, 'rejected', 'second Request should be rejected');
    assert.equal(requestResult.rejectReason, 'not-active', 'reason is not-active');

    // Try Keep on a fresh Active subscription: should be rejected "not-offered".
    const sub2 = await rt.create('subscription.Subscription', { id: 'sub-refusal-2' });
    const sub2Id = sub2.id;
    const keepResult = await rt.dispatch(sub2Id, 'Keep', {});
    await settle(rt);
    assert.equal(keepResult.stepKind, 'rejected', 'Keep on Active should be rejected');
    assert.equal(keepResult.rejectReason, 'not-offered', 'reason is not-offered');
  } finally {
    await rt.close();
  }
});

test('subscription-cancel: failed offer (422) still cancels with no second offer', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://marketing.example/v1/offers': 422,
    'https://billing.example/v1/subscriptions/cancel': 201,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('retention.offer', handlers.offer);
    rt.handle('billing.cancel', handlers.cancel);

    const sub = await rt.create('subscription.Subscription', { id: 'sub-failed-offer-1' });
    const subId = sub.id;

    // Request to cancel.
    await rt.dispatch(subId, 'Request', {});
    await settle(rt);

    // The marketing service refuses the offer for good (422), so the runtime delivers the failure itself: no test dispatches a
    // completion. The subscriber is not blocked by it: the cancellation goes ahead in the same settle (corrected by the
    // implementer after the code existed; the writer dispatched OfferFailed by hand).
    const state = (await rt.getState(subId)).state;
    assert.equal(state.status, 'Cancelled', 'a failed offer does not block the cancellation');
    assert.equal(state.offers, 1, 'the one offer was attempted');

    // Check requests: one offer attempt (422), one cancel.
    const offers = sent.filter((s) => s.url === 'https://marketing.example/v1/offers');
    const cancels = sent.filter((s) => s.url === 'https://billing.example/v1/subscriptions/cancel');
    assert.equal(offers.length, 1, 'one offer attempt (not retried)');
    assert.equal(cancels.length, 1, 'one cancel sent');
  } finally {
    await rt.close();
  }
});

test('subscription-cancel: one attempt, unknown cancellation - 503 then 201 sends exactly one request, ends CancelUnknown, Resolve(done:true) ends Cancelled', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://marketing.example/v1/offers': 201,
    // Corrected after the code existed: the script answers by call count across the runtime, so the second subscription's
    // one request is the second call; both get 503, and the 201 after them is never asked for.
    'https://billing.example/v1/subscriptions/cancel': [503, 503, 201],
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('retention.offer', handlers.offer);
    rt.handle('billing.cancel', handlers.cancel);

    // First subscription: reaches CancelUnknown and resolves done: true.
    const sub1 = await rt.create('subscription.Subscription', { id: 'sub-cancel-unknown-1' });
    const sub1Id = sub1.id;

    await rt.dispatch(sub1Id, 'Request', {});
    await settle(rt);
    await rt.dispatch(sub1Id, 'Decline', {});
    await settle(rt);

    // Cancel attempt fails with 503 (one attempt only).
    // After settle with 503, advance clock past the 10s timeout to ensure the effect is exhausted.
    clock.advance(60_000);
    await settle(rt);

    // Should be in CancelUnknown state.
    let state = (await rt.getState(sub1Id)).state;
    assert.equal(state.status, 'CancelUnknown', 'status should be CancelUnknown after exhausted cancel');

    // Verify exactly one request to billing (no retry despite 503).
    const sub1Cancels = sent.filter((s) => s.url === 'https://billing.example/v1/subscriptions/cancel' && s.body.subscription === sub1Id);
    assert.equal(sub1Cancels.length, 1, 'exactly one cancel request to billing (one attempt, not retried)');

    // Resolve with done: true, moving to Cancelled.
    await rt.dispatch(sub1Id, 'Resolve', { done: true });
    await settle(rt);

    state = (await rt.getState(sub1Id)).state;
    assert.equal(state.status, 'Cancelled', 'Resolve(done: true) from CancelUnknown ends Cancelled');

    // Verify no second request to billing.
    const sub1CancelsAfter = sent.filter((s) => s.url === 'https://billing.example/v1/subscriptions/cancel' && s.body.subscription === sub1Id);
    assert.equal(sub1CancelsAfter.length, 1, 'no second request to billing after Resolve');

    // Second subscription: reaches CancelUnknown and resolves done: false.
    const sub2 = await rt.create('subscription.Subscription', { id: 'sub-cancel-unknown-2' });
    const sub2Id = sub2.id;

    await rt.dispatch(sub2Id, 'Request', {});
    await settle(rt);
    await rt.dispatch(sub2Id, 'Decline', {});
    await settle(rt);

    clock.advance(60_000);
    await settle(rt);

    state = (await rt.getState(sub2Id)).state;
    assert.equal(state.status, 'CancelUnknown', 'sub2 reaches CancelUnknown');

    // Resolve with done: false, moving to Stuck.
    await rt.dispatch(sub2Id, 'Resolve', { done: false });
    await settle(rt);

    state = (await rt.getState(sub2Id)).state;
    assert.equal(state.status, 'Stuck', 'Resolve(done: false) from CancelUnknown ends Stuck');

    // Third subscription: Offered, attempt Resolve on wrong state.
    const sub3 = await rt.create('subscription.Subscription', { id: 'sub-cancel-unknown-3' });
    const sub3Id = sub3.id;

    await rt.dispatch(sub3Id, 'Request', {});
    await settle(rt);

    state = (await rt.getState(sub3Id)).state;
    assert.equal(state.status, 'Offered', 'sub3 is Offered');

    // Try Resolve on Offered: should be rejected "not-unknown".
    const resolveResult = await rt.dispatch(sub3Id, 'Resolve', { done: true });
    await settle(rt);
    assert.equal(resolveResult.stepKind, 'rejected', 'Resolve on Offered should be rejected');
    assert.equal(resolveResult.rejectReason, 'not-unknown', 'reason is not-unknown');
  } finally {
    await rt.close();
  }
});

test('subscription-cancel: one attempt, unknown offer - 503 then 201 sends exactly one request to marketing, ends OfferUnknown, Resolve(done:true) arms lapse and cancels', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    // Corrected after the code existed, as above: both subscriptions' one offer request gets 503.
    'https://marketing.example/v1/offers': [503, 503, 201],
    'https://billing.example/v1/subscriptions/cancel': 201,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('retention.offer', handlers.offer);
    rt.handle('billing.cancel', handlers.cancel);

    // First subscription: reaches OfferUnknown and resolves done: true.
    const sub1 = await rt.create('subscription.Subscription', { id: 'sub-offer-unknown-1' });
    const sub1Id = sub1.id;

    await rt.dispatch(sub1Id, 'Request', {});
    await settle(rt);

    // Offer attempt fails with 503 (one attempt only).
    clock.advance(60_000);
    await settle(rt);

    // Should be in OfferUnknown state with no request to billing.
    let state = (await rt.getState(sub1Id)).state;
    assert.equal(state.status, 'OfferUnknown', 'status should be OfferUnknown after exhausted offer');

    // Verify exactly one request to marketing (no retry).
    const sub1Offers = sent.filter((s) => s.url === 'https://marketing.example/v1/offers' && s.body.subscription === sub1Id);
    assert.equal(sub1Offers.length, 1, 'exactly one offer request to marketing (one attempt)');

    // Verify no request to billing yet.
    const sub1Cancels = sent.filter((s) => s.url === 'https://billing.example/v1/subscriptions/cancel' && s.body.subscription === sub1Id);
    assert.equal(sub1Cancels.length, 0, 'no request to billing while offer is unknown');

    // Resolve with done: true, moving to Offered (with lapse timer armed).
    await rt.dispatch(sub1Id, 'Resolve', { done: true });
    await settle(rt);

    state = (await rt.getState(sub1Id)).state;
    assert.equal(state.status, 'Offered', 'Resolve(done: true) from OfferUnknown moves to Offered');

    // Advance 168 hours for the lapse timer to fire.
    clock.advance(168 * 60 * 60 * 1000);
    await settle(rt);

    state = (await rt.getState(sub1Id)).state;
    assert.equal(state.status, 'Cancelled', 'lapse timer fires and subscription is Cancelled');

    // Now should have one request to billing.
    const sub1CancelsAfter = sent.filter((s) => s.url === 'https://billing.example/v1/subscriptions/cancel' && s.body.subscription === sub1Id);
    assert.equal(sub1CancelsAfter.length, 1, 'one cancel request to billing after lapse');

    // Still only one offer request.
    const sub1OffersAfter = sent.filter((s) => s.url === 'https://marketing.example/v1/offers' && s.body.subscription === sub1Id);
    assert.equal(sub1OffersAfter.length, 1, 'still one offer request total');

    // Second subscription: reaches OfferUnknown and resolves done: false.
    const sub2 = await rt.create('subscription.Subscription', { id: 'sub-offer-unknown-2' });
    const sub2Id = sub2.id;

    await rt.dispatch(sub2Id, 'Request', {});
    await settle(rt);

    clock.advance(60_000);
    await settle(rt);

    state = (await rt.getState(sub2Id)).state;
    assert.equal(state.status, 'OfferUnknown', 'sub2 reaches OfferUnknown');

    // Resolve with done: false, moving to Cancelling (and emitting cancel).
    await rt.dispatch(sub2Id, 'Resolve', { done: false });
    await settle(rt);

    state = (await rt.getState(sub2Id)).state;
    assert.equal(state.status, 'Cancelled', 'Resolve(done: false) from OfferUnknown cancels at once');

    // Should have exactly one request to billing for sub2.
    const sub2Cancels = sent.filter((s) => s.url === 'https://billing.example/v1/subscriptions/cancel' && s.body.subscription === sub2Id);
    assert.equal(sub2Cancels.length, 1, 'one cancel request to billing for sub2');

    // Should have no second offer for sub2.
    const sub2Offers = sent.filter((s) => s.url === 'https://marketing.example/v1/offers' && s.body.subscription === sub2Id);
    assert.equal(sub2Offers.length, 1, 'one offer attempt, not retried');
  } finally {
    await rt.close();
  }
});

test('subscription-cancel: two subscriptions send different idempotency-key values', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://marketing.example/v1/offers': 201,
    'https://billing.example/v1/subscriptions/cancel': 201,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('retention.offer', handlers.offer);
    rt.handle('billing.cancel', handlers.cancel);

    // First subscription.
    const sub1 = await rt.create('subscription.Subscription', { id: 'sub-keys-1' });
    const sub1Id = sub1.id;

    await rt.dispatch(sub1Id, 'Request', {});
    await settle(rt);
    await rt.dispatch(sub1Id, 'Decline', {});
    await settle(rt);

    // Second subscription.
    const sub2 = await rt.create('subscription.Subscription', { id: 'sub-keys-2' });
    const sub2Id = sub2.id;

    await rt.dispatch(sub2Id, 'Request', {});
    await settle(rt);
    await rt.dispatch(sub2Id, 'Decline', {});
    await settle(rt);

    // Get cancel requests for each.
    const sub1Cancels = sent.filter((s) => s.url === 'https://billing.example/v1/subscriptions/cancel' && s.body.subscription === sub1Id);
    const sub2Cancels = sent.filter((s) => s.url === 'https://billing.example/v1/subscriptions/cancel' && s.body.subscription === sub2Id);

    assert.equal(sub1Cancels.length, 1, 'subscription 1 has exactly one cancel request');
    assert.equal(sub2Cancels.length, 1, 'subscription 2 has exactly one cancel request');

    const key1 = sub1Cancels[0].headers['idempotency-key'];
    const key2 = sub2Cancels[0].headers['idempotency-key'];

    assert.ok(key1 && typeof key1 === 'string' && key1.length > 0, 'subscription 1 key is a non-empty string');
    assert.ok(key2 && typeof key2 === 'string' && key2.length > 0, 'subscription 2 key is a non-empty string');
    assert.notEqual(key1, key2, 'different subscriptions have different idempotency keys');
  } finally {
    await rt.close();
  }
});

test('subscription-cancel: escalation - cancel refused (422) ends Stuck', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://marketing.example/v1/offers': 201,
    'https://billing.example/v1/subscriptions/cancel': 422,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('retention.offer', handlers.offer);
    rt.handle('billing.cancel', handlers.cancel);

    const sub = await rt.create('subscription.Subscription', { id: 'sub-stuck-1' });
    const subId = sub.id;

    // Request and decline.
    await rt.dispatch(subId, 'Request', {});
    await settle(rt);
    await rt.dispatch(subId, 'Decline', {});
    await settle(rt);

    // Cancel is sent and fails with 422 (permanent), ending in Stuck.
    await settle(rt);

    let state = (await rt.getState(subId)).state;
    assert.equal(state.status, 'Stuck', 'status should be Stuck after cancel failed with 422');

    // Check requests: one offer, one cancel (no retry for 422).
    const offers = sent.filter((s) => s.url === 'https://marketing.example/v1/offers');
    const cancels = sent.filter((s) => s.url === 'https://billing.example/v1/subscriptions/cancel');
    assert.equal(offers.length, 1, 'one offer request');
    assert.equal(cancels.length, 1, 'one cancel request (no retry for permanent error)');
  } finally {
    await rt.close();
  }
});

test('subscription-cancel: journal replays with no divergence', { timeout: 120_000 }, async () => {
  const { recordedServices } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);

  const a = await admitted();
  const script = {
    'https://marketing.example/v1/offers': 201,
    'https://billing.example/v1/subscriptions/cancel': 201,
  };
  const { sent, transports } = recordedServices(script);
  const { rt, clock } = await loadExample(a, { transports });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('retention.offer', handlers.offer);
    rt.handle('billing.cancel', handlers.cancel);

    // Run a simple scenario.
    const sub = await rt.create('subscription.Subscription', { id: 'sub-replay' });
    const subId = sub.id;

    await rt.dispatch(subId, 'Request', {});
    await settle(rt);
    await rt.dispatch(subId, 'Decline', {});
    await settle(rt);

    // Replay the runtime.
    const replays = await replayRuntime(rt);
    for (const r of replays) {
      assert.deepEqual([r.diagnostics, r.notRun ?? null, r.gateNotRun], [[], null, 0], `divergence in ${r.machine}: ${JSON.stringify(r.diagnostics)}`);
    }

    // Check that subscription.Subscription is among the replayed machines.
    const kinds = new Set(replays.map((x) => x.machine));
    assert.ok(kinds.has('subscription.Subscription'), `subscription.Subscription should be in replayed machines; got ${[...kinds].join(', ')}`);

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
