// T2 — orders and inventory: end-to-end suite through the host interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { default: createHost } = await import(pathToFileURL(process.env.M3_IMPL).href);

// ---------- helpers (test-side only) ----------

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}

function msgKey(m) {
  return JSON.stringify(canon({ from: m.from, to: m.to, action: m.action, data: m.data }));
}

async function snapshot(h, ids) {
  const stock = canon(await h.stock());
  const orders = {};
  for (const id of ids) orders[id] = canon(await h.order(id));
  const msgs = (await h.inFlight()).map(msgKey).sort();
  return JSON.stringify({ stock, orders, msgs });
}

function matches(m, q) {
  if (q.from !== undefined && m.from !== q.from) return false;
  if (q.to !== undefined && m.to !== q.to) return false;
  if (q.action !== undefined && m.action !== q.action) return false;
  if (q.data) {
    if (!m.data || typeof m.data !== 'object') return false;
    for (const k of Object.keys(q.data)) if (m.data[k] !== q.data[k]) return false;
  }
  return true;
}

async function findMsgs(h, q) {
  return (await h.inFlight()).filter((m) => matches(m, q));
}

async function deliverOne(h, q) {
  const ms = await findMsgs(h, q);
  assert.ok(ms.length >= 1, `expected a message in flight matching ${JSON.stringify(q)}`);
  await h.deliver(ms[0].id);
}

const reserveOf = (id, qty) => ({ from: id, to: 'inventory', action: 'Reserve', data: { from: id, qty } });
const reservedTo = (id) => ({ from: 'inventory', to: id, action: 'Reserved' });
const outOfStockTo = (id) => ({ from: 'inventory', to: id, action: 'OutOfStock' });
const releaseOf = (id, qty) =>
  qty === undefined
    ? { from: id, to: 'inventory', action: 'Release' }
    : { from: id, to: 'inventory', action: 'Release', data: { qty } };

async function status(h, id) {
  const v = await h.order(id);
  return v === null ? null : v.status;
}

async function restockTimes(h, n) {
  for (let i = 0; i < n; i++) {
    const r = await h.restock();
    assert.equal(r.ok, true);
  }
}

// place an order and deliver its Reserve and the answer, expecting confirmation
async function confirm(h, id, qty) {
  const r = await h.place(id, qty);
  assert.equal(r.ok, true);
  await deliverOne(h, reserveOf(id, qty));
  await deliverOne(h, reservedTo(id));
  assert.equal(await status(h, id), 'confirmed');
}

// place an order and deliver its Reserve and the answer, expecting rejection
async function reject(h, id, qty) {
  const r = await h.place(id, qty);
  assert.equal(r.ok, true);
  await deliverOne(h, reserveOf(id, qty));
  await deliverOne(h, outOfStockTo(id));
  assert.equal(await status(h, id), 'rejected');
}

async function confirmedSum(h, ids) {
  let s = 0;
  for (const id of ids) {
    const v = await h.order(id);
    if (v && v.status === 'confirmed') s += v.qty;
  }
  return s;
}

async function assertConclusion(h, ids, total) {
  assert.equal((await h.inFlight()).length, 0);
  const st = await h.stock();
  assert.equal(st.reserved, await confirmedSum(h, ids));
  assert.equal(st.available + st.reserved, total);
  assert.ok(st.available >= 0);
}

// deliver one message at a time, choosing with pick, checking invariants after each step
async function stepDrain(h, ids, total, pick) {
  for (let guard = 0; guard < 200; guard++) {
    const ms = await h.inFlight();
    if (ms.length === 0) return;
    await h.deliver(pick(ms).id);
    const st = await h.stock();
    assert.ok(st.available >= 0);
    assert.ok(st.reserved >= 0);
    assert.equal(st.available + st.reserved, total);
    assert.ok(st.reserved >= (await confirmedSum(h, ids)), 'a confirmed order must have its units reserved');
  }
  assert.fail('messages never drained');
}

// ======================================================================
// Initial state
// ======================================================================

test('initial stock is 1 available and 0 reserved', async () => {
  const h = await createHost();
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 0);
});

test('initially no message is in flight', async () => {
  const h = await createHost();
  assert.equal((await h.inFlight()).length, 0);
});

test('order() returns null for an id never placed', async () => {
  const h = await createHost();
  assert.equal(await h.order('nope'), null);
});

test('deliverAll on an empty network changes nothing', async () => {
  const h = await createHost();
  await h.deliverAll();
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 0);
  assert.equal((await h.inFlight()).length, 0);
});

// ======================================================================
// restock
// ======================================================================

test('restock adds one available unit', async () => {
  const h = await createHost();
  const r = await h.restock();
  assert.equal(r.ok, true);
  const st = await h.stock();
  assert.equal(st.available, 2);
  assert.equal(st.reserved, 0);
});

test('restock twice reaches 3 available units', async () => {
  const h = await createHost();
  assert.equal((await h.restock()).ok, true);
  assert.equal((await h.restock()).ok, true);
  const st = await h.stock();
  assert.equal(st.available, 3);
  assert.equal(st.reserved, 0);
});

test('restock is refused when the inventory holds 3 units', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  const r = await h.restock();
  assert.equal(r.ok, false);
});

test('refused restock changes nothing', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  const before = await snapshot(h, []);
  await h.restock();
  assert.equal(await snapshot(h, []), before);
  assert.equal((await h.stock()).available, 3);
});

test('restock sends no message', async () => {
  const h = await createHost();
  await h.restock();
  assert.equal((await h.inFlight()).length, 0);
});

test('reserved units count toward the 3-unit limit', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1); // available 0, reserved 1
  assert.equal((await h.restock()).ok, true); // 2 in all
  assert.equal((await h.restock()).ok, true); // 3 in all
  const st = await h.stock();
  assert.equal(st.available, 2);
  assert.equal(st.reserved, 1);
  assert.equal((await h.restock()).ok, false);
});

test('restock refused at 3 units when 2 are reserved', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await confirm(h, 'A', 2);
  const before = await snapshot(h, ['A']);
  assert.equal((await h.restock()).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('restock still refused at 3 units after an order releases its units', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await confirm(h, 'A', 2);
  assert.equal((await h.cancel('A')).ok, true);
  await h.deliverAll();
  const st = await h.stock();
  assert.equal(st.available, 3);
  assert.equal(st.reserved, 0);
  assert.equal((await h.restock()).ok, false);
});

test('restock allowed again below 3 units after a reservation is made', async () => {
  const h = await createHost();
  await restockTimes(h, 1); // 2 available
  await confirm(h, 'A', 1); // 1 available, 1 reserved
  assert.equal((await h.restock()).ok, true);
  const st = await h.stock();
  assert.equal(st.available, 2);
  assert.equal(st.reserved, 1);
});

// ======================================================================
// place
// ======================================================================

test('place returns ok', async () => {
  const h = await createHost();
  assert.equal((await h.place('A', 1)).ok, true);
});

test('placed order is pending with its qty 1', async () => {
  const h = await createHost();
  await h.place('A', 1);
  const v = await h.order('A');
  assert.equal(v.status, 'pending');
  assert.equal(v.qty, 1);
});

test('placed order is pending with its qty 2', async () => {
  const h = await createHost();
  await h.place('A', 2);
  const v = await h.order('A');
  assert.equal(v.status, 'pending');
  assert.equal(v.qty, 2);
});

test('place sends Reserve from the order to the inventory with from and qty', async () => {
  const h = await createHost();
  await h.place('A', 1);
  const ms = await findMsgs(h, { from: 'A', to: 'inventory', action: 'Reserve' });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].data.from, 'A');
  assert.equal(ms[0].data.qty, 1);
});

test('place qty 2 sends Reserve with qty 2', async () => {
  const h = await createHost();
  await h.place('B', 2);
  const ms = await findMsgs(h, reserveOf('B', 2));
  assert.equal(ms.length, 1);
});

test('place sends exactly one message', async () => {
  const h = await createHost();
  await h.place('A', 1);
  assert.equal((await h.inFlight()).length, 1);
});

test('place does not change stock before Reserve is delivered', async () => {
  const h = await createHost();
  await h.place('A', 1);
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 0);
});

test('place with a pending order id is refused', async () => {
  const h = await createHost();
  await h.place('A', 1);
  assert.equal((await h.place('A', 2)).ok, false);
});

test('refused duplicate place changes nothing (order, stock, messages)', async () => {
  const h = await createHost();
  await h.place('A', 1);
  const before = await snapshot(h, ['A']);
  await h.place('A', 2);
  assert.equal(await snapshot(h, ['A']), before);
  const v = await h.order('A');
  assert.equal(v.qty, 1);
  assert.equal(v.status, 'pending');
});

test('place with a confirmed order id is refused', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  const before = await snapshot(h, ['A']);
  assert.equal((await h.place('A', 1)).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('place with a rejected order id is refused', async () => {
  const h = await createHost();
  await reject(h, 'A', 2);
  const before = await snapshot(h, ['A']);
  assert.equal((await h.place('A', 1)).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('place with a cancelled order id is refused', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.cancel('A');
  await h.deliverAll();
  const before = await snapshot(h, ['A']);
  assert.equal((await h.place('A', 1)).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('place with a cancelling order id is refused', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.cancel('A');
  const before = await snapshot(h, ['A']);
  assert.equal((await h.place('A', 1)).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('two orders with different ids can both be placed', async () => {
  const h = await createHost();
  assert.equal((await h.place('A', 1)).ok, true);
  assert.equal((await h.place('B', 2)).ok, true);
  assert.equal(await status(h, 'A'), 'pending');
  assert.equal(await status(h, 'B'), 'pending');
  assert.equal((await findMsgs(h, reserveOf('A', 1))).length, 1);
  assert.equal((await findMsgs(h, reserveOf('B', 2))).length, 1);
});

test('placing does not create other orders', async () => {
  const h = await createHost();
  await h.place('A', 1);
  assert.equal(await h.order('B'), null);
});

// ======================================================================
// Reserve / Reserved / OutOfStock
// ======================================================================

test('delivering Reserve with enough available moves units to reserved', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await deliverOne(h, reserveOf('A', 1));
  const st = await h.stock();
  assert.equal(st.available, 0);
  assert.equal(st.reserved, 1);
});

test('delivering Reserve for 2 with 2 available reserves 2', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await h.place('A', 2);
  await deliverOne(h, reserveOf('A', 2));
  const st = await h.stock();
  assert.equal(st.available, 0);
  assert.equal(st.reserved, 2);
});

test('inventory answers Reserved to the order after reserving', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await deliverOne(h, reserveOf('A', 1));
  assert.equal((await findMsgs(h, reservedTo('A'))).length, 1);
  assert.equal((await findMsgs(h, outOfStockTo('A'))).length, 0);
});

test('Reserve is no longer in flight once delivered', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await deliverOne(h, reserveOf('A', 1));
  assert.equal((await findMsgs(h, { action: 'Reserve' })).length, 0);
});

test('order stays pending after Reserve is delivered and before the answer arrives', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await deliverOne(h, reserveOf('A', 1));
  assert.equal(await status(h, 'A'), 'pending');
});

test('delivering Reserved confirms a pending order', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await deliverOne(h, reserveOf('A', 1));
  await deliverOne(h, reservedTo('A'));
  const v = await h.order('A');
  assert.equal(v.status, 'confirmed');
  assert.equal(v.qty, 1);
});

test('confirmed order of 2 keeps qty 2', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await confirm(h, 'A', 2);
  assert.equal((await h.order('A')).qty, 2);
});

test('delivering Reserved leaves stock as reserved', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  const st = await h.stock();
  assert.equal(st.available, 0);
  assert.equal(st.reserved, 1);
  assert.equal((await h.inFlight()).length, 0);
});

test('Reserve for more than available is answered OutOfStock', async () => {
  const h = await createHost();
  await h.place('A', 2);
  await deliverOne(h, reserveOf('A', 2));
  assert.equal((await findMsgs(h, outOfStockTo('A'))).length, 1);
  assert.equal((await findMsgs(h, reservedTo('A'))).length, 0);
});

test('OutOfStock answer changes no stock', async () => {
  const h = await createHost();
  await h.place('A', 2);
  await deliverOne(h, reserveOf('A', 2));
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 0);
});

test('Reserve with no units available is answered OutOfStock', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.place('B', 1);
  await deliverOne(h, reserveOf('B', 1));
  assert.equal((await findMsgs(h, outOfStockTo('B'))).length, 1);
  const st = await h.stock();
  assert.equal(st.available, 0);
  assert.equal(st.reserved, 1);
});

test('delivering OutOfStock rejects a pending order', async () => {
  const h = await createHost();
  await h.place('A', 2);
  await deliverOne(h, reserveOf('A', 2));
  await deliverOne(h, outOfStockTo('A'));
  const v = await h.order('A');
  assert.equal(v.status, 'rejected');
  assert.equal(v.qty, 2);
});

test('rejected order leaves stock untouched and nothing in flight', async () => {
  const h = await createHost();
  await reject(h, 'A', 2);
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 0);
  assert.equal((await h.inFlight()).length, 0);
});

test('a rejected order sends no Release', async () => {
  const h = await createHost();
  await reject(h, 'A', 2);
  assert.equal((await findMsgs(h, { action: 'Release' })).length, 0);
});

test('availability is checked when Reserve arrives, not when placed (restock in between)', async () => {
  const h = await createHost();
  await h.place('A', 2); // only 1 available now
  await h.restock(); // 2 available
  await deliverOne(h, reserveOf('A', 2));
  await deliverOne(h, reservedTo('A'));
  assert.equal(await status(h, 'A'), 'confirmed');
  const st = await h.stock();
  assert.equal(st.available, 0);
  assert.equal(st.reserved, 2);
});

test('availability is checked when Reserve arrives (other order reserved first)', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await confirm(h, 'B', 1);
  await deliverOne(h, reserveOf('A', 1));
  await deliverOne(h, outOfStockTo('A'));
  assert.equal(await status(h, 'A'), 'rejected');
  assert.equal(await status(h, 'B'), 'confirmed');
});

// ======================================================================
// Ordering between orders
// ======================================================================

test('two orders for the last unit: B reserve delivered first wins', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.place('B', 1);
  await deliverOne(h, reserveOf('B', 1));
  await deliverOne(h, reserveOf('A', 1));
  assert.equal((await findMsgs(h, reservedTo('B'))).length, 1);
  assert.equal((await findMsgs(h, outOfStockTo('A'))).length, 1);
  await h.deliverAll();
  assert.equal(await status(h, 'B'), 'confirmed');
  assert.equal(await status(h, 'A'), 'rejected');
  await assertConclusion(h, ['A', 'B'], 1);
});

test('two orders for the last unit: A reserve delivered first wins', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.place('B', 1);
  await deliverOne(h, reserveOf('A', 1));
  await deliverOne(h, reserveOf('B', 1));
  await h.deliverAll();
  assert.equal(await status(h, 'A'), 'confirmed');
  assert.equal(await status(h, 'B'), 'rejected');
  await assertConclusion(h, ['A', 'B'], 1);
});

test('small order delivered first takes the unit a large order needed', async () => {
  const h = await createHost();
  await restockTimes(h, 1); // 2 available
  await h.place('BIG', 2);
  await h.place('SMALL', 1);
  await deliverOne(h, reserveOf('SMALL', 1));
  await deliverOne(h, reserveOf('BIG', 2));
  await h.deliverAll();
  assert.equal(await status(h, 'SMALL'), 'confirmed');
  assert.equal(await status(h, 'BIG'), 'rejected');
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 1);
});

test('large order delivered first leaves nothing for the small order', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await h.place('BIG', 2);
  await h.place('SMALL', 1);
  await deliverOne(h, reserveOf('BIG', 2));
  await deliverOne(h, reserveOf('SMALL', 1));
  await h.deliverAll();
  assert.equal(await status(h, 'BIG'), 'confirmed');
  assert.equal(await status(h, 'SMALL'), 'rejected');
  const st = await h.stock();
  assert.equal(st.available, 0);
  assert.equal(st.reserved, 2);
});

test('answers may arrive in a different order from the reserves', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await h.place('A', 1);
  await h.place('B', 1);
  await deliverOne(h, reserveOf('A', 1));
  await deliverOne(h, reserveOf('B', 1));
  await deliverOne(h, reservedTo('B'));
  assert.equal(await status(h, 'B'), 'confirmed');
  assert.equal(await status(h, 'A'), 'pending');
  await deliverOne(h, reservedTo('A'));
  assert.equal(await status(h, 'A'), 'confirmed');
});

test('a Reserved answer delivered after unrelated commands still confirms', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await deliverOne(h, reserveOf('A', 1));
  await reject(h, 'B', 1);
  await h.restock();
  await deliverOne(h, reservedTo('A'));
  assert.equal(await status(h, 'A'), 'confirmed');
});

test('deliverAll confirms an order that fits', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.deliverAll();
  assert.equal(await status(h, 'A'), 'confirmed');
  assert.equal((await h.inFlight()).length, 0);
});

test('deliverAll rejects an order that does not fit', async () => {
  const h = await createHost();
  await h.place('A', 2);
  await h.deliverAll();
  assert.equal(await status(h, 'A'), 'rejected');
  assert.equal((await h.inFlight()).length, 0);
});

test('deliverAll delivers follow-up messages until none is left', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.cancel('A');
  await h.deliverAll(); // Reserve -> Reserved -> Release
  assert.equal((await h.inFlight()).length, 0);
  assert.equal(await status(h, 'A'), 'cancelled');
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 0);
});

// ======================================================================
// cancel
// ======================================================================

test('cancel a confirmed order returns ok and it becomes cancelled', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  assert.equal((await h.cancel('A')).ok, true);
  const v = await h.order('A');
  assert.equal(v.status, 'cancelled');
  assert.equal(v.qty, 1);
});

test('cancel a confirmed order sends Release with its qty', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.cancel('A');
  const ms = await findMsgs(h, releaseOf('A'));
  assert.equal(ms.length, 1);
  assert.equal(ms[0].data.qty, 1);
});

test('cancel a confirmed order of 2 sends Release with qty 2', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await confirm(h, 'A', 2);
  await h.cancel('A');
  assert.equal((await findMsgs(h, releaseOf('A', 2))).length, 1);
});

test('stock is unchanged until the Release is delivered', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.cancel('A');
  const st = await h.stock();
  assert.equal(st.available, 0);
  assert.equal(st.reserved, 1);
});

test('delivering Release moves units from reserved to available', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.cancel('A');
  await deliverOne(h, releaseOf('A', 1));
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 0);
  assert.equal((await h.inFlight()).length, 0);
});

test('delivering Release of 2 returns 2 units', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await confirm(h, 'A', 2);
  await h.cancel('A');
  await deliverOne(h, releaseOf('A', 2));
  const st = await h.stock();
  assert.equal(st.available, 2);
  assert.equal(st.reserved, 0);
});

test('cancelled order stays cancelled after its Release is delivered', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.cancel('A');
  await h.deliverAll();
  assert.equal(await status(h, 'A'), 'cancelled');
});

test('released units can be reserved by another order', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.cancel('A');
  await h.deliverAll();
  await confirm(h, 'B', 1);
  const st = await h.stock();
  assert.equal(st.available, 0);
  assert.equal(st.reserved, 1);
});

test('a Reserve arriving before a pending Release is delivered is OutOfStock', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.cancel('A');
  await h.place('B', 1);
  await deliverOne(h, reserveOf('B', 1));
  await deliverOne(h, outOfStockTo('B'));
  assert.equal(await status(h, 'B'), 'rejected');
  await h.deliverAll();
  await assertConclusion(h, ['A', 'B'], 1);
});

test('a Reserve arriving after the Release is delivered gets the unit', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.cancel('A');
  await h.place('B', 1);
  await deliverOne(h, releaseOf('A', 1));
  await deliverOne(h, reserveOf('B', 1));
  await deliverOne(h, reservedTo('B'));
  assert.equal(await status(h, 'B'), 'confirmed');
  await assertConclusion(h, ['A', 'B'], 1);
});

test('cancel a pending order returns ok and it becomes cancelling', async () => {
  const h = await createHost();
  await h.place('A', 1);
  assert.equal((await h.cancel('A')).ok, true);
  const v = await h.order('A');
  assert.equal(v.status, 'cancelling');
  assert.equal(v.qty, 1);
});

test('cancel a pending order sends no Release', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.cancel('A');
  assert.equal((await findMsgs(h, { action: 'Release' })).length, 0);
});

test('cancel a pending order leaves its Reserve in flight and stock unchanged', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.cancel('A');
  assert.equal((await findMsgs(h, reserveOf('A', 1))).length, 1);
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 0);
});

test('cancelling order becomes cancelled when Reserved arrives', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.cancel('A');
  await deliverOne(h, reserveOf('A', 1));
  await deliverOne(h, reservedTo('A'));
  assert.equal(await status(h, 'A'), 'cancelled');
});

test('cancelling order sends Release of its qty when Reserved arrives', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.cancel('A');
  await deliverOne(h, reserveOf('A', 1));
  await deliverOne(h, reservedTo('A'));
  assert.equal((await findMsgs(h, releaseOf('A', 1))).length, 1);
});

test('cancelling order of 2 releases 2 when Reserved arrives', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await h.place('A', 2);
  await h.cancel('A');
  await deliverOne(h, reserveOf('A', 2));
  await deliverOne(h, reservedTo('A'));
  assert.equal((await findMsgs(h, releaseOf('A', 2))).length, 1);
  await deliverOne(h, releaseOf('A', 2));
  const st = await h.stock();
  assert.equal(st.available, 2);
  assert.equal(st.reserved, 0);
});

test('cancelling order is never confirmed: Reserved leads straight to cancelled', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.cancel('A');
  await h.deliverAll();
  assert.equal(await status(h, 'A'), 'cancelled');
  await assertConclusion(h, ['A'], 1);
});

test('cancelling order becomes cancelled when OutOfStock arrives', async () => {
  const h = await createHost();
  await h.place('A', 2);
  await h.cancel('A');
  await deliverOne(h, reserveOf('A', 2));
  await deliverOne(h, outOfStockTo('A'));
  assert.equal(await status(h, 'A'), 'cancelled');
});

test('cancelling order sends no Release when OutOfStock arrives', async () => {
  const h = await createHost();
  await h.place('A', 2);
  await h.cancel('A');
  await deliverOne(h, reserveOf('A', 2));
  await deliverOne(h, outOfStockTo('A'));
  assert.equal((await h.inFlight()).length, 0);
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 0);
});

test('cancel after Reserve delivered but before the answer: units come back', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await deliverOne(h, reserveOf('A', 1));
  assert.equal((await h.cancel('A')).ok, true);
  assert.equal(await status(h, 'A'), 'cancelling');
  const mid = await h.stock();
  assert.equal(mid.reserved, 1);
  await h.deliverAll();
  assert.equal(await status(h, 'A'), 'cancelled');
  await assertConclusion(h, ['A'], 1);
});

test('cancel refused for a cancelling order and changes nothing', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.cancel('A');
  const before = await snapshot(h, ['A']);
  assert.equal((await h.cancel('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('cancel refused for a cancelled order and changes nothing', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.cancel('A');
  const before = await snapshot(h, ['A']);
  assert.equal((await h.cancel('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
  assert.equal((await findMsgs(h, { action: 'Release' })).length, 1);
});

test('cancel refused for a cancelled order after its Release was delivered', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.cancel('A');
  await h.deliverAll();
  const before = await snapshot(h, ['A']);
  assert.equal((await h.cancel('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('cancel refused for a rejected order and changes nothing', async () => {
  const h = await createHost();
  await reject(h, 'A', 2);
  const before = await snapshot(h, ['A']);
  assert.equal((await h.cancel('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('cancel refused for an id never placed and changes nothing', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  const before = await snapshot(h, ['A', 'ghost']);
  assert.equal((await h.cancel('ghost')).ok, false);
  assert.equal(await snapshot(h, ['A', 'ghost']), before);
  assert.equal(await h.order('ghost'), null);
});

test('cancel on a fresh system with no orders is refused', async () => {
  const h = await createHost();
  assert.equal((await h.cancel('A')).ok, false);
  assert.equal(await h.order('A'), null);
  assert.equal((await h.inFlight()).length, 0);
});

test('cancelling one order does not affect another', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await confirm(h, 'A', 1);
  await confirm(h, 'B', 1);
  await h.cancel('A');
  await h.deliverAll();
  assert.equal(await status(h, 'B'), 'confirmed');
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 1);
});

// ======================================================================
// Conclusion: units never lost or invented
// ======================================================================

test('conclusion: placing and deliverAll keeps reserved equal to confirmed units', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await h.place('A', 2);
  await h.place('B', 2);
  await h.place('C', 1);
  await h.deliverAll();
  await assertConclusion(h, ['A', 'B', 'C'], 3);
});

test('conclusion: mixed cancels of pending and confirmed orders, deliverAll', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await confirm(h, 'A', 1);
  await h.place('B', 2);
  await h.place('C', 1);
  await h.cancel('A');
  await h.cancel('B');
  await deliverOne(h, reserveOf('B', 2));
  await h.place('D', 2);
  await h.deliverAll();
  await assertConclusion(h, ['A', 'B', 'C', 'D'], 3);
  assert.equal(await status(h, 'A'), 'cancelled');
  assert.equal(await status(h, 'B'), 'cancelled');
});

test('conclusion: delivering in listed order step by step keeps invariants', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await h.place('A', 1);
  await h.place('B', 2);
  await h.place('C', 1);
  await h.cancel('B');
  await stepDrain(h, ['A', 'B', 'C'], 2, (ms) => ms[0]);
  await assertConclusion(h, ['A', 'B', 'C'], 2);
});

test('conclusion: delivering in reverse listed order step by step keeps invariants', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await h.place('A', 1);
  await h.place('B', 2);
  await h.place('C', 1);
  await h.cancel('B');
  await stepDrain(h, ['A', 'B', 'C'], 2, (ms) => ms[ms.length - 1]);
  await assertConclusion(h, ['A', 'B', 'C'], 2);
});

test('conclusion: cancel every order mid-flight returns all units', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await h.place('A', 1);
  await h.place('B', 2);
  await deliverOne(h, reserveOf('A', 1));
  await h.cancel('A');
  await h.cancel('B');
  await h.deliverAll();
  await assertConclusion(h, ['A', 'B'], 3);
  const st = await h.stock();
  assert.equal(st.available, 3);
  assert.equal(st.reserved, 0);
});

test('conclusion: cancelled orders after replies hold nothing', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await confirm(h, 'A', 2);
  await confirm(h, 'B', 1);
  await h.cancel('A');
  await h.cancel('B');
  await h.deliverAll();
  const st = await h.stock();
  assert.equal(st.available, 3);
  assert.equal(st.reserved, 0);
  await assertConclusion(h, ['A', 'B'], 3);
});

test('conclusion: interleaving restock, place and cancel with step delivery', async () => {
  const h = await createHost();
  await h.place('A', 2);
  await h.place('B', 1);
  await deliverOne(h, reserveOf('B', 1));
  await h.restock();
  await h.restock();
  await h.cancel('B');
  await stepDrain(h, ['A', 'B'], 3, (ms) => ms[ms.length - 1]);
  await h.place('C', 2);
  await h.place('D', 1);
  await stepDrain(h, ['A', 'B', 'C', 'D'], 3, (ms) => ms[0]);
  await assertConclusion(h, ['A', 'B', 'C', 'D'], 3);
});

test('conclusion: a confirmed order always has its units reserved', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  for (const [id, q] of [['A', 2], ['B', 1], ['C', 1], ['D', 2]]) await h.place(id, q);
  await stepDrain(h, ['A', 'B', 'C', 'D'], 3, (ms) => ms[Math.floor(ms.length / 2)]);
  await assertConclusion(h, ['A', 'B', 'C', 'D'], 3);
});

// ======================================================================
// Change 1: expire
// ======================================================================

test('expire a confirmed order returns ok and it becomes expired', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  assert.equal((await h.expire('A')).ok, true);
  const v = await h.order('A');
  assert.equal(v.status, 'expired');
  assert.equal(v.qty, 1);
});

test('expired order of 2 keeps qty 2 in the view', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await confirm(h, 'A', 2);
  await h.expire('A');
  const v = await h.order('A');
  assert.equal(v.status, 'expired');
  assert.equal(v.qty, 2);
});

test('expire sends Release from the order to the inventory with its qty', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.expire('A');
  const ms = await findMsgs(h, releaseOf('A'));
  assert.equal(ms.length, 1);
  assert.equal(ms[0].data.qty, 1);
});

test('expire of an order of 2 sends Release with qty 2', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await confirm(h, 'A', 2);
  await h.expire('A');
  assert.equal((await findMsgs(h, releaseOf('A', 2))).length, 1);
});

test('expire leaves stock unchanged until the Release is delivered', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.expire('A');
  const st = await h.stock();
  assert.equal(st.available, 0);
  assert.equal(st.reserved, 1);
});

test('expired units return to available when the Release is delivered', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await confirm(h, 'A', 2);
  await h.expire('A');
  await deliverOne(h, releaseOf('A', 2));
  const st = await h.stock();
  assert.equal(st.available, 2);
  assert.equal(st.reserved, 0);
  assert.equal(await status(h, 'A'), 'expired');
});

test('expired units can be reserved by another order', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.expire('A');
  await h.deliverAll();
  await confirm(h, 'B', 1);
  await assertConclusion(h, ['A', 'B'], 1);
});

test('expire refused for a pending order and changes nothing', async () => {
  const h = await createHost();
  await h.place('A', 1);
  const before = await snapshot(h, ['A']);
  assert.equal((await h.expire('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('expire refused for a pending order whose Reserve was delivered', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await deliverOne(h, reserveOf('A', 1));
  const before = await snapshot(h, ['A']);
  assert.equal((await h.expire('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('expire refused for a cancelling order and changes nothing', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.cancel('A');
  const before = await snapshot(h, ['A']);
  assert.equal((await h.expire('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('expire refused for a cancelled order and changes nothing', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.cancel('A');
  const before = await snapshot(h, ['A']);
  assert.equal((await h.expire('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('expire refused for a rejected order and changes nothing', async () => {
  const h = await createHost();
  await reject(h, 'A', 2);
  const before = await snapshot(h, ['A']);
  assert.equal((await h.expire('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('expire refused for an expired order and changes nothing', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.expire('A');
  const before = await snapshot(h, ['A']);
  assert.equal((await h.expire('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
  assert.equal((await findMsgs(h, { action: 'Release' })).length, 1);
});

test('expire refused for an id never placed and changes nothing', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  const before = await snapshot(h, ['A', 'ghost']);
  assert.equal((await h.expire('ghost')).ok, false);
  assert.equal(await snapshot(h, ['A', 'ghost']), before);
  assert.equal(await h.order('ghost'), null);
});

test('cancel refused for an expired order and changes nothing', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.expire('A');
  const before = await snapshot(h, ['A']);
  assert.equal((await h.cancel('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('cancel refused for an expired order after its Release was delivered', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.expire('A');
  await h.deliverAll();
  const before = await snapshot(h, ['A']);
  assert.equal((await h.cancel('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('place with an expired order id is refused', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.expire('A');
  await h.deliverAll();
  const before = await snapshot(h, ['A']);
  assert.equal((await h.place('A', 1)).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('expiring one order does not affect another', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await confirm(h, 'A', 1);
  await confirm(h, 'B', 1);
  await h.expire('A');
  await h.deliverAll();
  assert.equal(await status(h, 'B'), 'confirmed');
  await assertConclusion(h, ['A', 'B'], 2);
});

test('restock still refused at 3 units after an expired order releases', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await confirm(h, 'A', 2);
  await h.expire('A');
  await h.deliverAll();
  assert.equal((await h.restock()).ok, false);
  const st = await h.stock();
  assert.equal(st.available, 3);
  assert.equal(st.reserved, 0);
});

test('a Reserve arriving before an expired order Release is delivered is OutOfStock', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.expire('A');
  await h.place('B', 1);
  await deliverOne(h, reserveOf('B', 1));
  await h.deliverAll();
  assert.equal(await status(h, 'B'), 'rejected');
  await assertConclusion(h, ['A', 'B'], 1);
});

test('conclusion: expiring and cancelling confirmed orders returns all units', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await confirm(h, 'A', 2);
  await confirm(h, 'B', 1);
  await h.expire('A');
  await h.cancel('B');
  await h.deliverAll();
  await assertConclusion(h, ['A', 'B'], 3);
  const st = await h.stock();
  assert.equal(st.available, 3);
});

test('conclusion: expire mixed with pending orders, step delivery keeps invariants', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await confirm(h, 'A', 2);
  await h.place('B', 1);
  await h.place('C', 2);
  await h.expire('A');
  await stepDrain(h, ['A', 'B', 'C'], 3, (ms) => ms[ms.length - 1]);
  await assertConclusion(h, ['A', 'B', 'C'], 3);
});

test('conclusion: expire mixed with pending orders, listed-order delivery keeps invariants', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await confirm(h, 'A', 2);
  await h.place('B', 1);
  await h.place('C', 2);
  await h.expire('A');
  await h.cancel('B');
  await stepDrain(h, ['A', 'B', 'C'], 3, (ms) => ms[0]);
  await assertConclusion(h, ['A', 'B', 'C'], 3);
});

// ======================================================================
// Change 2: close / open for a stocktake
// ======================================================================

test('inventory starts open', async () => {
  const h = await createHost();
  assert.equal((await h.stock()).open, true);
});

test('close an open inventory returns ok and it becomes closed', async () => {
  const h = await createHost();
  assert.equal((await h.close()).ok, true);
  assert.equal((await h.stock()).open, false);
});

test('close does not change available or reserved', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.restock();
  await h.close();
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 1);
});

test('close sends no message', async () => {
  const h = await createHost();
  await h.close();
  assert.equal((await h.inFlight()).length, 0);
});

test('close refused when already closed and changes nothing', async () => {
  const h = await createHost();
  await h.close();
  const before = await snapshot(h, []);
  assert.equal((await h.close()).ok, false);
  assert.equal(await snapshot(h, []), before);
  assert.equal((await h.stock()).open, false);
});

test('open refused when already open and changes nothing', async () => {
  const h = await createHost();
  const before = await snapshot(h, []);
  assert.equal((await h.open()).ok, false);
  assert.equal(await snapshot(h, []), before);
  assert.equal((await h.stock()).open, true);
});

test('open a closed inventory returns ok and it becomes open', async () => {
  const h = await createHost();
  await h.close();
  assert.equal((await h.open()).ok, true);
  assert.equal((await h.stock()).open, true);
});

test('open does not change available or reserved', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.close();
  await h.open();
  const st = await h.stock();
  assert.equal(st.available, 0);
  assert.equal(st.reserved, 1);
  assert.equal((await h.inFlight()).length, 0);
});

test('close, open, close again all succeed in turn', async () => {
  const h = await createHost();
  assert.equal((await h.close()).ok, true);
  assert.equal((await h.open()).ok, true);
  assert.equal((await h.close()).ok, true);
  assert.equal((await h.stock()).open, false);
  assert.equal((await h.open()).ok, true);
  assert.equal((await h.open()).ok, false);
});

test('restock refused while closed even below 3 units', async () => {
  const h = await createHost();
  await h.close();
  const before = await snapshot(h, []);
  assert.equal((await h.restock()).ok, false);
  assert.equal(await snapshot(h, []), before);
  assert.equal((await h.stock()).available, 1);
});

test('restock allowed again after reopening', async () => {
  const h = await createHost();
  await h.close();
  await h.restock();
  await h.open();
  assert.equal((await h.restock()).ok, true);
  assert.equal((await h.stock()).available, 2);
});

test('place is accepted while closed and the order is pending', async () => {
  const h = await createHost();
  await h.close();
  assert.equal((await h.place('A', 1)).ok, true);
  assert.equal(await status(h, 'A'), 'pending');
  assert.equal((await findMsgs(h, reserveOf('A', 1))).length, 1);
});

test('closed inventory answers Reserve with OutOfStock even when units are available', async () => {
  const h = await createHost();
  await h.close();
  await h.place('A', 1);
  await deliverOne(h, reserveOf('A', 1));
  assert.equal((await findMsgs(h, outOfStockTo('A'))).length, 1);
  assert.equal((await findMsgs(h, reservedTo('A'))).length, 0);
});

test('closed inventory reserves nothing on Reserve', async () => {
  const h = await createHost();
  await h.close();
  await h.place('A', 1);
  await deliverOne(h, reserveOf('A', 1));
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 0);
});

test('order placed while closed is rejected when the answer arrives', async () => {
  const h = await createHost();
  await h.close();
  await h.place('A', 1);
  await h.deliverAll();
  assert.equal(await status(h, 'A'), 'rejected');
  await assertConclusion(h, ['A'], 1);
});

test('closed is judged when Reserve arrives: placed open, closed before delivery, rejected', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.close();
  await deliverOne(h, reserveOf('A', 1));
  await deliverOne(h, outOfStockTo('A'));
  assert.equal(await status(h, 'A'), 'rejected');
  assert.equal((await h.stock()).available, 1);
});

test('open is judged when Reserve arrives: placed closed, reopened before delivery, confirmed', async () => {
  const h = await createHost();
  await h.close();
  await h.place('A', 1);
  await h.open();
  await deliverOne(h, reserveOf('A', 1));
  await deliverOne(h, reservedTo('A'));
  assert.equal(await status(h, 'A'), 'confirmed');
  const st = await h.stock();
  assert.equal(st.available, 0);
  assert.equal(st.reserved, 1);
});

test('Reserved already sent before closing still confirms the order', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await deliverOne(h, reserveOf('A', 1));
  await h.close();
  await deliverOne(h, reservedTo('A'));
  assert.equal(await status(h, 'A'), 'confirmed');
  await assertConclusion(h, ['A'], 1);
});

test('Release is taken while closed', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.cancel('A');
  await h.close();
  await deliverOne(h, releaseOf('A', 1));
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 0);
  assert.equal(st.open, false);
});

test('cancel a confirmed order is accepted while closed', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.close();
  assert.equal((await h.cancel('A')).ok, true);
  assert.equal(await status(h, 'A'), 'cancelled');
  await h.deliverAll();
  await assertConclusion(h, ['A'], 1);
});

test('expire a confirmed order is accepted while closed and its units come back', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  await h.close();
  assert.equal((await h.expire('A')).ok, true);
  assert.equal(await status(h, 'A'), 'expired');
  await h.deliverAll();
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 0);
});

test('cancelling order meets a closed inventory: OutOfStock, cancelled, no Release', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.cancel('A');
  await h.close();
  await deliverOne(h, reserveOf('A', 1));
  await deliverOne(h, outOfStockTo('A'));
  assert.equal(await status(h, 'A'), 'cancelled');
  assert.equal((await h.inFlight()).length, 0);
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 0);
});

test('two orders while closed are both rejected', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await h.close();
  await h.place('A', 1);
  await h.place('B', 2);
  await h.deliverAll();
  assert.equal(await status(h, 'A'), 'rejected');
  assert.equal(await status(h, 'B'), 'rejected');
  await assertConclusion(h, ['A', 'B'], 3);
});

test('reopening between two deliveries: first rejected, second confirmed', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.place('B', 1);
  await h.close();
  await deliverOne(h, reserveOf('A', 1));
  await h.open();
  await deliverOne(h, reserveOf('B', 1));
  await h.deliverAll();
  assert.equal(await status(h, 'A'), 'rejected');
  assert.equal(await status(h, 'B'), 'confirmed');
  await assertConclusion(h, ['A', 'B'], 1);
});

test('refused close leaves orders and messages unchanged', async () => {
  const h = await createHost();
  await h.place('A', 1);
  await h.close();
  const before = await snapshot(h, ['A']);
  assert.equal((await h.close()).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('refused open leaves orders and messages unchanged', async () => {
  const h = await createHost();
  await h.place('A', 1);
  const before = await snapshot(h, ['A']);
  assert.equal((await h.open()).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('conclusion: closing mid-flight keeps reserved equal to confirmed units', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await h.place('A', 1);
  await h.place('B', 2);
  await deliverOne(h, reserveOf('A', 1));
  await h.close();
  await h.cancel('A');
  await stepDrain(h, ['A', 'B'], 3, (ms) => ms[0]);
  await assertConclusion(h, ['A', 'B'], 3);
  assert.equal(await status(h, 'B'), 'rejected');
  assert.equal(await status(h, 'A'), 'cancelled');
});

test('conclusion: open/close toggling with step delivery keeps invariants', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await confirm(h, 'A', 1);
  await h.place('B', 1);
  await h.place('C', 1);
  await h.close();
  await h.cancel('A');
  await deliverOne(h, reserveOf('B', 1));
  await h.open();
  await stepDrain(h, ['A', 'B', 'C'], 3, (ms) => ms[ms.length - 1]);
  await assertConclusion(h, ['A', 'B', 'C'], 3);
  assert.equal(await status(h, 'B'), 'rejected');
});

// ======================================================================
// Change 3: reduce a confirmed order of 2
// ======================================================================

async function confirmedTwo(h, id) {
  await restockTimes(h, 1);
  await confirm(h, id, 2);
}

test('reduce a confirmed order of 2 returns ok and keeps it confirmed for 1', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  assert.equal((await h.reduce('A')).ok, true);
  const v = await h.order('A');
  assert.equal(v.status, 'confirmed');
  assert.equal(v.qty, 1);
});

test('reduce sends Release from the order to the inventory with qty 1', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  await h.reduce('A');
  const ms = await findMsgs(h, releaseOf('A'));
  assert.equal(ms.length, 1);
  assert.equal(ms[0].data.qty, 1);
});

test('reduce leaves stock unchanged until its Release is delivered', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  await h.reduce('A');
  const st = await h.stock();
  assert.equal(st.available, 0);
  assert.equal(st.reserved, 2);
});

test('delivering the reduce Release returns exactly 1 unit', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  await h.reduce('A');
  await deliverOne(h, releaseOf('A', 1));
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 1);
  assert.equal((await h.inFlight()).length, 0);
});

test('after reduce, the conclusion holds: reserved equals confirmed units', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  await h.reduce('A');
  await h.deliverAll();
  await assertConclusion(h, ['A'], 2);
});

test('reduce refused for a confirmed order of 1 and changes nothing', async () => {
  const h = await createHost();
  await confirm(h, 'A', 1);
  const before = await snapshot(h, ['A']);
  assert.equal((await h.reduce('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('reduce twice: the second is refused and changes nothing', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  assert.equal((await h.reduce('A')).ok, true);
  const before = await snapshot(h, ['A']);
  assert.equal((await h.reduce('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('reduce twice with the Release delivered in between: second refused', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  await h.reduce('A');
  await h.deliverAll();
  const before = await snapshot(h, ['A']);
  assert.equal((await h.reduce('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('reduce refused for a pending order of 2 and changes nothing', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await h.place('A', 2);
  const before = await snapshot(h, ['A']);
  assert.equal((await h.reduce('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('reduce refused for a pending order of 2 whose Reserve was delivered', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await h.place('A', 2);
  await deliverOne(h, reserveOf('A', 2));
  const before = await snapshot(h, ['A']);
  assert.equal((await h.reduce('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('reduce refused for a cancelling order of 2 and changes nothing', async () => {
  const h = await createHost();
  await restockTimes(h, 1);
  await h.place('A', 2);
  await h.cancel('A');
  const before = await snapshot(h, ['A']);
  assert.equal((await h.reduce('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('reduce refused for a cancelled order of 2 and changes nothing', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  await h.cancel('A');
  const before = await snapshot(h, ['A']);
  assert.equal((await h.reduce('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('reduce refused for a rejected order of 2 and changes nothing', async () => {
  const h = await createHost();
  await reject(h, 'A', 2);
  const before = await snapshot(h, ['A']);
  assert.equal((await h.reduce('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('reduce refused for an expired order of 2 and changes nothing', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  await h.expire('A');
  const before = await snapshot(h, ['A']);
  assert.equal((await h.reduce('A')).ok, false);
  assert.equal(await snapshot(h, ['A']), before);
});

test('reduce refused for an id never placed and changes nothing', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  const before = await snapshot(h, ['A', 'ghost']);
  assert.equal((await h.reduce('ghost')).ok, false);
  assert.equal(await snapshot(h, ['A', 'ghost']), before);
  assert.equal(await h.order('ghost'), null);
});

test('cancel after reduce releases the 1 unit still held', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  await h.reduce('A');
  await h.deliverAll();
  assert.equal((await h.cancel('A')).ok, true);
  assert.equal((await findMsgs(h, releaseOf('A', 1))).length, 1);
  assert.equal((await findMsgs(h, releaseOf('A', 2))).length, 0);
  await h.deliverAll();
  const st = await h.stock();
  assert.equal(st.available, 2);
  assert.equal(st.reserved, 0);
  assert.equal(await status(h, 'A'), 'cancelled');
});

test('cancel right after reduce (Release still in flight) returns all units in the end', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  await h.reduce('A');
  await h.cancel('A');
  const rel = await findMsgs(h, releaseOf('A'));
  assert.equal(rel.length, 2);
  assert.deepEqual(rel.map((m) => m.data.qty).sort(), [1, 1]);
  await h.deliverAll();
  const st = await h.stock();
  assert.equal(st.available, 2);
  assert.equal(st.reserved, 0);
});

test('expire after reduce releases the 1 unit still held', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  await h.reduce('A');
  await h.deliverAll();
  assert.equal((await h.expire('A')).ok, true);
  assert.equal((await findMsgs(h, releaseOf('A', 1))).length, 1);
  assert.equal((await findMsgs(h, releaseOf('A', 2))).length, 0);
  await h.deliverAll();
  const st = await h.stock();
  assert.equal(st.available, 2);
  assert.equal(st.reserved, 0);
  const v = await h.order('A');
  assert.equal(v.status, 'expired');
  assert.equal(v.qty, 1);
});

test('reduced unit can be reserved by another order', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  await h.reduce('A');
  await h.deliverAll();
  await confirm(h, 'B', 1);
  await assertConclusion(h, ['A', 'B'], 2);
});

test('a Reserve arriving before the reduce Release is delivered is OutOfStock', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  await h.reduce('A');
  await h.place('B', 1);
  await deliverOne(h, reserveOf('B', 1));
  await h.deliverAll();
  assert.equal(await status(h, 'B'), 'rejected');
  await assertConclusion(h, ['A', 'B'], 2);
});

test('reduce does not change the 3-unit total: restock still refused', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await confirm(h, 'A', 2);
  await h.reduce('A');
  await h.deliverAll();
  const st = await h.stock();
  assert.equal(st.available, 2);
  assert.equal(st.reserved, 1);
  assert.equal((await h.restock()).ok, false);
});

test('reduce is accepted while closed and its Release is taken', async () => {
  const h = await createHost();
  await confirmedTwo(h, 'A');
  await h.close();
  assert.equal((await h.reduce('A')).ok, true);
  await h.deliverAll();
  const st = await h.stock();
  assert.equal(st.available, 1);
  assert.equal(st.reserved, 1);
  assert.equal(st.open, false);
});

test('reducing one order does not affect another', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await confirm(h, 'A', 2);
  await confirm(h, 'B', 1);
  await h.reduce('A');
  await h.deliverAll();
  const b = await h.order('B');
  assert.equal(b.status, 'confirmed');
  assert.equal(b.qty, 1);
  await assertConclusion(h, ['A', 'B'], 3);
});

test('conclusion: reduce, cancel and new orders with step delivery keep invariants', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await confirm(h, 'A', 2);
  await h.reduce('A');
  await h.place('B', 2);
  await h.place('C', 1);
  await h.cancel('A');
  await stepDrain(h, ['A', 'B', 'C'], 3, (ms) => ms[ms.length - 1]);
  await assertConclusion(h, ['A', 'B', 'C'], 3);
});

test('conclusion: reduce then expire with listed-order delivery keeps invariants', async () => {
  const h = await createHost();
  await restockTimes(h, 2);
  await confirm(h, 'A', 2);
  await h.place('B', 1);
  await h.reduce('A');
  await h.expire('A');
  await stepDrain(h, ['A', 'B'], 3, (ms) => ms[0]);
  await assertConclusion(h, ['A', 'B'], 3);
});
