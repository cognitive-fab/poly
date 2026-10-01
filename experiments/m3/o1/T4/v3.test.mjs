import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { default: createHost } = await import(pathToFileURL(process.env.M3_IMPL).href);

// ---------------------------------------------------------------------------
// Test helpers (they only drive and observe the host interface).
// ---------------------------------------------------------------------------

function matches(m, q) {
  if (q.from !== undefined && m.from !== q.from) return false;
  if (q.to !== undefined && m.to !== q.to) return false;
  if (q.action !== undefined && m.action !== q.action) return false;
  if (q.data !== undefined) {
    if (!m.data || typeof m.data !== 'object') return false;
    for (const [k, v] of Object.entries(q.data)) if (m.data[k] !== v) return false;
  }
  return true;
}

async function msgs(h, q = {}) {
  return (await h.inFlight()).filter((m) => matches(m, q));
}

async function deliverOne(h, q) {
  const ms = await msgs(h, q);
  assert.ok(ms.length >= 1, `expected a message in flight matching ${JSON.stringify(q)}`);
  await h.deliver(ms[0].id);
  return ms[0];
}

async function deliverAllTo(h, to) {
  for (const m of await msgs(h, { to })) await h.deliver(m.id);
}

async function drain(h) {
  for (let i = 0; i < 50; i++) {
    await h.deliverAll();
    if ((await h.inFlight()).length === 0) return;
  }
}

async function ok(p) {
  const r = await p;
  assert.equal(r.ok, true);
  return r;
}

async function openWith(h, id, n) {
  await ok(h.open(id));
  for (let i = 0; i < n; i++) await ok(h.add(id));
}

async function toReserving(h, id, n = 1) {
  await openWith(h, id, n);
  await ok(h.checkout(id));
}

async function deliverReserve(h, id) {
  return deliverOne(h, { from: id, to: 'inventory', action: 'Reserve' });
}

async function deliverInventoryAnswer(h, id) {
  return deliverOne(h, { from: 'inventory', to: id });
}

async function deliverCharge(h, id) {
  return deliverOne(h, { from: id, to: 'payments', action: 'Charge' });
}

async function deliverPaymentAnswer(h, id) {
  return deliverOne(h, { from: 'payments', to: id });
}

async function toPaying(h, id, n = 1) {
  await toReserving(h, id, n);
  await deliverReserve(h, id);
  await deliverOne(h, { from: 'inventory', to: id, action: 'Reserved' });
}

async function toPaid(h, id, n = 1) {
  await toPaying(h, id, n);
  await deliverCharge(h, id);
  await deliverOne(h, { from: 'payments', to: id, action: 'Charged' });
}

// Puts cart `id` (with n units) in the given status. 'failed' uses a blocker cart 'zz'.
async function makeStatus(h, id, st, n = 1) {
  switch (st) {
    case 'open':
      return openWith(h, id, n);
    case 'reserving':
      return toReserving(h, id, n);
    case 'paying':
      return toPaying(h, id, n);
    case 'paid':
      return toPaid(h, id, n);
    case 'failed':
      await toReserving(h, 'zz', 2);
      await deliverReserve(h, 'zz');
      await toReserving(h, id, n);
      await deliverReserve(h, id);
      await deliverOne(h, { from: 'inventory', to: id, action: 'OutOfStock' });
      return;
    case 'cancelling':
      await toReserving(h, id, n);
      await ok(h.cancel(id));
      return;
    case 'cancelled':
      await openWith(h, id, n);
      await ok(h.cancel(id));
      return;
    case 'returned':
      await toPaid(h, id, n);
      await ok(h.returnCart(id));
      return;
    case 'declined':
      await toPaying(h, id, n);
      await ok(h.declineCards());
      await deliverCharge(h, id);
      await deliverOne(h, { from: 'payments', to: id, action: 'Declined' });
      await ok(h.acceptCards());
      return;
    case 'abandoning':
      await toPaying(h, id, n);
      await ok(h.paymentTimeout(id));
      return;
    default:
      throw new Error('unknown status ' + st);
  }
}

const ALL_STATUSES = [
  'open', 'reserving', 'paying', 'paid', 'failed', 'cancelling', 'cancelled',
  'returned',
  'declined',
  'abandoning',
];

async function expectStatus(h, id, st) {
  const v = await h.cart(id);
  assert.notEqual(v, null);
  assert.equal(v.status, st);
}

async function expectItems(h, id, n) {
  const v = await h.cart(id);
  assert.notEqual(v, null);
  assert.equal(v.items, n);
}

async function expectStock(h, available, reserved) {
  const s = await h.stock();
  assert.equal(s.available, available);
  assert.equal(s.reserved, reserved);
}

async function expectPayments(h, charged, declining) {
  const p = await h.payments();
  assert.equal(p.charged, charged);
  assert.equal(p.declining, declining);
}

async function snap(h, ids) {
  const carts = {};
  for (const id of ids) carts[id] = await h.cart(id);
  const inflight = (await h.inFlight())
    .map((m) => JSON.stringify([m.from, m.to, m.action, m.data]))
    .sort();
  return { carts, stock: await h.stock(), payments: await h.payments(), inflight };
}

// The command must be refused and change nothing observable.
async function assertRefused(h, ids, fn) {
  const before = await snap(h, ids);
  const r = await fn();
  assert.equal(r.ok, false);
  assert.deepEqual(await snap(h, ids), before);
}

// The brief's conclusion, checked once nothing is in transit.
async function checkConclusion(h, ids) {
  assert.equal((await h.inFlight()).length, 0);
  let paid = 0;
  let held = 0;
  for (const id of ids) {
    const v = await h.cart(id);
    if (!v) continue;
    if (v.status === 'paid') paid += v.items;
    if (v.status === 'declined') held += v.items;
  }
  const s = await h.stock();
  assert.equal(s.reserved, paid + held);
  assert.equal(s.available, 2 - paid - held);
  assert.equal((await h.payments()).charged, paid);
}

const TRANSIENT = [
  'reserving', 'paying', 'cancelling',
  'abandoning',
];

const RANDOM_CMDS = [
  'open', 'add', 'add', 'checkout', 'cancel', 'declineCards', 'acceptCards',
  'returnCart',
  'retry', 'abandon',
  'paymentTimeout',
];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

async function randomRun(h, seed, steps) {
  const r = rng(seed);
  const ids = ['a', 'b', 'c', 'd'];
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  for (let i = 0; i < steps; i++) {
    if (r() < 0.45) {
      const fl = await h.inFlight();
      if (fl.length > 0) await h.deliver(pick(fl).id);
    } else {
      const cmd = pick(RANDOM_CMDS);
      const res = cmd === 'declineCards' || cmd === 'acceptCards' ? await h[cmd]() : await h[cmd](pick(ids));
      assert.equal(typeof res.ok, 'boolean');
    }
    const s = await h.stock();
    assert.equal(s.available + s.reserved, 2);
    assert.ok(s.available >= 0 && s.reserved >= 0);
  }
  await drain(h);
  await checkConclusion(h, ids);
  for (const id of ids) {
    const v = await h.cart(id);
    if (v) assert.equal(TRANSIENT.includes(v.status), false, `cart ${id} left ${v.status}`);
  }
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

test('fresh system: inventory has 2 available and 0 reserved', async () => {
  const h = await createHost();
  await expectStock(h, 2, 0);
});

test('fresh system: payment service has charged 0 and accepts', async () => {
  const h = await createHost();
  await expectPayments(h, 0, false);
});

test('fresh system: no message is in flight', async () => {
  const h = await createHost();
  assert.equal((await h.inFlight()).length, 0);
});

test('cart query returns null for an id never opened', async () => {
  const h = await createHost();
  assert.equal(await h.cart('nope'), null);
});

test('each createHost call gives an independent fresh system', async () => {
  const h1 = await createHost();
  await toPaid(h1, 'a', 2);
  const h2 = await createHost();
  await expectStock(h2, 2, 0);
  await expectPayments(h2, 0, false);
  assert.equal(await h2.cart('a'), null);
});

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

test('open creates an open cart with 0 items', async () => {
  const h = await createHost();
  await ok(h.open('a'));
  await expectStatus(h, 'a', 'open');
  await expectItems(h, 'a', 0);
});

test('open does not create any other cart', async () => {
  const h = await createHost();
  await ok(h.open('a'));
  assert.equal(await h.cart('b'), null);
});

test('open and add change neither stock nor payments', async () => {
  const h = await createHost();
  await openWith(h, 'a', 2);
  await expectStock(h, 2, 0);
  await expectPayments(h, 0, false);
});

test('open and add send no Reserve', async () => {
  const h = await createHost();
  await openWith(h, 'a', 2);
  assert.equal((await msgs(h, { action: 'Reserve' })).length, 0);
});

test('carts with different ids are independent', async () => {
  const h = await createHost();
  await ok(h.open('a'));
  await ok(h.open('b'));
  await ok(h.add('a'));
  await expectItems(h, 'a', 1);
  await expectItems(h, 'b', 0);
});

for (const st of ALL_STATUSES) {
  test(`open is refused for an id whose cart exists and is ${st}`, async () => {
    const h = await createHost();
    await makeStatus(h, 'a', st);
    await assertRefused(h, ['a', 'zz'], () => h.open('a'));
  });
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

test('add puts one unit in an open cart', async () => {
  const h = await createHost();
  await ok(h.open('a'));
  await ok(h.add('a'));
  await expectItems(h, 'a', 1);
  await expectStatus(h, 'a', 'open');
});

test('add twice gives an open cart 2 items', async () => {
  const h = await createHost();
  await openWith(h, 'a', 2);
  await expectItems(h, 'a', 2);
  await expectStatus(h, 'a', 'open');
});

test('a third add is refused: an open cart holds at most 2 units', async () => {
  const h = await createHost();
  await openWith(h, 'a', 2);
  await assertRefused(h, ['a'], () => h.add('a'));
  await expectItems(h, 'a', 2);
});

test('add on a cart id never opened is refused and creates nothing', async () => {
  const h = await createHost();
  await assertRefused(h, ['x'], () => h.add('x'));
  assert.equal(await h.cart('x'), null);
});

for (const st of ALL_STATUSES.filter((s) => s !== 'open')) {
  test(`add is refused for a ${st} cart`, async () => {
    const h = await createHost();
    await makeStatus(h, 'a', st);
    await assertRefused(h, ['a', 'zz'], () => h.add('a'));
  });
}

// ---------------------------------------------------------------------------
// checkout
// ---------------------------------------------------------------------------

test('checkout of an empty open cart is refused', async () => {
  const h = await createHost();
  await ok(h.open('a'));
  await assertRefused(h, ['a'], () => h.checkout('a'));
  await expectStatus(h, 'a', 'open');
});

test('checkout of an open cart with 1 unit makes it reserving', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await expectStatus(h, 'a', 'reserving');
});

test('checkout of an open cart with 2 units makes it reserving', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  await expectStatus(h, 'a', 'reserving');
});

test('checkout sends exactly one Reserve from the cart to the inventory with from and qty 1', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  const ms = await msgs(h, { from: 'a', to: 'inventory', action: 'Reserve' });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].data.from, 'a');
  assert.equal(ms[0].data.qty, 1);
});

test('checkout of a 2-unit cart sends Reserve with qty 2', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  const ms = await msgs(h, { from: 'a', to: 'inventory', action: 'Reserve' });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].data.from, 'a');
  assert.equal(ms[0].data.qty, 2);
});

test('checkout does not change stock before the Reserve is delivered', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  await expectStock(h, 2, 0);
});

test('checkout sends no Charge before the inventory answers', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  assert.equal((await msgs(h, { action: 'Charge' })).length, 0);
});

test('checkout on a cart id never opened is refused and creates nothing', async () => {
  const h = await createHost();
  await assertRefused(h, ['x'], () => h.checkout('x'));
  assert.equal(await h.cart('x'), null);
});

for (const st of ALL_STATUSES.filter((s) => s !== 'open')) {
  test(`checkout is refused for a ${st} cart`, async () => {
    const h = await createHost();
    await makeStatus(h, 'a', st);
    await assertRefused(h, ['a', 'zz'], () => h.checkout('a'));
  });
}

// ---------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------

test('delivering a Reserve of 1 moves 1 unit from available to reserved', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await deliverReserve(h, 'a');
  await expectStock(h, 1, 1);
});

test('delivering a Reserve of 2 moves 2 units from available to reserved', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  await deliverReserve(h, 'a');
  await expectStock(h, 0, 2);
});

test('delivering a Reserve with enough stock answers Reserved to the cart', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await deliverReserve(h, 'a');
  const ms = await msgs(h, { from: 'inventory', to: 'a' });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].action, 'Reserved');
});

test('the cart stays reserving until the inventory answer is delivered', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await deliverReserve(h, 'a');
  await expectStatus(h, 'a', 'reserving');
});

test('a Reserved answer makes the reserving cart paying', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await expectStatus(h, 'a', 'paying');
});

test('a Reserved answer sends exactly one Charge to payments with from and amount equal to the units (1)', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  const ms = await msgs(h, { from: 'a', to: 'payments', action: 'Charge' });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].data.from, 'a');
  assert.equal(ms[0].data.amount, 1);
});

test('a Reserved answer for a 2-unit cart sends Charge with amount 2', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 2);
  const ms = await msgs(h, { from: 'a', to: 'payments', action: 'Charge' });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].data.amount, 2);
});

test('no Charge is sent before the Reserved answer is delivered', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await deliverReserve(h, 'a');
  assert.equal((await msgs(h, { action: 'Charge' })).length, 0);
});

test('a paying cart keeps its units reserved', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 2);
  await expectStock(h, 0, 2);
});

test('a Reserve for more than is available answers OutOfStock', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  await deliverReserve(h, 'a');
  await toReserving(h, 'b', 1);
  await deliverReserve(h, 'b');
  const ms = await msgs(h, { from: 'inventory', to: 'b' });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].action, 'OutOfStock');
});

test('a Reserve for more than is available changes no stock', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await deliverReserve(h, 'a');
  await toReserving(h, 'b', 2);
  await deliverReserve(h, 'b');
  await expectStock(h, 1, 1);
});

test('an OutOfStock answer makes the reserving cart failed', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'failed');
  await expectStatus(h, 'a', 'failed');
});

test('a cart failed for lack of stock sends no Charge and no Release', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'failed');
  assert.equal((await msgs(h, { from: 'a' })).length, 0);
  await expectStock(h, 0, 2);
});

test('a cart failed for lack of stock is never charged', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'failed');
  await drain(h);
  await expectStatus(h, 'a', 'failed');
  await expectStatus(h, 'zz', 'paid');
  await expectPayments(h, 2, false);
  await expectStock(h, 0, 2);
});

// ---------------------------------------------------------------------------
// The payment service
// ---------------------------------------------------------------------------

test('declineCards makes the payment service declining', async () => {
  const h = await createHost();
  await ok(h.declineCards());
  await expectPayments(h, 0, true);
});

test('declineCards is refused when the service already declines', async () => {
  const h = await createHost();
  await ok(h.declineCards());
  await assertRefused(h, [], () => h.declineCards());
  await expectPayments(h, 0, true);
});

test('acceptCards is refused when the service already accepts', async () => {
  const h = await createHost();
  await assertRefused(h, [], () => h.acceptCards());
  await expectPayments(h, 0, false);
});

test('acceptCards after declineCards makes the service accept again', async () => {
  const h = await createHost();
  await ok(h.declineCards());
  await ok(h.acceptCards());
  await expectPayments(h, 0, false);
});

test('declineCards does not change the total charged', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 1);
  await ok(h.declineCards());
  await expectPayments(h, 1, true);
});

test('declineCards and acceptCards change no cart and no stock', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await ok(h.declineCards());
  await ok(h.acceptCards());
  await expectStatus(h, 'a', 'paying');
  await expectStock(h, 1, 1);
});

test('delivering a Charge when accepting adds the amount to the total', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 2);
  await deliverCharge(h, 'a');
  await expectPayments(h, 2, false);
});

test('delivering a Charge when accepting answers Charged to the cart', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await deliverCharge(h, 'a');
  const ms = await msgs(h, { from: 'payments', to: 'a' });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].action, 'Charged');
});

test('the cart stays paying until the payment answer is delivered', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await deliverCharge(h, 'a');
  await expectStatus(h, 'a', 'paying');
});

test('a Charged answer makes the paying cart paid', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 1);
  await expectStatus(h, 'a', 'paid');
});

test('a paid cart keeps its units reserved', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 2);
  await expectStock(h, 0, 2);
  await expectPayments(h, 2, false);
});

test('a paid cart view shows its units', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 2);
  await expectItems(h, 'a', 2);
});

test('a paid cart sends no further message', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 1);
  assert.equal((await h.inFlight()).length, 0);
});

test('delivering a Charge when declining answers Declined', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await ok(h.declineCards());
  await deliverCharge(h, 'a');
  const ms = await msgs(h, { from: 'payments', to: 'a' });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].action, 'Declined');
});

test('delivering a Charge when declining leaves the total unchanged', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 2);
  await ok(h.declineCards());
  await deliverCharge(h, 'a');
  await expectPayments(h, 0, true);
});

test('declineCards before the Charge is delivered declines that charge', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await ok(h.declineCards());
  await drain(h);
  await expectStatus(h, 'a', 'declined');
  await expectPayments(h, 0, true);
});

test('acceptCards before the Charge is delivered lets that charge through', async () => {
  const h = await createHost();
  await ok(h.declineCards());
  await toPaying(h, 'a', 1);
  await ok(h.acceptCards());
  await drain(h);
  await expectStatus(h, 'a', 'paid');
  await expectPayments(h, 1, false);
});

test('declineCards after the Charge was delivered does not undo that charge', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await deliverCharge(h, 'a');
  await ok(h.declineCards());
  await deliverPaymentAnswer(h, 'a');
  await expectStatus(h, 'a', 'paid');
  await expectPayments(h, 1, true);
  await expectStock(h, 1, 1);
});


// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

test('cancel makes an empty open cart cancelled', async () => {
  const h = await createHost();
  await ok(h.open('a'));
  await ok(h.cancel('a'));
  await expectStatus(h, 'a', 'cancelled');
});

test('cancel makes an open cart with units cancelled and changes no stock', async () => {
  const h = await createHost();
  await openWith(h, 'a', 2);
  await ok(h.cancel('a'));
  await expectStatus(h, 'a', 'cancelled');
  await expectStock(h, 2, 0);
  await expectPayments(h, 0, false);
});

test('cancel of an open cart sends no message', async () => {
  const h = await createHost();
  await openWith(h, 'a', 1);
  await ok(h.cancel('a'));
  assert.equal((await h.inFlight()).length, 0);
});

test('cancel makes a reserving cart cancelling', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await ok(h.cancel('a'));
  await expectStatus(h, 'a', 'cancelling');
});

test('a cancelling cart stays cancelling while the Reserve is undelivered', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await ok(h.cancel('a'));
  await deliverReserve(h, 'a');
  await expectStatus(h, 'a', 'cancelling');
});

test('a Reserved answer makes a cancelling cart cancelled', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await ok(h.cancel('a'));
  await deliverReserve(h, 'a');
  await deliverOne(h, { from: 'inventory', to: 'a', action: 'Reserved' });
  await expectStatus(h, 'a', 'cancelled');
});

test('a Reserved answer to a cancelling cart sends one Release with its units and no Charge', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  await ok(h.cancel('a'));
  await deliverReserve(h, 'a');
  await deliverOne(h, { from: 'inventory', to: 'a', action: 'Reserved' });
  const rel = await msgs(h, { from: 'a', to: 'inventory', action: 'Release' });
  assert.equal(rel.length, 1);
  assert.equal(rel[0].data.qty, 2);
  assert.equal((await msgs(h, { action: 'Charge' })).length, 0);
});

test('units reserved for a cancelling cart come back once its Release is delivered', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  await ok(h.cancel('a'));
  await deliverReserve(h, 'a');
  await expectStock(h, 0, 2);
  await deliverOne(h, { from: 'inventory', to: 'a', action: 'Reserved' });
  await deliverOne(h, { from: 'a', to: 'inventory', action: 'Release' });
  await expectStock(h, 2, 0);
  await expectPayments(h, 0, false);
});

test('an OutOfStock answer makes a cancelling cart cancelled', async () => {
  const h = await createHost();
  await toReserving(h, 'zz', 2);
  await deliverReserve(h, 'zz');
  await toReserving(h, 'a', 1);
  await ok(h.cancel('a'));
  await deliverReserve(h, 'a');
  await deliverOne(h, { from: 'inventory', to: 'a', action: 'OutOfStock' });
  await expectStatus(h, 'a', 'cancelled');
});

test('an OutOfStock answer to a cancelling cart gives nothing back', async () => {
  const h = await createHost();
  await toReserving(h, 'zz', 2);
  await deliverReserve(h, 'zz');
  await toReserving(h, 'a', 1);
  await ok(h.cancel('a'));
  await deliverReserve(h, 'a');
  await deliverOne(h, { from: 'inventory', to: 'a', action: 'OutOfStock' });
  assert.equal((await msgs(h, { from: 'a' })).length, 0);
  await expectStock(h, 0, 2);
});

test('a cart cancelled before its Reserve is delivered ends with nothing reserved or charged', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  await ok(h.cancel('a'));
  await drain(h);
  await expectStatus(h, 'a', 'cancelled');
  await expectStock(h, 2, 0);
  await expectPayments(h, 0, false);
});

test('cancel is refused for a paying cart', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await assertRefused(h, ['a'], () => h.cancel('a'));
  await expectStatus(h, 'a', 'paying');
});

test('cancel is refused for a paying cart whose Charge was already delivered', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await deliverCharge(h, 'a');
  await assertRefused(h, ['a'], () => h.cancel('a'));
});

for (const st of ALL_STATUSES.filter((s) => !['open', 'reserving', 'paying'].includes(s))) {
  test(`cancel is refused for a ${st} cart`, async () => {
    const h = await createHost();
    await makeStatus(h, 'a', st);
    await assertRefused(h, ['a', 'zz'], () => h.cancel('a'));
  });
}

test('cancel on a cart id never opened is refused and creates nothing', async () => {
  const h = await createHost();
  await assertRefused(h, ['x'], () => h.cancel('x'));
  assert.equal(await h.cart('x'), null);
});

// ---------------------------------------------------------------------------
// Several carts and message orders
// ---------------------------------------------------------------------------

test('two one-unit carts can both be paid', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await toReserving(h, 'b', 1);
  await drain(h);
  await expectStatus(h, 'a', 'paid');
  await expectStatus(h, 'b', 'paid');
  await expectStock(h, 0, 2);
  await expectPayments(h, 2, false);
});

test('two two-unit carts: the Reserve delivered first (b) wins, the other fails', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  await toReserving(h, 'b', 2);
  await deliverReserve(h, 'b');
  await deliverReserve(h, 'a');
  await drain(h);
  await expectStatus(h, 'b', 'paid');
  await expectStatus(h, 'a', 'failed');
  await checkConclusion(h, ['a', 'b']);
});

test('two two-unit carts: the Reserve delivered first (a) wins, the other fails', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  await toReserving(h, 'b', 2);
  await deliverReserve(h, 'a');
  await deliverReserve(h, 'b');
  await drain(h);
  await expectStatus(h, 'a', 'paid');
  await expectStatus(h, 'b', 'failed');
  await checkConclusion(h, ['a', 'b']);
});

test('a one-unit Reserve delivered first leaves too little for a two-unit cart', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  await toReserving(h, 'b', 1);
  await deliverReserve(h, 'b');
  await deliverReserve(h, 'a');
  await drain(h);
  await expectStatus(h, 'b', 'paid');
  await expectStatus(h, 'a', 'failed');
  await expectStock(h, 1, 1);
  await expectPayments(h, 1, false);
});

test('answers can be delivered in a different order from the requests', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await toReserving(h, 'b', 1);
  await deliverReserve(h, 'a');
  await deliverReserve(h, 'b');
  await deliverInventoryAnswer(h, 'b');
  await deliverCharge(h, 'b');
  await deliverInventoryAnswer(h, 'a');
  await deliverCharge(h, 'a');
  await deliverPaymentAnswer(h, 'a');
  await expectStatus(h, 'a', 'paid');
  await expectStatus(h, 'b', 'paying');
  await deliverPaymentAnswer(h, 'b');
  await expectStatus(h, 'b', 'paid');
  await checkConclusion(h, ['a', 'b']);
});

test('a cancelled cart Release delivered before another Reserve lets that cart buy the units', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  await toReserving(h, 'b', 2);
  await deliverReserve(h, 'a');
  await ok(h.cancel('a'));
  await deliverInventoryAnswer(h, 'a');
  await deliverOne(h, { from: 'a', to: 'inventory', action: 'Release' });
  await deliverReserve(h, 'b');
  await drain(h);
  await expectStatus(h, 'a', 'cancelled');
  await expectStatus(h, 'b', 'paid');
  await checkConclusion(h, ['a', 'b']);
});

test('another Reserve delivered before a cancelled cart Release finds no stock', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  await toReserving(h, 'b', 2);
  await deliverReserve(h, 'a');
  await ok(h.cancel('a'));
  await deliverInventoryAnswer(h, 'a');
  await deliverReserve(h, 'b');
  await drain(h);
  await expectStatus(h, 'a', 'cancelled');
  await expectStatus(h, 'b', 'failed');
  await expectStock(h, 2, 0);
  await checkConclusion(h, ['a', 'b']);
});

test('cancel while the inventory answer is in flight still ends cancelled with units back', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await deliverReserve(h, 'a');
  await ok(h.cancel('a'));
  await expectStatus(h, 'a', 'cancelling');
  await drain(h);
  await expectStatus(h, 'a', 'cancelled');
  await expectStock(h, 2, 0);
  await expectPayments(h, 0, false);
});

test('a payment answer for one cart does not change another paying cart', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await toPaying(h, 'b', 1);
  await deliverCharge(h, 'a');
  await deliverPaymentAnswer(h, 'a');
  await expectStatus(h, 'a', 'paid');
  await expectStatus(h, 'b', 'paying');
});

test('a cart is not paid while its Charge is still undelivered', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await toPaying(h, 'b', 1);
  await deliverCharge(h, 'b');
  await deliverPaymentAnswer(h, 'b');
  await expectStatus(h, 'a', 'paying');
  await expectPayments(h, 1, false);
});

// ---------------------------------------------------------------------------
// The conclusion
// ---------------------------------------------------------------------------

test('a single deliverAll leaves no message in flight', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await toReserving(h, 'b', 1);
  await h.deliverAll();
  assert.equal((await h.inFlight()).length, 0);
});

test('deliverAll completes a whole checkout to paid', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  await h.deliverAll();
  await expectStatus(h, 'a', 'paid');
  await expectStock(h, 0, 2);
  await expectPayments(h, 2, false);
});

test('conclusion: one paid cart, reserved and charged equal its units', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await drain(h);
  await checkConclusion(h, ['a']);
  await expectStock(h, 1, 1);
  await expectPayments(h, 1, false);
});

test('conclusion: while declining, every cart that checked out ends with nothing charged', async () => {
  const h = await createHost();
  await ok(h.declineCards());
  await toReserving(h, 'a', 1);
  await toReserving(h, 'b', 1);
  await drain(h);
  await checkConclusion(h, ['a', 'b']);
  await expectPayments(h, 0, true);
});

test('conclusion: a mix of paid, failed and cancelled carts', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await toReserving(h, 'b', 2);
  await toReserving(h, 'c', 1);
  await ok(h.cancel('c'));
  await openWith(h, 'd', 1);
  await ok(h.cancel('d'));
  await drain(h);
  await checkConclusion(h, ['a', 'b', 'c', 'd']);
});

test('conclusion: a cancel in the middle of a deliverAll-driven run', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 2);
  await toReserving(h, 'b', 1);
  await deliverReserve(h, 'a');
  await ok(h.cancel('b'));
  await drain(h);
  await checkConclusion(h, ['a', 'b']);
  await expectStatus(h, 'b', 'cancelled');
});

test('conclusion: decline toggled between two carts', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await toPaying(h, 'b', 1);
  await deliverCharge(h, 'a');
  await ok(h.declineCards());
  await deliverCharge(h, 'b');
  await ok(h.acceptCards());
  await drain(h);
  await expectStatus(h, 'a', 'paid');
  await expectStatus(h, 'b', 'declined');
  await checkConclusion(h, ['a', 'b']);
});

// ---------------------------------------------------------------------------
// Change 1: returns
// ---------------------------------------------------------------------------

test('returnCart makes a paid cart returned', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 1);
  await ok(h.returnCart('a'));
  await expectStatus(h, 'a', 'returned');
});

test('returnCart sends exactly one Refund to payments with amount equal to the units', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 2);
  await ok(h.returnCart('a'));
  const ms = await msgs(h, { from: 'a', to: 'payments', action: 'Refund' });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].data.amount, 2);
});

test('returnCart sends exactly one Release to the inventory with qty equal to the units', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 2);
  await ok(h.returnCart('a'));
  const ms = await msgs(h, { from: 'a', to: 'inventory', action: 'Release' });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].data.qty, 2);
});

test('the total charged is unchanged until the Refund is delivered', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 2);
  await ok(h.returnCart('a'));
  await expectPayments(h, 2, false);
});

test('delivering a Refund subtracts its amount from the total charged', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 2);
  await ok(h.returnCart('a'));
  await deliverOne(h, { from: 'a', to: 'payments', action: 'Refund' });
  await expectPayments(h, 0, false);
});

test('a Refund is subtracted even while the service declines', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 1);
  await ok(h.declineCards());
  await ok(h.returnCart('a'));
  await deliverOne(h, { from: 'a', to: 'payments', action: 'Refund' });
  await expectPayments(h, 0, true);
});

test('the payment service sends no answer to a Refund', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 1);
  await ok(h.returnCart('a'));
  await deliverOne(h, { from: 'a', to: 'payments', action: 'Refund' });
  assert.equal((await msgs(h, { from: 'payments' })).length, 0);
});

test('the returned units stay reserved until the Release is delivered', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 2);
  await ok(h.returnCart('a'));
  await expectStock(h, 0, 2);
});

test('delivering the Release of a returned cart makes its units available', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 2);
  await ok(h.returnCart('a'));
  await deliverOne(h, { from: 'a', to: 'inventory', action: 'Release' });
  await expectStock(h, 2, 0);
});

test('after a return and deliverAll nothing is reserved or charged', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 2);
  await ok(h.returnCart('a'));
  await drain(h);
  await expectStatus(h, 'a', 'returned');
  await expectStock(h, 2, 0);
  await expectPayments(h, 0, false);
  await checkConclusion(h, ['a']);
});

test('a returned cart sends nothing more once its messages are delivered', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 1);
  await ok(h.returnCart('a'));
  await drain(h);
  assert.equal((await h.inFlight()).length, 0);
  await expectStatus(h, 'a', 'returned');
});

test('returned units can be bought by another cart', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 2);
  await ok(h.returnCart('a'));
  await drain(h);
  await toReserving(h, 'b', 2);
  await drain(h);
  await expectStatus(h, 'b', 'paid');
  await checkConclusion(h, ['a', 'b']);
  await expectPayments(h, 2, false);
});

test('a Reserve delivered before a returned cart Release finds no stock', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 2);
  await toReserving(h, 'b', 1);
  await ok(h.returnCart('a'));
  await deliverReserve(h, 'b');
  await deliverInventoryAnswer(h, 'b');
  await expectStatus(h, 'b', 'failed');
  await drain(h);
  await checkConclusion(h, ['a', 'b']);
});

test('returning one paid cart leaves another paid cart alone', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 1);
  await toPaid(h, 'b', 1);
  await ok(h.returnCart('a'));
  await drain(h);
  await expectStatus(h, 'b', 'paid');
  await expectStock(h, 1, 1);
  await expectPayments(h, 1, false);
  await checkConclusion(h, ['a', 'b']);
});

for (const st of ALL_STATUSES.filter((s) => s !== 'paid')) {
  test(`returnCart is refused for a ${st} cart`, async () => {
    const h = await createHost();
    await makeStatus(h, 'a', st);
    await assertRefused(h, ['a', 'zz'], () => h.returnCart('a'));
  });
}

test('returnCart on a cart id never opened is refused and creates nothing', async () => {
  const h = await createHost();
  await assertRefused(h, ['x'], () => h.returnCart('x'));
  assert.equal(await h.cart('x'), null);
});

const RETURNED_CMDS = [
  'add', 'checkout', 'cancel', 'returnCart',
  'retry', 'abandon',
  'paymentTimeout',
];

for (const cmd of RETURNED_CMDS) {
  test(`a returned cart refuses ${cmd} (before its messages are delivered)`, async () => {
    const h = await createHost();
    await toPaid(h, 'a', 1);
    await ok(h.returnCart('a'));
    await assertRefused(h, ['a'], () => h[cmd]('a'));
  });
  test(`a returned cart refuses ${cmd} (after its messages are delivered)`, async () => {
    const h = await createHost();
    await toPaid(h, 'a', 1);
    await ok(h.returnCart('a'));
    await drain(h);
    await assertRefused(h, ['a'], () => h[cmd]('a'));
  });
}

test('a charge that takes the total to exactly 4 goes through', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 2);
  await ok(h.returnCart('a'));
  await deliverOne(h, { from: 'a', to: 'inventory', action: 'Release' });
  await toPaid(h, 'b', 2);
  await expectStatus(h, 'b', 'paid');
  await expectPayments(h, 4, false);
});

test('a charge that would take the total above 4 is declined and changes nothing', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 2);
  await ok(h.returnCart('a'));
  await deliverOne(h, { from: 'a', to: 'inventory', action: 'Release' });
  await toPaid(h, 'b', 2);
  await ok(h.returnCart('b'));
  await deliverOne(h, { from: 'b', to: 'inventory', action: 'Release' });
  await toPaying(h, 'c', 1);
  await deliverCharge(h, 'c');
  const ans = await msgs(h, { from: 'payments', to: 'c' });
  assert.equal(ans.length, 1);
  assert.equal(ans[0].action, 'Declined');
  await expectPayments(h, 4, false);
  await deliverPaymentAnswer(h, 'c');
  await expectStatus(h, 'c', 'declined');
  await drain(h);
  await expectPayments(h, 0, false);
  await checkConclusion(h, ['a', 'b', 'c']);
});

test('a Refund delivered before a charge makes room under the limit of 4', async () => {
  const h = await createHost();
  await toPaid(h, 'a', 2);
  await ok(h.returnCart('a'));
  await deliverOne(h, { from: 'a', to: 'inventory', action: 'Release' });
  await toPaid(h, 'b', 2);
  await ok(h.returnCart('b'));
  await deliverOne(h, { from: 'b', to: 'inventory', action: 'Release' });
  await deliverOne(h, { from: 'a', to: 'payments', action: 'Refund' });
  await toPaid(h, 'c', 2);
  await expectStatus(h, 'c', 'paid');
  await expectPayments(h, 4, false);
  await drain(h);
  await expectPayments(h, 2, false);
  await checkConclusion(h, ['a', 'b', 'c']);
});

// ---------------------------------------------------------------------------
// Change 2: retry a declined card
// ---------------------------------------------------------------------------

test('a Declined answer makes the paying cart declined', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await ok(h.declineCards());
  await deliverCharge(h, 'a');
  await deliverPaymentAnswer(h, 'a');
  await expectStatus(h, 'a', 'declined');
});

test('a declined cart keeps its units reserved and sends no Release', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 2);
  await ok(h.declineCards());
  await deliverCharge(h, 'a');
  await deliverPaymentAnswer(h, 'a');
  assert.equal((await msgs(h, { action: 'Release' })).length, 0);
  await expectStock(h, 0, 2);
});

test('a declined cart keeps its units reserved after deliverAll', async () => {
  const h = await createHost();
  await ok(h.declineCards());
  await toReserving(h, 'a', 2);
  await drain(h);
  await expectStatus(h, 'a', 'declined');
  await expectStock(h, 0, 2);
  await expectPayments(h, 0, true);
});

test('units held by a declined cart are not available to another cart', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 2);
  await toReserving(h, 'b', 1);
  await drain(h);
  await expectStatus(h, 'b', 'failed');
  await expectStatus(h, 'a', 'declined');
  await expectStock(h, 0, 2);
});

test('retry makes a declined cart paying', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 1);
  await ok(h.retry('a'));
  await expectStatus(h, 'a', 'paying');
});

test('retry sends exactly one Charge to payments with from and amount equal to the units', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 2);
  await ok(h.retry('a'));
  const ms = await msgs(h, { from: 'a', to: 'payments', action: 'Charge' });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].data.from, 'a');
  assert.equal(ms[0].data.amount, 2);
});

test('retry does not change the stock', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 2);
  await ok(h.retry('a'));
  await expectStock(h, 0, 2);
});

test('a retried charge that goes through makes the cart paid and charges its units', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 2);
  await ok(h.retry('a'));
  await drain(h);
  await expectStatus(h, 'a', 'paid');
  await expectPayments(h, 2, false);
  await expectStock(h, 0, 2);
  await checkConclusion(h, ['a']);
});

test('a retried charge declined again makes the cart declined again', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 1);
  await ok(h.declineCards());
  await ok(h.retry('a'));
  await drain(h);
  await expectStatus(h, 'a', 'declined');
  await expectPayments(h, 0, true);
  await expectStock(h, 1, 1);
});

test('a cart can be retried several times and then paid', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 1);
  await ok(h.declineCards());
  await ok(h.retry('a'));
  await drain(h);
  await ok(h.retry('a'));
  await drain(h);
  await expectStatus(h, 'a', 'declined');
  await ok(h.acceptCards());
  await ok(h.retry('a'));
  await drain(h);
  await expectStatus(h, 'a', 'paid');
  await expectPayments(h, 1, false);
  await checkConclusion(h, ['a']);
});

test('a retried cart is paying until the payment answer is delivered', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 1);
  await ok(h.retry('a'));
  await deliverCharge(h, 'a');
  await expectStatus(h, 'a', 'paying');
});

test('a retried cart that is paid can be returned', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 1);
  await ok(h.retry('a'));
  await drain(h);
  await ok(h.returnCart('a'));
  await drain(h);
  await expectStatus(h, 'a', 'returned');
  await expectStock(h, 2, 0);
  await expectPayments(h, 0, false);
});

test('a retried cart is paying and refuses cancel', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 1);
  await ok(h.retry('a'));
  await assertRefused(h, ['a'], () => h.cancel('a'));
});

for (const st of ALL_STATUSES.filter((s) => s !== 'declined')) {
  test(`retry is refused for a ${st} cart`, async () => {
    const h = await createHost();
    await makeStatus(h, 'a', st);
    await assertRefused(h, ['a', 'zz'], () => h.retry('a'));
  });
}

test('retry on a cart id never opened is refused and creates nothing', async () => {
  const h = await createHost();
  await assertRefused(h, ['x'], () => h.retry('x'));
  assert.equal(await h.cart('x'), null);
});

test('abandon makes a declined cart failed', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 1);
  await ok(h.abandon('a'));
  await expectStatus(h, 'a', 'failed');
});

test('abandon sends exactly one Release to the inventory with the units', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 2);
  await ok(h.abandon('a'));
  const ms = await msgs(h, { from: 'a', to: 'inventory', action: 'Release' });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].data.qty, 2);
});

test('abandon sends no Charge', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 1);
  await ok(h.abandon('a'));
  assert.equal((await msgs(h, { action: 'Charge' })).length, 0);
});

test('abandoned units come back once the Release is delivered', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 2);
  await ok(h.abandon('a'));
  await expectStock(h, 0, 2);
  await deliverOne(h, { from: 'a', to: 'inventory', action: 'Release' });
  await expectStock(h, 2, 0);
  await expectPayments(h, 0, false);
});

test('after abandon another cart can buy the units', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 2);
  await ok(h.abandon('a'));
  await toReserving(h, 'b', 2);
  await drain(h);
  await expectStatus(h, 'b', 'paid');
  await checkConclusion(h, ['a', 'b']);
});

for (const st of ALL_STATUSES.filter((s) => s !== 'declined')) {
  test(`abandon is refused for a ${st} cart`, async () => {
    const h = await createHost();
    await makeStatus(h, 'a', st);
    await assertRefused(h, ['a', 'zz'], () => h.abandon('a'));
  });
}

test('abandon on a cart id never opened is refused and creates nothing', async () => {
  const h = await createHost();
  await assertRefused(h, ['x'], () => h.abandon('x'));
  assert.equal(await h.cart('x'), null);
});

const DECLINED_REFUSED = [
  'add', 'checkout', 'cancel', 'returnCart',
  'paymentTimeout',
];

for (const cmd of DECLINED_REFUSED) {
  test(`a declined cart refuses ${cmd}`, async () => {
    const h = await createHost();
    await makeStatus(h, 'a', 'declined', 1);
    await assertRefused(h, ['a'], () => h[cmd]('a'));
  });
}

for (const cmd of ['retry', 'abandon', 'add', 'checkout', 'cancel']) {
  test(`a cart failed by abandon refuses ${cmd}`, async () => {
    const h = await createHost();
    await makeStatus(h, 'a', 'declined', 1);
    await ok(h.abandon('a'));
    await drain(h);
    await assertRefused(h, ['a'], () => h[cmd]('a'));
  });
}

test('conclusion: a declined cart holds its units, uncharged, once nothing is in flight', async () => {
  const h = await createHost();
  await toReserving(h, 'a', 1);
  await ok(h.declineCards());
  await toReserving(h, 'b', 1);
  await drain(h);
  await expectStatus(h, 'a', 'declined');
  await expectStatus(h, 'b', 'declined');
  await expectStock(h, 0, 2);
  await expectPayments(h, 0, true);
  await checkConclusion(h, ['a', 'b']);
});

test('conclusion: one declined cart retried and paid, the other abandoned', async () => {
  const h = await createHost();
  await ok(h.declineCards());
  await toReserving(h, 'a', 1);
  await toReserving(h, 'b', 1);
  await drain(h);
  await ok(h.acceptCards());
  await ok(h.retry('a'));
  await ok(h.abandon('b'));
  await drain(h);
  await expectStatus(h, 'a', 'paid');
  await expectStatus(h, 'b', 'failed');
  await expectStock(h, 1, 1);
  await expectPayments(h, 1, false);
  await checkConclusion(h, ['a', 'b']);
});

// ---------------------------------------------------------------------------
// Change 3: give up on a slow payment
// ---------------------------------------------------------------------------

test('paymentTimeout makes a paying cart abandoning', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await ok(h.paymentTimeout('a'));
  await expectStatus(h, 'a', 'abandoning');
});

test('paymentTimeout gives the units back without waiting for the payment answer', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 2);
  await ok(h.paymentTimeout('a'));
  await deliverAllTo(h, 'inventory');
  await expectStock(h, 2, 0);
  await expectStatus(h, 'a', 'abandoning');
  assert.equal((await msgs(h, { from: 'a', to: 'payments', action: 'Charge' })).length, 1);
});

test('paymentTimeout after the Charge was delivered also gives the units back before the answer', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await deliverCharge(h, 'a');
  await ok(h.paymentTimeout('a'));
  await deliverAllTo(h, 'inventory');
  await expectStock(h, 2, 0);
  await expectStatus(h, 'a', 'abandoning');
});

test('an abandoning cart stays abandoning until the payment service answers', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await ok(h.paymentTimeout('a'));
  await deliverAllTo(h, 'inventory');
  await deliverCharge(h, 'a');
  await expectStatus(h, 'a', 'abandoning');
});

test('a Charged answer makes an abandoning cart failed', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await ok(h.paymentTimeout('a'));
  await deliverCharge(h, 'a');
  await deliverOne(h, { from: 'payments', to: 'a', action: 'Charged' });
  await expectStatus(h, 'a', 'failed');
});

test('a Charged answer to an abandoning cart sends one Refund with its units', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 2);
  await ok(h.paymentTimeout('a'));
  await deliverCharge(h, 'a');
  await deliverOne(h, { from: 'payments', to: 'a', action: 'Charged' });
  const ms = await msgs(h, { from: 'a', to: 'payments', action: 'Refund' });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].data.amount, 2);
});

test('the late charge of an abandoning cart is refunded once the Refund is delivered', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 2);
  await ok(h.paymentTimeout('a'));
  await deliverCharge(h, 'a');
  await expectPayments(h, 2, false);
  await deliverOne(h, { from: 'payments', to: 'a', action: 'Charged' });
  await deliverOne(h, { from: 'a', to: 'payments', action: 'Refund' });
  await expectPayments(h, 0, false);
});

test('a Declined answer makes an abandoning cart failed', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await ok(h.paymentTimeout('a'));
  await ok(h.declineCards());
  await deliverCharge(h, 'a');
  await deliverOne(h, { from: 'payments', to: 'a', action: 'Declined' });
  await expectStatus(h, 'a', 'failed');
});

test('a Declined answer to an abandoning cart sends no Refund and no second Release', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await ok(h.paymentTimeout('a'));
  await deliverAllTo(h, 'inventory');
  await ok(h.declineCards());
  await deliverCharge(h, 'a');
  await deliverOne(h, { from: 'payments', to: 'a', action: 'Declined' });
  assert.equal((await msgs(h, { from: 'a' })).length, 0);
  await expectPayments(h, 0, true);
  await expectStock(h, 2, 0);
});

test('after a timeout and a late Charged, deliverAll leaves nothing reserved or charged', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 2);
  await ok(h.paymentTimeout('a'));
  await drain(h);
  await expectStatus(h, 'a', 'failed');
  await expectStock(h, 2, 0);
  await expectPayments(h, 0, false);
  await checkConclusion(h, ['a']);
});

test('after a timeout and a late Declined, deliverAll leaves nothing reserved or charged', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 2);
  await ok(h.paymentTimeout('a'));
  await ok(h.declineCards());
  await drain(h);
  await expectStatus(h, 'a', 'failed');
  await expectStock(h, 2, 0);
  await expectPayments(h, 0, true);
  await checkConclusion(h, ['a']);
});

test('a timeout after the charge went through but before its answer ends refunded', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await deliverCharge(h, 'a');
  await ok(h.paymentTimeout('a'));
  await drain(h);
  await expectStatus(h, 'a', 'failed');
  await expectStock(h, 2, 0);
  await expectPayments(h, 0, false);
});

const ABANDONING_REFUSED = ['add', 'checkout', 'cancel', 'returnCart', 'retry', 'abandon', 'paymentTimeout'];

for (const cmd of ABANDONING_REFUSED) {
  test(`an abandoning cart refuses ${cmd}`, async () => {
    const h = await createHost();
    await makeStatus(h, 'a', 'abandoning', 1);
    await assertRefused(h, ['a'], () => h[cmd]('a'));
  });
}

for (const st of ALL_STATUSES.filter((s) => s !== 'paying')) {
  test(`paymentTimeout is refused for a ${st} cart`, async () => {
    const h = await createHost();
    await makeStatus(h, 'a', st);
    await assertRefused(h, ['a', 'zz'], () => h.paymentTimeout('a'));
  });
}

test('paymentTimeout on a cart id never opened is refused and creates nothing', async () => {
  const h = await createHost();
  await assertRefused(h, ['x'], () => h.paymentTimeout('x'));
  assert.equal(await h.cart('x'), null);
});

for (const cmd of ['retry', 'abandon', 'paymentTimeout', 'returnCart', 'cancel']) {
  test(`a cart failed after abandoning refuses ${cmd}`, async () => {
    const h = await createHost();
    await toPaying(h, 'a', 1);
    await ok(h.paymentTimeout('a'));
    await drain(h);
    await assertRefused(h, ['a'], () => h[cmd]('a'));
  });
}

test('paymentTimeout works on a cart paying again after retry', async () => {
  const h = await createHost();
  await makeStatus(h, 'a', 'declined', 1);
  await ok(h.retry('a'));
  await ok(h.paymentTimeout('a'));
  await expectStatus(h, 'a', 'abandoning');
  await ok(h.declineCards());
  await drain(h);
  await expectStatus(h, 'a', 'failed');
  await expectStock(h, 2, 0);
  await expectPayments(h, 0, true);
});

test('units given back by a timeout can be bought by another cart before the late answer', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 2);
  await ok(h.paymentTimeout('a'));
  await deliverAllTo(h, 'inventory');
  await toPaid(h, 'b', 2);
  await expectStatus(h, 'b', 'paid');
  await expectStatus(h, 'a', 'abandoning');
  await drain(h);
  await expectStatus(h, 'a', 'failed');
  await expectStatus(h, 'b', 'paid');
  await expectStock(h, 0, 2);
  await expectPayments(h, 2, false);
  await checkConclusion(h, ['a', 'b']);
});

test('late charges of timed-out carts count toward the limit of 4', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 2);
  await ok(h.paymentTimeout('a'));
  await deliverAllTo(h, 'inventory');
  await toPaying(h, 'b', 2);
  await ok(h.paymentTimeout('b'));
  await deliverAllTo(h, 'inventory');
  await toPaying(h, 'c', 2);
  await deliverCharge(h, 'a');
  await deliverCharge(h, 'b');
  await expectPayments(h, 4, false);
  await deliverCharge(h, 'c');
  const ans = await msgs(h, { from: 'payments', to: 'c' });
  assert.equal(ans.length, 1);
  assert.equal(ans[0].action, 'Declined');
  await expectPayments(h, 4, false);
  await drain(h);
  await expectStatus(h, 'a', 'failed');
  await expectStatus(h, 'b', 'failed');
  await expectStatus(h, 'c', 'declined');
  await expectPayments(h, 0, false);
  await expectStock(h, 0, 2);
  await checkConclusion(h, ['a', 'b', 'c']);
});

test('a timeout on one cart leaves another paying cart alone', async () => {
  const h = await createHost();
  await toPaying(h, 'a', 1);
  await toPaying(h, 'b', 1);
  await ok(h.paymentTimeout('a'));
  await expectStatus(h, 'b', 'paying');
  await drain(h);
  await expectStatus(h, 'a', 'failed');
  await expectStatus(h, 'b', 'paid');
  await expectStock(h, 1, 1);
  await expectPayments(h, 1, false);
  await checkConclusion(h, ['a', 'b']);
});

// ---------------------------------------------------------------------------
// The conclusion over arbitrary sequences of commands and deliveries
// ---------------------------------------------------------------------------

for (const seed of [1, 2, 3, 7, 11, 42, 99, 123, 2024, 31337]) {
  test(`conclusion holds after a random run of commands and deliveries (seed ${seed})`, async () => {
    const h = await createHost();
    await randomRun(h, seed, 120);
  });
}
