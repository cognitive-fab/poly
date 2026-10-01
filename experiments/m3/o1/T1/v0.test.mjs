import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { default: createHost } = await import(pathToFileURL(process.env.M3_IMPL).href);

const CHARGE = 'payment.charge';

async function ok(p, msg) {
  const r = await p;
  assert.equal(r.ok, true, msg);
  return r;
}

async function no(p, msg) {
  const r = await p;
  assert.equal(r.ok, false, msg);
  return r;
}

// Checks only the fields named in exp.
async function expectView(h, id, exp) {
  const v = await h.order(id);
  assert.notEqual(v, null, 'order ' + id + ' should exist');
  for (const [k, val] of Object.entries(exp)) assert.equal(v[k], val, id + '.' + k);
  return v;
}

// Pending payment.charge effects requested by the given order.
async function chargesOf(h, id) {
  return (await h.pendingEffects()).filter((e) => e.from === id && e.kind === CHARGE);
}

async function theCharge(h, id) {
  const cs = await chargesOf(h, id);
  assert.equal(cs.length, 1, 'exactly one pending charge for ' + id);
  return cs[0];
}

// Answers the one pending charge of an order; returns the effect answered.
async function answer(h, id, outcome) {
  const e = await theCharge(h, id);
  await h.completeEffect(e.id, outcome);
  return e;
}

// An answer to an effect that is no longer pending: the brief says it changes
// nothing; whether the call itself rejects is left open, so a rejection is ignored.
async function lateAnswer(h, effectId, outcome) {
  try {
    await h.completeEffect(effectId, outcome);
  } catch {
    /* left open by the brief */
  }
}

async function snapshot(h, ids) {
  const views = {};
  for (const id of ids) views[id] = await h.order(id);
  const effects = (await h.pendingEffects()).map((e) => JSON.stringify(e)).sort();
  return { views, effects };
}

// Runs a command that must be refused, and checks that no query changed.
async function refusedUnchanged(h, ids, fn) {
  const before = await snapshot(h, ids);
  const r = await fn();
  assert.equal(r.ok, false);
  const after = await snapshot(h, ids);
  assert.deepEqual(after, before);
}

async function draft(h, id, n = 0) {
  await ok(h.create(id));
  for (let i = 0; i < n; i++) await ok(h.addItem(id));
}

async function placed(h, id, n = 1) {
  await draft(h, id, n);
  await ok(h.place(id));
}

async function paid(h, id, n = 1) {
  await placed(h, id, n);
  await answer(h, id, 'ok');
}

async function shipped(h, id, n = 1) {
  await paid(h, id, n);
  await ok(h.ship(id));
}

async function cancelledDraft(h, id, n = 1) {
  await draft(h, id, n);
  await ok(h.cancel(id));
}

async function cancelledPaid(h, id, n = 1) {
  await paid(h, id, n);
  await ok(h.cancel(id));
}

async function failed(h, id, n = 1) {
  await placed(h, id, n);
  await answer(h, id, 'failed');
}

// ---------- every command refused where the brief refuses it ----------
const COMMANDS = ["addItem","removeItem","place","ship","cancel"];
const STATES = [
  ["an empty draft", (h, id) => draft(h, id, 0), ["addItem","cancel"]],
  ["a draft with 1 item", (h, id) => draft(h, id, 1), ["addItem","removeItem","place","cancel"]],
  ["a draft with 3 items", (h, id) => draft(h, id, 3), ["removeItem","place","cancel"]],
  ["a placed order", (h, id) => placed(h, id, 2), []],
  ["a paid order", (h, id) => paid(h, id, 2), ["ship","cancel"]],
  ["a shipped order", (h, id) => shipped(h, id, 2), []],
  ["a failed order", (h, id) => failed(h, id, 2), []],
  ["a cancelled draft", (h, id) => cancelledDraft(h, id, 2), []],
  ["a cancelled paid order", (h, id) => cancelledPaid(h, id, 2), []],
];

for (const [name, build, allowed] of STATES) {
  for (const cmd of COMMANDS) {
    if (allowed.includes(cmd)) continue;
    test(cmd + ' on ' + name + ' is refused and changes nothing', async () => {
      const h = await createHost();
      await build(h, 'o1');
      await draft(h, 'other', 1);
      await refusedUnchanged(h, ['o1', 'other'], () => h[cmd]('o1'));
    });
  }
  test('create with the id of ' + name + ' is refused and changes nothing', async () => {
    const h = await createHost();
    await build(h, 'o1');
    await refusedUnchanged(h, ['o1'], () => h.create('o1'));
  });
}

for (const cmd of COMMANDS) {
  test(cmd + ' on an order id that was never created is refused and creates nothing', async () => {
    const h = await createHost();
    await placed(h, 'known', 1);
    await refusedUnchanged(h, ['known', 'ghost'], () => h[cmd]('ghost'));
    assert.equal(await h.order('ghost'), null);
  });
}

// ---------- specific behaviours ----------

test("a fresh system has no pending effect", async () => {
  const h = await createHost();
  assert.deepEqual(await h.pendingEffects(), []);
});

test("order returns null for an id never created", async () => {
  const h = await createHost();
  assert.equal(await h.order('nope'), null);
});

test("create makes an empty draft with no charges or refunds", async () => {
  const h = await createHost();
  await ok(h.create('a'));
  await expectView(h, 'a', { status: 'draft', items: 0, charges: 0, refunds: 0 });
});

test("create requests no effect", async () => {
  const h = await createHost();
  await ok(h.create('a'));
  assert.deepEqual(await h.pendingEffects(), []);
});

test("create with an existing draft id is refused and keeps its items", async () => {
  const h = await createHost();
  await draft(h, 'a', 2);
  await refusedUnchanged(h, ['a'], () => h.create('a'));
  await expectView(h, 'a', { status: 'draft', items: 2 });
});

test("creating one order leaves other ids unknown", async () => {
  const h = await createHost();
  await ok(h.create('a'));
  assert.equal(await h.order('b'), null);
});

test("two orders with different ids are independent drafts", async () => {
  const h = await createHost();
  await draft(h, 'a', 1);
  await draft(h, 'b', 3);
  await expectView(h, 'a', { status: 'draft', items: 1 });
  await expectView(h, 'b', { status: 'draft', items: 3 });
});

test("a fresh system does not see orders of another fresh system", async () => {
  const h1 = await createHost();
  await placed(h1, 'a', 1);
  const h = await createHost();
  assert.equal(await h.order('a'), null);
  assert.deepEqual(await h.pendingEffects(), []);
});

test("addItem adds one item to a draft", async () => {
  const h = await createHost();
  await ok(h.create('a'));
  await ok(h.addItem('a'));
  await expectView(h, 'a', { status: 'draft', items: 1 });
});

test("addItem can fill a draft up to 3 items", async () => {
  const h = await createHost();
  await ok(h.create('a'));
  for (let i = 1; i <= 3; i++) {
    await ok(h.addItem('a'));
    await expectView(h, 'a', { items: i });
  }
});

test("addItem on a draft holding 3 items is refused and items stay 3", async () => {
  const h = await createHost();
  await draft(h, 'a', 3);
  await refusedUnchanged(h, ['a'], () => h.addItem('a'));
  await expectView(h, 'a', { status: 'draft', items: 3 });
});

test("addItem is allowed again after removing from a full draft", async () => {
  const h = await createHost();
  await draft(h, 'a', 3);
  await ok(h.removeItem('a'));
  await ok(h.addItem('a'));
  await expectView(h, 'a', { items: 3 });
  await no(h.addItem('a'));
});

test("removeItem removes one item from a draft", async () => {
  const h = await createHost();
  await draft(h, 'a', 2);
  await ok(h.removeItem('a'));
  await expectView(h, 'a', { status: 'draft', items: 1 });
});

test("removeItem can empty a draft and is then refused", async () => {
  const h = await createHost();
  await draft(h, 'a', 2);
  await ok(h.removeItem('a'));
  await ok(h.removeItem('a'));
  await expectView(h, 'a', { items: 0 });
  await refusedUnchanged(h, ['a'], () => h.removeItem('a'));
});

test("items in one draft do not change another draft", async () => {
  const h = await createHost();
  await draft(h, 'a', 1);
  await draft(h, 'b', 0);
  await ok(h.addItem('a'));
  await ok(h.addItem('a'));
  await expectView(h, 'b', { items: 0 });
  await ok(h.addItem('b'));
  await ok(h.removeItem('a'));
  await expectView(h, 'a', { items: 2 });
  await expectView(h, 'b', { items: 1 });
});

test("item changes on a draft request no effect", async () => {
  const h = await createHost();
  await draft(h, 'a', 3);
  await ok(h.removeItem('a'));
  assert.deepEqual(await h.pendingEffects(), []);
});

test("place on an empty draft is refused", async () => {
  const h = await createHost();
  await draft(h, 'a', 0);
  await refusedUnchanged(h, ['a'], () => h.place('a'));
  await expectView(h, 'a', { status: 'draft', charges: 0 });
});

test("place on a draft emptied by removeItem is refused", async () => {
  const h = await createHost();
  await draft(h, 'a', 1);
  await ok(h.removeItem('a'));
  await refusedUnchanged(h, ['a'], () => h.place('a'));
  assert.deepEqual(await chargesOf(h, 'a'), []);
});

test("place on a draft with items makes it placed with one charge", async () => {
  const h = await createHost();
  await draft(h, 'a', 2);
  await ok(h.place('a'));
  await expectView(h, 'a', { status: 'placed', items: 2, charges: 1, refunds: 0 });
});

test("place requests exactly one payment.charge effect from the order", async () => {
  const h = await createHost();
  await draft(h, 'a', 1);
  await ok(h.place('a'));
  const e = await theCharge(h, 'a');
  assert.equal(e.from, 'a');
  assert.equal(e.kind, 'payment.charge');
});

test("the charge amount is the number of items (1)", async () => {
  const h = await createHost();
  await draft(h, 'a', 1);
  await ok(h.place('a'));
  const e = await theCharge(h, 'a');
  assert.equal(e.data.amount, 1);
});

test("the charge amount is the number of items (2)", async () => {
  const h = await createHost();
  await draft(h, 'a', 2);
  await ok(h.place('a'));
  const e = await theCharge(h, 'a');
  assert.equal(e.data.amount, 2);
});

test("the charge amount is the number of items (3)", async () => {
  const h = await createHost();
  await draft(h, 'a', 3);
  await ok(h.place('a'));
  const e = await theCharge(h, 'a');
  assert.equal(e.data.amount, 3);
});

test("the charge amount counts items left after removals", async () => {
  const h = await createHost();
  await draft(h, 'a', 3);
  await ok(h.removeItem('a'));
  await ok(h.place('a'));
  assert.equal((await theCharge(h, 'a')).data.amount, 2);
});

test("placing two orders requests one charge for each, from each order", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  await placed(h, 'b', 3);
  assert.equal((await theCharge(h, 'a')).data.amount, 1);
  assert.equal((await theCharge(h, 'b')).data.amount, 3);
  await expectView(h, 'a', { charges: 1 });
  await expectView(h, 'b', { charges: 1 });
});

test("place a second time is refused and requests no second charge", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  await refusedUnchanged(h, ['a'], () => h.place('a'));
  await expectView(h, 'a', { charges: 1 });
  assert.equal((await chargesOf(h, 'a')).length, 1);
});

test("a placed order keeps its items", async () => {
  const h = await createHost();
  await placed(h, 'a', 3);
  await expectView(h, 'a', { items: 3 });
});

test("a charge completed ok makes a placed order paid", async () => {
  const h = await createHost();
  await placed(h, 'a', 2);
  await answer(h, 'a', 'ok');
  await expectView(h, 'a', { status: 'paid', items: 2, charges: 1, refunds: 0 });
});

test("a charge completed ok is no longer pending", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  await answer(h, 'a', 'ok');
  assert.deepEqual(await chargesOf(h, 'a'), []);
});

test("a charge completed failed is no longer pending", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  await answer(h, 'a', 'failed');
  assert.deepEqual(await chargesOf(h, 'a'), []);
});

test("a charge completed failed makes a placed order failed", async () => {
  const h = await createHost();
  await placed(h, 'a', 2);
  await answer(h, 'a', 'failed');
  await expectView(h, 'a', { status: 'failed', items: 2, charges: 1, refunds: 0 });
});

test("a placed order stays placed until its charge is answered", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  await placed(h, 'b', 1);
  await answer(h, 'b', 'ok');
  await expectView(h, 'a', { status: 'placed' });
  assert.equal((await chargesOf(h, 'a')).length, 1);
});

test("answering one order's charge does not change another order", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  await placed(h, 'b', 2);
  await answer(h, 'a', 'ok');
  await expectView(h, 'b', { status: 'placed', charges: 1, refunds: 0 });
  await expectView(h, 'a', { status: 'paid' });
});

test("charges answered out of order settle each order by its own answer", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  await placed(h, 'b', 2);
  await answer(h, 'b', 'failed');
  await answer(h, 'a', 'ok');
  await expectView(h, 'a', { status: 'paid' });
  await expectView(h, 'b', { status: 'failed' });
});

test("answering an earlier placed order after a later one was paid leaves the later one paid", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  await placed(h, 'b', 1);
  await answer(h, 'b', 'ok');
  await answer(h, 'a', 'ok');
  await expectView(h, 'a', { status: 'paid' });
  await expectView(h, 'b', { status: 'paid' });
});

test("a repeated ok answer to a paid order's charge changes nothing", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  const e = await answer(h, 'a', 'ok');
  await lateAnswer(h, e.id, 'ok');
  await expectView(h, 'a', { status: 'paid', charges: 1, refunds: 0 });
  assert.deepEqual(await chargesOf(h, 'a'), []);
});

test("a late failed answer to a paid order's charge changes nothing", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  const e = await answer(h, 'a', 'ok');
  await lateAnswer(h, e.id, 'failed');
  await expectView(h, 'a', { status: 'paid', charges: 1, refunds: 0 });
});

test("a late answer to a shipped order's charge changes nothing", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  const e = await answer(h, 'a', 'ok');
  await ok(h.ship('a'));
  await lateAnswer(h, e.id, 'failed');
  await expectView(h, 'a', { status: 'shipped', charges: 1, refunds: 0 });
});

test("a late answer to a cancelled paid order's charge changes nothing", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  const e = await answer(h, 'a', 'ok');
  await ok(h.cancel('a'));
  await lateAnswer(h, e.id, 'ok');
  await expectView(h, 'a', { status: 'cancelled', charges: 1, refunds: 1 });
});

test("a late ok answer to a failed order's charge changes nothing", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  const e = await answer(h, 'a', 'failed');
  await lateAnswer(h, e.id, 'ok');
  await expectView(h, 'a', { status: 'failed', charges: 1, refunds: 0 });
});

test("a late answer to one order's charge does not change another placed order", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  const e = await answer(h, 'a', 'ok');
  await placed(h, 'b', 1);
  await lateAnswer(h, e.id, 'failed');
  await expectView(h, 'b', { status: 'placed' });
  assert.equal((await chargesOf(h, 'b')).length, 1);
  await expectView(h, 'a', { status: 'paid' });
});

test("ship makes a paid order shipped", async () => {
  const h = await createHost();
  await paid(h, 'a', 2);
  await ok(h.ship('a'));
  await expectView(h, 'a', { status: 'shipped', items: 2, charges: 1, refunds: 0 });
});

test("ship requests no new charge", async () => {
  const h = await createHost();
  await paid(h, 'a', 1);
  await ok(h.ship('a'));
  assert.deepEqual(await chargesOf(h, 'a'), []);
});

test("ship a placed order whose charge is unanswered is refused", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  await refusedUnchanged(h, ['a'], () => h.ship('a'));
  await expectView(h, 'a', { status: 'placed' });
});

test("cancel makes an empty draft cancelled with no refund", async () => {
  const h = await createHost();
  await draft(h, 'a', 0);
  await ok(h.cancel('a'));
  await expectView(h, 'a', { status: 'cancelled', charges: 0, refunds: 0 });
});

test("cancel makes a draft with items cancelled with no charge and no refund", async () => {
  const h = await createHost();
  await draft(h, 'a', 2);
  await ok(h.cancel('a'));
  await expectView(h, 'a', { status: 'cancelled', charges: 0, refunds: 0 });
  assert.deepEqual(await chargesOf(h, 'a'), []);
});

test("cancel makes a paid order cancelled and requests one refund", async () => {
  const h = await createHost();
  await paid(h, 'a', 2);
  await ok(h.cancel('a'));
  await expectView(h, 'a', { status: 'cancelled', charges: 1, refunds: 1 });
});

test("cancelling a paid order requests no new charge", async () => {
  const h = await createHost();
  await paid(h, 'a', 1);
  await ok(h.cancel('a'));
  assert.deepEqual(await chargesOf(h, 'a'), []);
});

test("a second cancel of a paid-then-cancelled order is refused and does not refund twice", async () => {
  const h = await createHost();
  await cancelledPaid(h, 'a', 1);
  await refusedUnchanged(h, ['a'], () => h.cancel('a'));
  await expectView(h, 'a', { refunds: 1 });
});

test("refunding one order does not refund another paid order", async () => {
  const h = await createHost();
  await paid(h, 'a', 1);
  await paid(h, 'b', 1);
  await ok(h.cancel('a'));
  await expectView(h, 'b', { status: 'paid', refunds: 0 });
});

test("cancel on a placed order is refused while its payment is in progress", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  await refusedUnchanged(h, ['a'], () => h.cancel('a'));
  await expectView(h, 'a', { status: 'placed', refunds: 0 });
  assert.equal((await chargesOf(h, 'a')).length, 1);
});

test("a placed order whose cancel was refused can still be paid and then cancelled with a refund", async () => {
  const h = await createHost();
  await placed(h, 'a', 1);
  await no(h.cancel('a'));
  await answer(h, 'a', 'ok');
  await ok(h.cancel('a'));
  await expectView(h, 'a', { status: 'cancelled', refunds: 1 });
});

test("a shipped order is never refunded", async () => {
  const h = await createHost();
  await shipped(h, 'a', 1);
  await no(h.cancel('a'));
  await expectView(h, 'a', { status: 'shipped', refunds: 0 });
});

test("a full lifecycle draft-placed-paid-shipped charges once and never refunds", async () => {
  const h = await createHost();
  await ok(h.create('a'));
  await expectView(h, 'a', { charges: 0 });
  await ok(h.addItem('a'));
  await ok(h.addItem('a'));
  await expectView(h, 'a', { charges: 0 });
  await ok(h.place('a'));
  await expectView(h, 'a', { charges: 1 });
  await answer(h, 'a', 'ok');
  await expectView(h, 'a', { charges: 1 });
  await ok(h.ship('a'));
  await expectView(h, 'a', { status: 'shipped', charges: 1, refunds: 0 });
  for (const cmd of ['addItem', 'removeItem', 'place', 'ship', 'cancel']) await no(h[cmd]('a'));
  await expectView(h, 'a', { status: 'shipped', charges: 1, refunds: 0 });
});

test("an order is never charged before it is placed", async () => {
  const h = await createHost();
  await ok(h.create('a'));
  await no(h.place('a'));
  await ok(h.addItem('a'));
  await ok(h.removeItem('a'));
  await no(h.place('a'));
  await ok(h.cancel('a'));
  await expectView(h, 'a', { status: 'cancelled', charges: 0, refunds: 0 });
  assert.deepEqual(await h.pendingEffects(), []);
});

test("commands after shipping leave charges and refunds as they were", async () => {
  const h = await createHost();
  await shipped(h, 'a', 3);
  const cmds = ['addItem', 'removeItem', 'place', 'ship', 'cancel', 'create'];
  for (const c of cmds) await no(h[c]('a'));
  await expectView(h, 'a', { status: 'shipped', items: 3, charges: 1, refunds: 0 });
});

test("a cancelled paid order stays at exactly one refund whatever is tried next", async () => {
  const h = await createHost();
  await cancelledPaid(h, 'a', 1);
  for (const c of ['cancel', 'ship', 'place', 'addItem', 'removeItem', 'cancel']) await no(h[c]('a'));
  await expectView(h, 'a', { status: 'cancelled', charges: 1, refunds: 1 });
});

test("many orders: refunds only for those cancelled after being paid", async () => {
  const h = await createHost();
  await cancelledDraft(h, 'd', 1);
  await cancelledPaid(h, 'p', 2);
  await shipped(h, 's', 1);
  await failed(h, 'f', 1);
  await paid(h, 'q', 1);
  await expectView(h, 'd', { refunds: 0, charges: 0 });
  await expectView(h, 'p', { refunds: 1, charges: 1 });
  await expectView(h, 's', { refunds: 0, charges: 1 });
  await expectView(h, 'f', { refunds: 0 });
  await expectView(h, 'q', { refunds: 0, charges: 1 });
});

test("a failed order is charged once and never refunded", async () => {
  const h = await createHost();
  await failed(h, 'a', 2);
  for (const c of ['place', 'cancel', 'ship', 'addItem', 'removeItem']) await no(h[c]('a'));
  await expectView(h, 'a', { status: 'failed', charges: 1, refunds: 0 });
  assert.deepEqual(await chargesOf(h, 'a'), []);
});
