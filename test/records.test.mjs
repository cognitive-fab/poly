// Plan step 7, records (S25): declaration, literals, field reads, equality, the checker's rules, the
// lowering to plain JSON objects, and a completion that receives the child's state as a record (S44, S51).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse, format } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkFile, render } from '@poly/check';
import { createRuntime } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import { ROOT, BUILD, build, requireModule } from './helpers.mjs';

const RECORDS = join(ROOT, 'conformance', 'm1', 'records.poly');
const CHILDREN = readFileSync(join(ROOT, 'conformance', 'm1', 'children.poly'), 'utf8');
const OUT = join(BUILD, 'records');

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

test('S25: the records conformance case checks clean, and its record lowers to a plain object', async () => {
  const r = await checkFile(RECORDS, { root: OUT });
  assert.equal(r.verdict, 'CLEAN', render(r));
  const [b] = build(RECORDS, 'records');
  assert.deepEqual(b.lowered.contract.initState, { done: false, box: { size: 'Small', count: 0 } });
  const mod = requireModule(b.dir);
  assert.deepEqual(mod.instance({}).validate(), []);
  mod.init();
  mod.actions.Fill({ with: { size: 'Large', count: 1 } });
  assert.deepEqual(mod.getState().box, { size: 'Large', count: 1 });
});

test('S25: the formatter prints a record declaration as it parses', () => {
  const src = 'module t\n\ntype Box = { size: 0..2, open: bool }\n';
  assert.equal(format(parse(src).module), src);
});

test('S25: the checker', () => {
  const m = (decls, body = '') => `module t\nenum Size { Small, Large }\n${decls}\nmachine M {\n  state { box : Box = { size: Small, n: 0 } }\n  action Go()\n  on Go { require box.n == 0 else reject "done"  box' = { size: Large, n: 1 }${body} }\n}\n`;
  const box = 'type Box = { size: Size, n: 0..1 }';
  assert.deepEqual(codes(m(box)), []);
  assert.deepEqual(codes(m('type Box = { size: Size, size: Size, n: 0..1 }')), ['PL1002']);
  assert.deepEqual(codes(m('type Box = { size: Size, n: 0..1, inner: Box }')), ['PL1201'], 'a record may not refer to itself');
  assert.deepEqual(codes(m('type Box = { size: Size, n: int }')), ['PL1101']);
  assert.deepEqual(codes(m(box).replace('box\' = { size: Large, n: 1 }', 'box\' = { size: Large }')), ['PL1502']);
  assert.deepEqual(codes(m(box).replace('box\' = { size: Large, n: 1 }', 'box\' = { size: Large, n: 1, colour: 2 }')), ['PL1001']);
  assert.deepEqual(codes(m(box).replace('require box.n == 0', 'require box.weight == 0')), ['PL1001']);
  assert.deepEqual(codes(m(box).replace('require box.n == 0', 'require box == { size: Small, n: 0 }')), []);
  assert.deepEqual(codes(m(box).replace('require box.n == 0', 'require box.size == 1')), ['PL1201']);
  // A literal with no expected type is a map or a record by nothing: ambiguous (S25).
  assert.deepEqual(codes(m(box, '\n    let x = { size: Small, n: 0 }')), ['PL1005']);
});

// The children case with the completion receiving the shipment's terminal state (S44, S51).
const WITH_STATE = CHILDREN
  .replace('enum ShipStatus { Pending, Sent, Delivered, Voided }', 'enum ShipStatus { Pending, Sent, Delivered, Voided }\ntype ShipState = { ship: ShipStatus, size: 0..2 }')
  .replace('    status  : OrderStatus = Open\n    hurried : bool        = false', '    status  : OrderStatus = Open\n    hurried : bool        = false\n    lost    : bool        = false')
  .replace('  action Shipped()', '  action Shipped(childKey: string, childState: ShipState)')
  .replace('  on Shipped {\n    require status == Shipping else reject "not-shipping"\n    status\' = Done', '  on Shipped(childKey, childState) {\n    require status == Shipping else reject "not-shipping"\n    status\' = Done\n    lost\' = childState.ship == Voided');

test('S44, S51: a completion receives the child key and state; both engines and the runtime agree', async () => {
  assert.deepEqual(codes(WITH_STATE), []);
  const file = write('with-state.poly', WITH_STATE);
  const r = await checkFile(file, { root: OUT });
  assert.equal(r.verdict, 'CLEAN', render(r));
  const order = r.machines.find((m) => m.machine === 'Order');
  assert.match(order.stages.find((s) => s.stage === 'composition').note, /joint states \(polyrun (\d+)\)/);
  const [joint, polyrun] = /(\d+) joint states \(polyrun (\d+)\)/.exec(order.stages.find((s) => s.stage === 'composition').note).slice(1);
  assert.equal(joint, polyrun);
  // The completion's childKey domain is the one key wired to it (S51).
  const [, o] = build(file, 'with-state');
  assert.deepEqual(o.lowered.contract.dataDomain.Shipped.childKey, ['box']);
  // Under polyrun, a voided box completes the order with lost = true.
  const [ship, ord] = build(file, 'with-state-run');
  const rt = await createRuntime({
    store: { sqlite: ':memory:' },
    machines: [
      { machineId: 'shop.Order', module: join(ord.dir, 'next.cjs'), contract: join(ord.dir, 'contract.json'), effects: { mapper: join(ord.dir, 'effects.cjs'), manifest: join(ord.dir, 'effects.manifest.json') } },
      { machineId: 'shop.Shipment', module: join(ship.dir, 'next.cjs'), contract: join(ship.dir, 'contract.json') },
    ],
  });
  try {
    await rt.create('shop.Order', 'o1');
    await rt.dispatch('o1', 'Checkout', {}, 'a1');
    const [child] = await rt.store.listChildren('o1');
    await rt.dispatch(child.instance_id, 'Void', { reason: 'parent-terminal' }, 'a2');
    const s = (await rt.getState('o1')).state;
    assert.equal(s.status, 'Done');
    assert.equal(s.lost, true);
  } finally {
    await rt.close();
  }
});

test('S44: childState must be a record of the child\'s fields and types', () => {
  assert.deepEqual(codes(WITH_STATE.replace('type ShipState = { ship: ShipStatus, size: 0..2 }', 'type ShipState = { ship: ShipStatus }')).filter((c) => c === 'PL1201'), ['PL1201']);
  assert.deepEqual(codes(WITH_STATE.replace('type ShipState = { ship: ShipStatus, size: 0..2 }', 'type ShipState = { ship: ShipStatus, size: bool }')).filter((c) => c === 'PL1201'), ['PL1201']);
});
