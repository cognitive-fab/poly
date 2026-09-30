// Plan step 6, attached children (PT6.4, PT7, PS7): spawn with a creation action (S43), the wiring's
// payloads (S44), the kernel's alphabet (S45, K9), children of children (S46), the doctrine codes (S47),
// compose invariants under `k spawned` (S48), poly-ref's joint machine, and polyrun's check-product as
// stage 4, each of its findings replayed through poly-ref's cascade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkJoint } from '@poly/ref';
import { checkFile, render } from '@poly/check';
import { createRuntime } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import { ROOT, BUILD, build } from './helpers.mjs';

const CHILDREN = join(ROOT, 'conformance', 'm1', 'children.poly');
const OUT = join(BUILD, 'children');
const SRC = readFileSync(CHILDREN, 'utf8');

const codes = (src) => {
  const p = parse(src);
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  return checkModule(p.module).diagnostics.map((d) => d.code);
};
const write = (name, src) => {
  const dir = join(OUT, 'sources');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, src);
  return file;
};
const steps = (d) => d.witness.trace.map((s) => s.action);

test('the conformance case checks clean, and poly-ref and check-product count the same 29 joint states', async () => {
  const r = await checkFile(CHILDREN, { root: OUT });
  assert.equal(r.verdict, 'CLEAN', render(r));
  const order = r.machines.find((m) => m.machine === 'Order');
  assert.equal(order.instance.jointStates, 29);
  const stage = order.stages.find((s) => s.stage === 'composition');
  assert.match(stage.note, /29 joint states \(polyrun 29\)/);
  // S45: the joint check rests on K9, and the verdict says so.
  assert.deepEqual(order.instance.kernelAssumptions, ['K1', 'K2', 'K3', 'K7', 'K9']);
  assert.match(render(r), /shop\.Order {2}over 7 states; 29 joint states with its attached children; kernel assumptions K1, K2, K3, K7, K9/);
});

test('PS7.2: the cascade runs creation, signal, completion and cancel as polyrun does', () => {
  const m = parse(SRC).module;
  const r = checkJoint(m, 'Order');
  const g = r.graph;
  // Checkout spawns box and runs Start(size: 1) in the same cascade.
  const checkout = g.edges.find((e) => e.from === 0 && e.stimulus.action === 'Checkout');
  assert.deepEqual(checkout.cascade.map((c) => `${c.target}.${c.action}:${c.verdict.kind}`), ['parent.Checkout:accepted', 'box.Start:accepted']);
  const after = g.states[checkout.to];
  assert.equal(after.children[0][1].state.size, 1);
  // Cancel voids the live box (parent-terminal cancel); the box, now terminal, completes into the parent,
  // which is terminal and rejects it, as polyrun journals it.
  const cancel = g.edges.find((e) => e.from === checkout.to && e.stimulus.action === 'Cancel');
  assert.deepEqual(cancel.cascade.map((c) => `${c.target}.${c.action}:${c.verdict.kind}`), ['parent.Cancel:accepted', 'box.Void:accepted', 'parent.Shipped:rejected']);
  // S45: while box is live, Shipped is not offered to the parent from outside.
  assert.ok(!g.edges.some((e) => e.from === checkout.to && e.stimulus.target === 'parent' && e.stimulus.action === 'Shipped'));
});

test('S43 to S48: the checker', () => {
  const base = SRC.replace(/\n  compose invariant[\s\S]*?\n}\n$/, '\n}\n');
  const swap = (a, b) => codes(base.replace(a, b));
  assert.deepEqual(codes(base), []);
  assert.deepEqual(swap('spawn Shipment as box', 'spawn Parcel as box'), ['PL1001']);
  // S60 (built in M2): a detached child takes no on complete and no on parent terminal wiring, and is no
  // attached child a signal can name.
  assert.deepEqual(swap('spawn Shipment as box', 'spawn detached Shipment as box'), ['PL1201', 'PL1201', 'PL1001']);
  assert.deepEqual(swap('spawn Shipment as box', 'spawn Shipment as parent').filter((c) => c !== 'PL1001'), ['PL1201']);
  assert.deepEqual(swap('Start(size: 1)', 'Start(size: true)'), ['PL1201']);
  assert.deepEqual(swap('as box -> Start(size: 1)', 'as box -> Begin(size: 1)'), ['PL1001']);
  // S44: the completion and cancel parameter lists the runtime supplies.
  assert.deepEqual(swap('  action Shipped()\n', '  action Shipped(n: 0..1)\n').filter((c) => c === 'PL1201'), ['PL1201']);
  assert.deepEqual(swap('  action Shipped()\n', '  action Shipped(childKey: string check { "box" }, childState: bool)\n').filter((c) => c === 'PL1201'), ['PL1201'], 'childState is a record of the child\'s fields (S44)');
  assert.deepEqual(swap('  action Void(reason: string check { "parent-terminal" })', '  action Void(reason: string check { "late" })'), ['PL1201']);
  assert.deepEqual(codes(base.replace('  action Void(reason: string check { "parent-terminal" })', '  action Void()').replace('  on Void(reason) {', '  on Void {')), [], 'a cancel with no parameters is legal');
  // S40: every wired action has a handler.
  assert.deepEqual(swap('  on Shipped {', '  on Nope {').filter((c) => c === 'PL6101'), ['PL6101']);
  assert.deepEqual(swap('signal box -> Send()', 'signal crate -> Send()'), ['PL1001']);
  // PL5101: one key spawned twice on one path.
  assert.deepEqual(swap('    signal box -> Send()', '    spawn Shipment as box -> Start(size: 1) on complete -> Shipped on parent terminal -> Void\n    spawn Shipment as box -> Start(size: 1) on complete -> Shipped on parent terminal -> Void'), ['PL5101']);
  // S46: a child that spawns is out of M1: one PL0901 where Order spawns it, one where it spawns itself.
  assert.deepEqual(swap('    ship\' = Sent\n', '    ship\' = Sent\n    spawn Shipment as box\n').filter((c) => c === 'PL0901'), ['PL0901', 'PL0901']);
  // S48: children.k.f under `k spawned` only.
  const withInv = (inv) => codes(base.replace(/\n}\n$/, `\n  compose invariant i: ${inv}\n}\n`));
  assert.deepEqual(withInv('box spawned implies children.box.size <= 2'), []);
  assert.deepEqual(withInv('children.box.size <= 2'), ['PL5103']);
  assert.deepEqual(withInv('parent.status == Done || children.box.size <= 2'), ['PL5103']);
  assert.deepEqual(withInv('status == Done'), ['PL1201']);
  assert.deepEqual(withInv('crate spawned'), ['PL1001']);
  assert.deepEqual(codes(base.replace('    require !hurried else reject "hurried"', '    require !(box spawned) else reject "hurried"')), ['PL1201']);
});

test('PL5001: a violated compose invariant is found by poly-ref and confirmed by check-product', async () => {
  const file = write('invariant.poly', SRC.replace('children.box.ship in { Delivered, Voided })', 'children.box.ship == Delivered)'));
  const r = await checkFile(file, { root: OUT });
  const f = r.machines.find((m) => m.machine === 'Order').diagnostics.filter((d) => d.code === 'PL5001');
  assert.equal(f.length, 1, render(r));
  assert.equal(f[0].property, 'done-means-settled');
  assert.match(f[0].engine, /poly-ref.*polyrun/);
  // Voiding the box from outside completes it into the parent, which is then Done with a voided box.
  assert.deepEqual(steps(f[0]), ['Checkout', 'box.Void']);
  assert.ok(!r.machines.flatMap((m) => m.diagnostics).some((d) => d.code === 'PL2501'));
});

test('PL5101: a spawn that re-uses a live child key is found by both engines', async () => {
  const file = write('collision.poly', SRC.replace('    signal box -> Send()', '    signal box -> Send()\n    spawn Shipment as box -> Start(size: 1) on complete -> Shipped on parent terminal -> Void'));
  const r = await checkFile(file, { root: OUT });
  const f = r.machines.find((m) => m.machine === 'Order').diagnostics.filter((d) => d.code === 'PL5101');
  assert.equal(f.length, 1, render(r));
  assert.match(f[0].engine, /poly-ref.*polyrun/);
  assert.deepEqual(steps(f[0]), ['Checkout', 'Hurry']);
});

test('S50: a signal to a child not yet spawned halts the parent, found by both engines as PL5104', async () => {
  const file = write('early-signal.poly', SRC.replace('    require status == Shipping else reject "not-shipping"\n    require !hurried', '    require status in { Open, Shipping } else reject "not-shipping"\n    require !hurried'));
  const r = await checkFile(file, { root: OUT });
  const f = r.machines.find((m) => m.machine === 'Order').diagnostics.filter((d) => d.code === 'PL5104');
  assert.equal(f.length, 1, render(r));
  assert.match(f[0].engine, /poly-ref.*polyrun/);
  assert.deepEqual(steps(f[0]), ['Hurry']);
  assert.ok(!r.machines.flatMap((m) => m.diagnostics).some((d) => d.code === 'PL5102'));
});

test('a parent with children and no compose invariant is checked by poly-ref alone, and says so', async () => {
  const file = write('no-compose.poly', SRC.replace(/\n  compose invariant[\s\S]*?\n}\n$/, '\n}\n'));
  const r = await checkFile(file, { root: OUT });
  const order = r.machines.find((m) => m.machine === 'Order');
  assert.equal(order.instance.compositionByRefOnly, true);
  assert.match(render(r), /Order: the joint machine decided by poly-ref alone/);
});

test('M3-2: a parent that sends has its joint machine checked by polyrun\'s check-product too', async () => {
  // S58 kept a sending parent poly-ref's alone; polygraph 8.3.2 validates a sendTo and lets it leave the joint machine.
  const file = write('sends-peer.poly', SRC
    .replace("    hurried : bool        = false\n", "    hurried : bool        = false\n    peer    : Ref<Order>  = none\n")
    .replace("    status' = Shipping\n", "    status' = Shipping\n    send peer <- Hurry()\n"));
  const r = await checkFile(file, { root: OUT });
  const order = r.machines.find((m) => m.machine === 'Order');
  const stage = order.stages.find((s) => s.stage === 'composition');
  assert.equal(order.instance.compositionByRefOnly, undefined, render(r));
  assert.match(stage.engine, /polyrun/);
  assert.equal(order.verdict, 'CLEAN', render(r));
});

test('polyrun runs the lowered parent and child: creation, signal and completion', async () => {
  const [ship, order] = build(CHILDREN, 'children-run');
  const rt = await createRuntime({
    store: { sqlite: ':memory:' },
    machines: [
      { machineId: 'shop.Order', module: join(order.dir, 'next.cjs'), contract: join(order.dir, 'contract.json'), effects: { mapper: join(order.dir, 'effects.cjs'), manifest: join(order.dir, 'effects.manifest.json') } },
      { machineId: 'shop.Shipment', module: join(ship.dir, 'next.cjs'), contract: join(ship.dir, 'contract.json') },
    ],
  });
  try {
    await rt.create('shop.Order', 'o1');
    await rt.dispatch('o1', 'Checkout', {}, 'a1');
    await rt.dispatch('o1', 'Hurry', {}, 'a2');
    const [child] = await rt.store.listChildren('o1');
    assert.equal((await rt.getState(child.instance_id)).state.ship, 'Sent');
    assert.equal((await rt.getState(child.instance_id)).state.size, 1);
    await rt.dispatch(child.instance_id, 'Deliver', {}, 'a3');
    assert.equal((await rt.getState('o1')).state.status, 'Done');
  } finally {
    await rt.close();
  }
});

test('S52: an action wired as a child completion and as an effect completion or a timer action is PL6102', () => {
  const withEffect = SRC.replace('\n  compose invariant', '\n  effect notify(n: 0..1) {\n    labels { exec }\n    ok -> Shipped()\n  }\n  compose invariant');
  assert.deepEqual(codes(withEffect), ['PL6102']);
  const withTimer = SRC.replace('    signal box -> Send()', '    signal box -> Send()\n    after 5m -> Shipped() as late');
  assert.deepEqual(codes(withTimer), ['PL6102']);
  // S81: the child's cancel action, also armed as a timer of the child, is legal: the runtime accepts a
  // cancel action from outside, since K9 names completions only (S80).
  const cancelTimer = SRC.replace("    ship' = Sent\n", "    ship' = Sent\n    after 1h -> Void(reason: \"parent-terminal\") as expiry\n");
  assert.deepEqual(codes(cancelTimer), []);
});

