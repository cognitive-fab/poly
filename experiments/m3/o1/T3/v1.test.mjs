// T3 v1: card payments with raised authorisations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { default: createHost } = await import(pathToFileURL(process.env.M3_IMPL).href);

const KIND = 'card.authorize';
const STATUSES = ['authorizing', 'authorized', 'declined', 'failed', 'captured', 'voided', 'refunded'];
const TERMINAL = ['declined', 'failed', 'voided', 'refunded'];

// ---------- helpers ----------

async function effectsOf(h, p) {
  return (await h.pendingEffects()).filter((e) => e.from === p && e.kind === KIND);
}

async function oneEffect(h, p) {
  const es = await effectsOf(h, p);
  assert.equal(es.length, 1);
  return es[0];
}

function project(v) {
  if (v === null) return null;
  return { status: v.status, authorized: v.authorized, captured: v.captured, refunded: v.refunded, requests: v.requests };
}

async function snapshot(h, ids) {
  const views = {};
  for (const id of ids) views[id] = project(await h.payment(id));
  const effects = (await h.pendingEffects())
    .map((e) => [e.id, e.from, e.kind, e.data ? e.data.amount : undefined].join('|'))
    .sort();
  return { views, effects };
}

async function expectRefused(h, ids, fn) {
  const before = await snapshot(h, ids);
  const r = await fn();
  assert.equal(r.ok, false);
  assert.deepEqual(await snapshot(h, ids), before);
}

function ok(r) {
  assert.equal(r.ok, true);
}

function expectView(v, exp) {
  assert.notEqual(v, null);
  for (const k of Object.keys(exp)) assert.equal(v[k], exp[k], `field ${k}`);
}

async function mkAuthorizing(h, p, amount = 1) {
  ok(await h.authorize(p, amount));
}

async function mkAuthorized(h, p, amount = 1) {
  await mkAuthorizing(h, p, amount);
  const e = await oneEffect(h, p);
  await h.completeEffect(e.id, 'ok');
}

async function mkDeclined(h, p, amount = 1) {
  await mkAuthorizing(h, p, amount);
  const e = await oneEffect(h, p);
  await h.completeEffect(e.id, 'failed');
}

async function mkFailed(h, p, amount = 1) {
  await mkAuthorizing(h, p, amount);
  ok(await h.timedOut(p));
  ok(await h.timedOut(p));
  ok(await h.timedOut(p));
}

async function mkCaptured(h, p, auth = 2, cap = auth) {
  await mkAuthorized(h, p, auth);
  ok(await h.capture(p, cap));
}

async function mkVoided(h, p, amount = 1) {
  await mkAuthorized(h, p, amount);
  ok(await h.void(p));
}

async function mkRefunded(h, p, amount = 1) {
  await mkCaptured(h, p, amount, amount);
  ok(await h.refund(p, amount));
}

// ---------- fresh system ----------

test('fresh system has no pending effects', async () => {
  const h = await createHost();
  assert.equal((await h.pendingEffects()).length, 0);
});

test('payment query returns null for an unknown id', async () => {
  const h = await createHost();
  assert.equal(await h.payment('nope'), null);
});

// ---------- authorize ----------

test('authorize 1 unit takes effect and the payment is authorizing', async () => {
  const h = await createHost();
  ok(await h.authorize('p', 1));
  expectView(await h.payment('p'), { status: 'authorizing', authorized: 1, captured: 0, refunded: 0, requests: 1 });
});

test('authorize 2 units takes effect with authorized 2', async () => {
  const h = await createHost();
  ok(await h.authorize('p', 2));
  expectView(await h.payment('p'), { status: 'authorizing', authorized: 2, captured: 0, refunded: 0, requests: 1 });
});

test('authorize sends exactly one card.authorize effect from the payment', async () => {
  const h = await createHost();
  await h.authorize('p', 2);
  const es = await effectsOf(h, 'p');
  assert.equal(es.length, 1);
  assert.equal(es[0].data.amount, 2);
  assert.equal((await h.pendingEffects()).length, 1);
});

test('authorize effect data carries the amount 1', async () => {
  const h = await createHost();
  await h.authorize('p', 1);
  const e = await oneEffect(h, 'p');
  assert.equal(e.data.amount, 1);
});

test('authorize on an authorizing id is refused', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.authorize('p', 1));
});

test('authorize on an existing id with a different amount is refused', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.authorize('p', 2));
});

test('authorize on an authorized id is refused', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.authorize('p', 1));
});

test('authorize on a declined id is refused', async () => {
  const h = await createHost();
  await mkDeclined(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.authorize('p', 1));
});

test('authorize on a failed id is refused', async () => {
  const h = await createHost();
  await mkFailed(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.authorize('p', 1));
});

test('authorize on a captured id is refused', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 2);
  await expectRefused(h, ['p'], () => h.authorize('p', 2));
});

test('authorize on a voided id is refused', async () => {
  const h = await createHost();
  await mkVoided(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.authorize('p', 1));
});

test('authorize on a refunded id is refused', async () => {
  const h = await createHost();
  await mkRefunded(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.authorize('p', 1));
});

test('two payments each get their own authorisation request', async () => {
  const h = await createHost();
  ok(await h.authorize('a', 1));
  ok(await h.authorize('b', 2));
  assert.equal((await oneEffect(h, 'a')).data.amount, 1);
  assert.equal((await oneEffect(h, 'b')).data.amount, 2);
  expectView(await h.payment('a'), { authorized: 1 });
  expectView(await h.payment('b'), { authorized: 2 });
});

// ---------- timedOut ----------

test('timedOut on an unknown payment is refused', async () => {
  const h = await createHost();
  await expectRefused(h, ['x'], () => h.timedOut('x'));
  assert.equal(await h.payment('x'), null);
});

test('first timedOut sends a second request and the payment stays authorizing', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 2);
  ok(await h.timedOut('p'));
  expectView(await h.payment('p'), { status: 'authorizing', requests: 2, authorized: 2 });
  assert.equal((await effectsOf(h, 'p')).length, 2);
});

test('a resent request is a card.authorize effect with the payment amount', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 2);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  const es = (await effectsOf(h, 'p')).filter((e) => e.id !== first.id);
  assert.equal(es.length, 1);
  assert.equal(es[0].data.amount, 2);
});

test('second timedOut sends a third request', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  ok(await h.timedOut('p'));
  ok(await h.timedOut('p'));
  expectView(await h.payment('p'), { status: 'authorizing', requests: 3 });
  assert.equal((await effectsOf(h, 'p')).length, 3);
});

test('third timedOut after 3 requests makes the payment failed', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  ok(await h.timedOut('p'));
  ok(await h.timedOut('p'));
  ok(await h.timedOut('p'));
  expectView(await h.payment('p'), { status: 'failed', requests: 3, authorized: 1, captured: 0, refunded: 0 });
});

test('failing timedOut sends no further request', async () => {
  const h = await createHost();
  await mkFailed(h, 'p', 1);
  assert.equal((await effectsOf(h, 'p')).length, 3);
});

test('earlier requests stay pending after a timedOut', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  const ids = (await effectsOf(h, 'p')).map((e) => e.id);
  assert.ok(ids.includes(first.id));
});

test('timedOut on a failed payment is refused', async () => {
  const h = await createHost();
  await mkFailed(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.timedOut('p'));
});

test('timedOut on an authorized payment is refused', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.timedOut('p'));
});

test('timedOut on a declined payment is refused', async () => {
  const h = await createHost();
  await mkDeclined(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.timedOut('p'));
});

test('timedOut on a captured payment is refused', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 1, 1);
  await expectRefused(h, ['p'], () => h.timedOut('p'));
});

test('timedOut on a voided payment is refused', async () => {
  const h = await createHost();
  await mkVoided(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.timedOut('p'));
});

test('timedOut on a refunded payment is refused', async () => {
  const h = await createHost();
  await mkRefunded(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.timedOut('p'));
});

test('timedOut on one payment does not touch another', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'a', 1);
  await mkAuthorizing(h, 'b', 2);
  ok(await h.timedOut('a'));
  expectView(await h.payment('b'), { status: 'authorizing', requests: 1 });
  assert.equal((await effectsOf(h, 'b')).length, 1);
});

// ---------- provider answers ----------

test('an ok answer makes an authorizing payment authorized', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 2);
  const e = await oneEffect(h, 'p');
  await h.completeEffect(e.id, 'ok');
  expectView(await h.payment('p'), { status: 'authorized', authorized: 2, captured: 0, refunded: 0, requests: 1 });
});

test('a failed answer makes an authorizing payment declined', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 2);
  const e = await oneEffect(h, 'p');
  await h.completeEffect(e.id, 'failed');
  expectView(await h.payment('p'), { status: 'declined', authorized: 2, captured: 0, refunded: 0, requests: 1 });
});

test('a completed ok effect is no longer pending', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  const e = await oneEffect(h, 'p');
  await h.completeEffect(e.id, 'ok');
  assert.equal((await h.pendingEffects()).some((x) => x.id === e.id), false);
});

test('a completed failed effect is no longer pending', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  const e = await oneEffect(h, 'p');
  await h.completeEffect(e.id, 'failed');
  assert.equal((await h.pendingEffects()).some((x) => x.id === e.id), false);
});

test('after a timedOut, an ok answer to the first request authorizes', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  await h.completeEffect(first.id, 'ok');
  expectView(await h.payment('p'), { status: 'authorized', requests: 2 });
});

test('after a timedOut, an ok answer to the newer request authorizes', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  const second = (await effectsOf(h, 'p')).find((e) => e.id !== first.id);
  await h.completeEffect(second.id, 'ok');
  expectView(await h.payment('p'), { status: 'authorized', requests: 2 });
});

test('after a timedOut, a failed answer to an earlier request declines', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  await h.completeEffect(first.id, 'failed');
  expectView(await h.payment('p'), { status: 'declined' });
});

test('the other requests stay pending after the first answer', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  await h.completeEffect(first.id, 'ok');
  assert.equal((await effectsOf(h, 'p')).length, 1);
});

test('first answer decides: a later failed answer leaves an authorized payment authorized', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 2);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  const second = (await effectsOf(h, 'p')).find((e) => e.id !== first.id);
  await h.completeEffect(second.id, 'ok');
  await h.completeEffect(first.id, 'failed');
  expectView(await h.payment('p'), { status: 'authorized', authorized: 2, requests: 2 });
});

test('first answer decides: a later ok answer leaves a declined payment declined', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 2);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  const second = (await effectsOf(h, 'p')).find((e) => e.id !== first.id);
  await h.completeEffect(first.id, 'failed');
  await h.completeEffect(second.id, 'ok');
  expectView(await h.payment('p'), { status: 'declined', requests: 2 });
});

test('a late answer is no longer pending once completed', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  const second = (await effectsOf(h, 'p')).find((e) => e.id !== first.id);
  await h.completeEffect(first.id, 'ok');
  await h.completeEffect(second.id, 'ok');
  assert.equal((await effectsOf(h, 'p')).length, 0);
});

test('a late ok answer after the payment failed leaves it failed', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  ok(await h.timedOut('p'));
  ok(await h.timedOut('p'));
  const es = await effectsOf(h, 'p');
  ok(await h.timedOut('p'));
  await h.completeEffect(es[0].id, 'ok');
  expectView(await h.payment('p'), { status: 'failed', requests: 3, captured: 0 });
});

test('a late failed answer after the payment failed leaves it failed', async () => {
  const h = await createHost();
  await mkFailed(h, 'p', 1);
  const es = await effectsOf(h, 'p');
  await h.completeEffect(es[1].id, 'failed');
  expectView(await h.payment('p'), { status: 'failed', requests: 3 });
});

test('all late answers after failure are accepted and leave it failed', async () => {
  const h = await createHost();
  await mkFailed(h, 'p', 2);
  const es = await effectsOf(h, 'p');
  assert.equal(es.length, 3);
  for (const e of es) await h.completeEffect(e.id, 'ok');
  expectView(await h.payment('p'), { status: 'failed', requests: 3 });
  assert.equal((await effectsOf(h, 'p')).length, 0);
  assert.equal((await h.capture('p', 1)).ok, false);
});

test('a late ok answer after a void leaves the payment voided', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  const second = (await effectsOf(h, 'p')).find((e) => e.id !== first.id);
  await h.completeEffect(first.id, 'ok');
  ok(await h.void('p'));
  await h.completeEffect(second.id, 'ok');
  expectView(await h.payment('p'), { status: 'voided', captured: 0 });
});

test('a late ok answer after a capture leaves the payment captured', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 2);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  const second = (await effectsOf(h, 'p')).find((e) => e.id !== first.id);
  await h.completeEffect(second.id, 'ok');
  ok(await h.capture('p', 1));
  await h.completeEffect(first.id, 'ok');
  expectView(await h.payment('p'), { status: 'captured', captured: 1, authorized: 2, refunded: 0 });
});

test('a late failed answer after a capture leaves the payment captured', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 2);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  const second = (await effectsOf(h, 'p')).find((e) => e.id !== first.id);
  await h.completeEffect(first.id, 'ok');
  ok(await h.capture('p', 2));
  await h.completeEffect(second.id, 'failed');
  expectView(await h.payment('p'), { status: 'captured', captured: 2 });
});

test('a late answer after a refund leaves the payment refunded', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  const second = (await effectsOf(h, 'p')).find((e) => e.id !== first.id);
  await h.completeEffect(first.id, 'ok');
  ok(await h.capture('p', 1));
  ok(await h.refund('p', 1));
  await h.completeEffect(second.id, 'ok');
  expectView(await h.payment('p'), { status: 'refunded', captured: 1, refunded: 1 });
});

test('answering one payment does not change another', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'a', 1);
  await mkAuthorizing(h, 'b', 1);
  const ea = await oneEffect(h, 'a');
  await h.completeEffect(ea.id, 'ok');
  expectView(await h.payment('b'), { status: 'authorizing' });
  assert.equal((await effectsOf(h, 'b')).length, 1);
});

test('answers for two payments in reverse order decide each independently', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'a', 1);
  await mkAuthorizing(h, 'b', 2);
  const ea = await oneEffect(h, 'a');
  const eb = await oneEffect(h, 'b');
  await h.completeEffect(eb.id, 'failed');
  await h.completeEffect(ea.id, 'ok');
  expectView(await h.payment('a'), { status: 'authorized', authorized: 1 });
  expectView(await h.payment('b'), { status: 'declined', authorized: 2 });
});

test('timedOut after the payment was approved by an answer is refused', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  await h.completeEffect(first.id, 'ok');
  await expectRefused(h, ['p'], () => h.timedOut('p'));
});

// ---------- capture ----------

test('capture on an unknown payment is refused', async () => {
  const h = await createHost();
  await expectRefused(h, ['x'], () => h.capture('x', 1));
  assert.equal(await h.payment('x'), null);
});

test('capture of the full amount makes the payment captured', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 2);
  ok(await h.capture('p', 2));
  expectView(await h.payment('p'), { status: 'captured', authorized: 2, captured: 2, refunded: 0, requests: 1 });
});

test('capture of part of the amount makes the payment captured', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 2);
  ok(await h.capture('p', 1));
  expectView(await h.payment('p'), { status: 'captured', authorized: 2, captured: 1, refunded: 0 });
});

test('capture of 1 on a 1-unit authorisation takes effect', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 1);
  ok(await h.capture('p', 1));
  expectView(await h.payment('p'), { status: 'captured', captured: 1 });
});

test('capture beyond the authorised amount is refused', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.capture('p', 2));
});

test('capture of 0 units is refused', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 2);
  await expectRefused(h, ['p'], () => h.capture('p', 0));
});

test('capture of a negative amount is refused', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 2);
  await expectRefused(h, ['p'], () => h.capture('p', -1));
});

test('capture on an authorizing payment is refused', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 2);
  await expectRefused(h, ['p'], () => h.capture('p', 1));
});

test('capture on a declined payment is refused', async () => {
  const h = await createHost();
  await mkDeclined(h, 'p', 2);
  await expectRefused(h, ['p'], () => h.capture('p', 1));
});

test('capture on a failed payment is refused', async () => {
  const h = await createHost();
  await mkFailed(h, 'p', 2);
  await expectRefused(h, ['p'], () => h.capture('p', 1));
});

test('capture on a voided payment is refused', async () => {
  const h = await createHost();
  await mkVoided(h, 'p', 2);
  await expectRefused(h, ['p'], () => h.capture('p', 1));
});

test('a second capture on a captured payment is refused', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 1);
  await expectRefused(h, ['p'], () => h.capture('p', 1));
});

test('capture after a full capture is refused', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 2);
  await expectRefused(h, ['p'], () => h.capture('p', 1));
});

test('capture on a refunded payment is refused', async () => {
  const h = await createHost();
  await mkRefunded(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.capture('p', 1));
});

// ---------- void ----------

test('void on an unknown payment is refused', async () => {
  const h = await createHost();
  await expectRefused(h, ['x'], () => h.void('x'));
  assert.equal(await h.payment('x'), null);
});

test('void on an authorized payment makes it voided with nothing captured', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 2);
  ok(await h.void('p'));
  expectView(await h.payment('p'), { status: 'voided', authorized: 2, captured: 0, refunded: 0, requests: 1 });
});

test('void on an authorizing payment is refused', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.void('p'));
});

test('void on a captured payment is refused', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 1);
  await expectRefused(h, ['p'], () => h.void('p'));
});

test('void on a voided payment is refused', async () => {
  const h = await createHost();
  await mkVoided(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.void('p'));
});

test('void on a declined payment is refused', async () => {
  const h = await createHost();
  await mkDeclined(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.void('p'));
});

test('void on a failed payment is refused', async () => {
  const h = await createHost();
  await mkFailed(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.void('p'));
});

test('void on a refunded payment is refused', async () => {
  const h = await createHost();
  await mkRefunded(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.void('p'));
});

test('refund on a voided payment is refused', async () => {
  const h = await createHost();
  await mkVoided(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.refund('p', 1));
});

// ---------- refund ----------

test('refund on an unknown payment is refused', async () => {
  const h = await createHost();
  await expectRefused(h, ['x'], () => h.refund('x', 1));
  assert.equal(await h.payment('x'), null);
});

test('refund of everything captured makes the payment refunded', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 2);
  ok(await h.refund('p', 2));
  expectView(await h.payment('p'), { status: 'refunded', authorized: 2, captured: 2, refunded: 2, requests: 1 });
});

test('refund of part of the capture keeps the payment captured', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 2);
  ok(await h.refund('p', 1));
  expectView(await h.payment('p'), { status: 'captured', captured: 2, refunded: 1 });
});

test('two partial refunds covering the capture make the payment refunded', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 2);
  ok(await h.refund('p', 1));
  ok(await h.refund('p', 1));
  expectView(await h.payment('p'), { status: 'refunded', captured: 2, refunded: 2 });
});

test('refund of a partial capture in full makes the payment refunded', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 1);
  ok(await h.refund('p', 1));
  expectView(await h.payment('p'), { status: 'refunded', authorized: 2, captured: 1, refunded: 1 });
});

test('refund beyond the amount captured is refused', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 1);
  await expectRefused(h, ['p'], () => h.refund('p', 2));
});

test('refund beyond what remains after a partial refund is refused', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 2);
  ok(await h.refund('p', 1));
  await expectRefused(h, ['p'], () => h.refund('p', 2));
});

test('refund of 0 units is refused', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 2);
  await expectRefused(h, ['p'], () => h.refund('p', 0));
});

test('refund of 3 units is refused', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 2);
  await expectRefused(h, ['p'], () => h.refund('p', 3));
});

test('refund of a negative amount is refused', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 2);
  await expectRefused(h, ['p'], () => h.refund('p', -1));
});

test('refund on an authorizing payment is refused', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.refund('p', 1));
});

test('refund on an authorized payment is refused', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.refund('p', 1));
});

test('refund on a declined payment is refused', async () => {
  const h = await createHost();
  await mkDeclined(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.refund('p', 1));
});

test('refund on a failed payment is refused', async () => {
  const h = await createHost();
  await mkFailed(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.refund('p', 1));
});

test('refund on a refunded payment is refused', async () => {
  const h = await createHost();
  await mkRefunded(h, 'p', 2);
  await expectRefused(h, ['p'], () => h.refund('p', 1));
});

// ---------- increase (change 1) ----------

async function mkAuthorizedAt(h, p, amount) {
  await mkAuthorized(h, p, Math.min(amount, 2));
  for (let a = 2; a < amount; a++) ok(await h.increase(p));
}

test('increase on an unknown payment is refused', async () => {
  const h = await createHost();
  await expectRefused(h, ['x'], () => h.increase('x'));
  assert.equal(await h.payment('x'), null);
});

test('increase raises a 1-unit authorisation to 2', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 1);
  ok(await h.increase('p'));
  expectView(await h.payment('p'), { status: 'authorized', authorized: 2, captured: 0, refunded: 0 });
});

test('increase raises a 2-unit authorisation to 3', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 2);
  ok(await h.increase('p'));
  expectView(await h.payment('p'), { status: 'authorized', authorized: 3, captured: 0, refunded: 0 });
});

test('increase twice raises a 1-unit authorisation to 3', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 1);
  ok(await h.increase('p'));
  ok(await h.increase('p'));
  expectView(await h.payment('p'), { status: 'authorized', authorized: 3 });
});

test('increase beyond 3 units is refused', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 2);
  ok(await h.increase('p'));
  await expectRefused(h, ['p'], () => h.increase('p'));
});

test('repeated increases from 1 stop at 3 units', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 1);
  const results = [];
  for (let i = 0; i < 4; i++) results.push((await h.increase('p')).ok);
  assert.deepEqual(results, [true, true, false, false]);
  expectView(await h.payment('p'), { authorized: 3 });
});

test('increase on an authorizing payment is refused', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.increase('p'));
});

test('increase on a partly captured payment is refused', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 1);
  await expectRefused(h, ['p'], () => h.increase('p'));
});

test('increase on a fully captured payment is refused', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 1, 1);
  await expectRefused(h, ['p'], () => h.increase('p'));
});

test('increase on a voided payment is refused', async () => {
  const h = await createHost();
  await mkVoided(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.increase('p'));
});

test('increase on a declined payment is refused', async () => {
  const h = await createHost();
  await mkDeclined(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.increase('p'));
});

test('increase on a failed payment is refused', async () => {
  const h = await createHost();
  await mkFailed(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.increase('p'));
});

test('increase on a refunded payment is refused', async () => {
  const h = await createHost();
  await mkRefunded(h, 'p', 1);
  await expectRefused(h, ['p'], () => h.increase('p'));
});

test('increase on one payment does not change another', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'a', 1);
  await mkAuthorized(h, 'b', 1);
  ok(await h.increase('a'));
  expectView(await h.payment('b'), { status: 'authorized', authorized: 1 });
});

test('capture of 3 units after raising to 3 takes effect', async () => {
  const h = await createHost();
  await mkAuthorizedAt(h, 'p', 3);
  ok(await h.capture('p', 3));
  expectView(await h.payment('p'), { status: 'captured', authorized: 3, captured: 3, refunded: 0 });
});

test('capture of 2 units after raising a 1-unit authorisation takes effect', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 1);
  ok(await h.increase('p'));
  ok(await h.capture('p', 2));
  expectView(await h.payment('p'), { status: 'captured', authorized: 2, captured: 2 });
});

test('capture of 3 units on a 2-unit authorisation is refused', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 2);
  await expectRefused(h, ['p'], () => h.capture('p', 3));
});

test('capture of 4 units on a 3-unit authorisation is refused', async () => {
  const h = await createHost();
  await mkAuthorizedAt(h, 'p', 3);
  await expectRefused(h, ['p'], () => h.capture('p', 4));
});

test('capture of part of a raised authorisation takes effect', async () => {
  const h = await createHost();
  await mkAuthorizedAt(h, 'p', 3);
  ok(await h.capture('p', 1));
  expectView(await h.payment('p'), { status: 'captured', authorized: 3, captured: 1 });
});

test('a single refund of 3 units is refused even when 3 were captured', async () => {
  const h = await createHost();
  await mkAuthorizedAt(h, 'p', 3);
  ok(await h.capture('p', 3));
  await expectRefused(h, ['p'], () => h.refund('p', 3));
});

test('refunds of 2 then 1 on a 3-unit capture make the payment refunded', async () => {
  const h = await createHost();
  await mkAuthorizedAt(h, 'p', 3);
  ok(await h.capture('p', 3));
  ok(await h.refund('p', 2));
  expectView(await h.payment('p'), { status: 'captured', captured: 3, refunded: 2 });
  ok(await h.refund('p', 1));
  expectView(await h.payment('p'), { status: 'refunded', captured: 3, refunded: 3 });
});

test('refund beyond a 3-unit capture is refused', async () => {
  const h = await createHost();
  await mkAuthorizedAt(h, 'p', 3);
  ok(await h.capture('p', 3));
  ok(await h.refund('p', 2));
  await expectRefused(h, ['p'], () => h.refund('p', 2));
});

test('void after an increase takes effect and captures nothing', async () => {
  const h = await createHost();
  await mkAuthorizedAt(h, 'p', 3);
  ok(await h.void('p'));
  expectView(await h.payment('p'), { status: 'voided', authorized: 3, captured: 0 });
});

test('a late ok answer after an increase leaves the raised amount', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  const second = (await effectsOf(h, 'p')).find((e) => e.id !== first.id);
  await h.completeEffect(first.id, 'ok');
  ok(await h.increase('p'));
  await h.completeEffect(second.id, 'ok');
  expectView(await h.payment('p'), { status: 'authorized', authorized: 2 });
});

test('a late failed answer after an increase leaves the payment authorized', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 2);
  const first = await oneEffect(h, 'p');
  ok(await h.timedOut('p'));
  const second = (await effectsOf(h, 'p')).find((e) => e.id !== first.id);
  await h.completeEffect(second.id, 'ok');
  ok(await h.increase('p'));
  await h.completeEffect(first.id, 'failed');
  expectView(await h.payment('p'), { status: 'authorized', authorized: 3 });
  ok(await h.capture('p', 3));
});

// ---------- conclusion ----------

test('a payment never sends more than 3 authorisation requests', async () => {
  const h = await createHost();
  await mkAuthorizing(h, 'p', 1);
  for (let i = 0; i < 6; i++) await h.timedOut('p');
  expectView(await h.payment('p'), { status: 'failed', requests: 3 });
  assert.equal((await effectsOf(h, 'p')).length, 3);
});

test('a voided payment captured nothing even after capture attempts', async () => {
  const h = await createHost();
  await mkVoided(h, 'p', 2);
  for (const a of [1, 2]) assert.equal((await h.capture('p', a)).ok, false);
  expectView(await h.payment('p'), { status: 'voided', captured: 0, refunded: 0 });
});

test('nothing beyond the authorised amount can be captured by any amount', async () => {
  const h = await createHost();
  await mkAuthorized(h, 'p', 1);
  for (const a of [2, 3, 4]) assert.equal((await h.capture('p', a)).ok, false);
  expectView(await h.payment('p'), { status: 'authorized', captured: 0 });
});

test('repeated refunds never exceed the amount captured', async () => {
  const h = await createHost();
  await mkCaptured(h, 'p', 2, 2);
  const results = [];
  for (let i = 0; i < 4; i++) results.push((await h.refund('p', 1)).ok);
  assert.deepEqual(results, [true, true, false, false]);
  expectView(await h.payment('p'), { status: 'refunded', captured: 2, refunded: 2 });
});

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function checkInvariants(v) {
  if (v === null) return;
  assert.ok(STATUSES.includes(v.status), `status ${v.status}`);
  assert.ok(v.authorized >= 1 && v.authorized <= 3);
  assert.ok(v.requests >= 1 && v.requests <= 3);
  assert.ok(v.captured >= 0 && v.captured <= v.authorized);
  assert.ok(v.refunded >= 0 && v.refunded <= v.captured);
  if (['authorizing', 'authorized', 'declined', 'failed', 'voided'].includes(v.status)) {
    assert.equal(v.captured, 0);
    assert.equal(v.refunded, 0);
  }
  if (v.status === 'captured') {
    assert.ok(v.captured > 0);
    assert.ok(v.refunded < v.captured);
  }
  if (v.status === 'refunded') {
    assert.ok(v.captured > 0);
    assert.equal(v.refunded, v.captured);
  }
}

for (let seed = 1; seed <= 25; seed++) {
  test(`random command sequence ${seed} keeps money within the brief's limits`, async () => {
    const h = await createHost();
    const rnd = lcg(seed * 7919);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const ids = ['a', 'b', 'c'];
    let prev = await snapshot(h, ids);
    for (let step = 0; step < 50; step++) {
      const op = pick(['authorize', 'timedOut', 'timedOut', 'capture', 'void', 'refund', 'increase', 'answer', 'answer']);
      const id = pick(ids);
      const amt = pick([0, 1, 2, 3, 4]);
      let r = null;
      let completed = null;
      if (op === 'answer') {
        const pending = await h.pendingEffects();
        if (pending.length === 0) continue;
        completed = pick(pending);
        await h.completeEffect(completed.id, pick(['ok', 'failed']));
      } else if (op === 'timedOut' || op === 'void' || op === 'increase') {
        r = await h[op](id);
      } else {
        r = await h[op](id, op === 'authorize' ? 1 + (amt % 2) : amt);
      }
      const now = await snapshot(h, ids);
      if (r && r.ok === false) assert.deepEqual(now, prev, `refused ${op} changed something`);
      if (completed) {
        assert.equal(now.effects.some((s) => s.startsWith(completed.id + '|')), false);
      }
      for (const p of ids) {
        const v = now.views[p];
        const pv = prev.views[p];
        checkInvariants(v);
        if (pv !== null) {
          assert.notEqual(v, null);
          assert.ok(v.authorized >= pv.authorized);
          if (v.authorized !== pv.authorized) assert.equal(pv.status, 'authorized');
          assert.ok(v.captured >= pv.captured);
          if (v.captured !== pv.captured) assert.equal(pv.status, 'authorized');
          assert.ok(v.refunded >= pv.refunded);
          assert.ok(v.requests >= pv.requests);
          if (TERMINAL.includes(pv.status)) assert.deepEqual(v, pv);
        }
      }
      prev = now;
    }
  });
}
