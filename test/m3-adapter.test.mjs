// The host adapter generator of M3 (M3-4, S90, S91), on its fixture: examples/checkout/checkout.poly behind a
// host interface of three members and the network API. The map is validated against the interface and the
// module, and every way it can name something that does not exist is a failed build that writes nothing.
// A valid map gives an adapter over polyrun whose messages wait until delivered, one at a time or all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse } from '@poly/lang';
import { printModule } from '@poly/embed';
import { generate } from '../experiments/m3/adapter/generate.mjs';
import { ROOT, BUILD } from './helpers.mjs';

const FX = join(ROOT, 'experiments', 'm3', 'adapter', 'fixtures', 'checkout');
const MODULE = join(ROOT, 'examples', 'checkout', 'checkout.poly');
const MAP = JSON.parse(readFileSync(join(FX, 'host.map.json'), 'utf8'));

let n = 0;
// A host interface with a member named as the adapter's own __state.
const RESERVED = join(BUILD, 'm3-adapter', 'reserved.host.ts');
mkdirSync(join(BUILD, 'm3-adapter'), { recursive: true });
writeFileSync(RESERVED, readFileSync(join(FX, 'host.ts'), 'utf8').replace('  stock(): Promise<{ onHand: number } | null>;', '  stock(): Promise<{ onHand: number } | null>;\n  __state(): Promise<unknown>;'));

async function build(map = MAP, module = MODULE, hostFile = join(FX, 'host.ts')) {
  const out = join(BUILD, 'm3-adapter', String(++n));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const mapFile = join(out, 'host.map.json');
  writeFileSync(mapFile, JSON.stringify(map));
  const r = generate({ mapFile, hostFile, moduleFile: module, out });
  return { ...r, out };
}
const host = async (out) => (await import(pathToFileURL(join(out, 'host.gen.ts')).href)).default();

test('M3-4: the adapter creates the inventory with the host and an order per place, and nothing is delivered until asked (S91)', async (t) => {
  const r = await build();
  assert.equal(r.errors, undefined, r.errors?.join('\n'));
  const h = await host(r.out);
  t.after(() => h.__dispose());
  assert.deepEqual(await h.stock(), { onHand: 1 });
  assert.equal(await h.order('o1'), null, 'no order before place');
  assert.deepEqual(await h.place('o1'), { ok: true });
  assert.deepEqual(await h.place('o2'), { ok: true });
  // The brief's refusal: an order is placed once.
  assert.deepEqual(await h.place('o1'), { ok: false, reason: 'not-idle' });
  assert.deepEqual((await h.inFlight()).map((m) => [m.id, m.from, m.to, m.action]), [['o1:1:0', 'o1', 'inv', 'Query'], ['o2:1:0', 'o2', 'inv', 'Query']]);
  assert.deepEqual(await h.order('o1'), { status: 'Asked' });
  await h.deliverAll();
  assert.deepEqual(await h.inFlight(), []);
  assert.deepEqual([(await h.order('o1')).status, (await h.order('o2')).status, (await h.stock()).onHand], ['Done', 'Refused', 0]);
});

test('M3-4: deliver takes one message by id, so a test chooses the arrival order', async (t) => {
  const r = await build();
  const h = await host(r.out);
  t.after(() => h.__dispose());
  await h.place('o1');
  await h.place('o2');
  // o2 is answered first, and takes the item.
  for (;;) {
    const m = (await h.inFlight()).find((x) => x.from === 'o2' || x.to === 'o2') ?? (await h.inFlight())[0];
    if (!m) break;
    await h.deliver(m.id);
  }
  assert.deepEqual([(await h.order('o1')).status, (await h.order('o2')).status], ['Refused', 'Done']);
  await assert.rejects(() => h.deliver('o1:1:0'), /no message o1:1:0 in transit/);
});

test('M3-4: the adapter is generated from an embedded module as well', async (t) => {
  const dir = join(BUILD, 'm3-adapter', 'embedded');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'checkout.ts');
  writeFileSync(file, printModule(parse(readFileSync(MODULE, 'utf8')).module));
  const r = await build(MAP, file);
  assert.equal(r.errors, undefined, r.errors?.join('\n'));
  const h = await host(r.out);
  t.after(() => h.__dispose());
  await h.place('o1');
  await h.deliverAll();
  assert.deepEqual(await h.order('o1'), { status: 'Done' });
});

// S90: each way a map can name what does not exist, and the error that names it.
const BROKEN = [
  ['a map naming a machine that does not exist', (m) => { m.instances.inv.machine = 'Warehouse'; }, /instances\.inv: no machine 'Warehouse'/],
  ['a map naming an action that does not exist', (m) => { m.methods.place.action = 'Order'; }, /methods\.place: Order has no action 'Order'/],
  ['a map naming a parameter that does not exist', (m) => { m.methods.place.params = { qty: 1 }; }, /Order\.Place has no parameter 'qty'/],
  ['a map naming an argument that does not exist', (m) => { m.methods.place.key = '$arg:id'; }, /methods\.place\.key: 'id' is not an argument of place\(order\)/],
  ['a map naming a field that does not exist', (m) => { m.queries.stock.fields.onHand = 'count'; }, /queries\.stock\.fields\.onHand: Inventory has no field 'count'/],
  ['a map naming an instance that does not exist', (m) => { m.queries.stock.instance = 'store'; }, /queries\.stock: no instance or family 'store'/],
  ['a map naming an init field that does not exist', (m) => { m.instances.order.init = { warehouse: 'inv' }; }, /instances\.order\.init: Order has no field 'warehouse'/],
  ['a map naming an init address that does not exist', (m) => { m.instances.order.init = { inv: 'o9' }; }, /instances\.order\.init\.inv: "o9" is not an instance created with the host/],
  ['a map naming a Host member that does not exist', (m) => { m.queries.orders = { instance: 'inv', fields: {} }; }, /queries\.orders: the Host interface has no method 'orders'/],
  ['a Host member the map leaves unmapped', (m) => { delete m.queries.stock; }, /the Host interface's 'stock' is neither a method nor a query of the map/],
  ['an action parameter the map does not give', (m) => { m.methods.place.action = 'Available'; }, /Order\.Available takes 'n', which the map does not give/],
  ['a family used without its key', (m) => { delete m.queries.order.key; }, /queries\.order: 'order' is a family/],
  ['a map naming another module', (m) => { m.module = 'shop'; }, /module: the map names 'shop', and the module is 'checkout'/],
  ['an instance named by an argument without its machine', (m) => { m.methods.place = { instance: '$arg:order', action: 'Place' }; }, /methods.place: an instance named by an argument needs "machine"/],
  ['an instance named by an argument that is not one', (m) => { m.queries.stock.instance = '$arg:shelf'; m.queries.stock.machine = 'Inventory'; }, /queries.stock.instance: 'shelf' is not an argument of stock()/],
  ['a machine given for a named instance', (m) => { m.queries.stock.machine = 'Inventory'; }, /queries.stock: "machine" goes only with an instance named by an argument/],
  ['a Host member the adapter reserves', null, /the Host interface has a member '__state', which the adapter reserves/],
  ['a map driving the network API itself', (m) => { m.methods.deliver = { instance: 'inv', action: 'Query', params: { from: null } }; }, /'deliver' is the network API/],
];

for (const [what, breakIt, message] of BROKEN) {
  test(`S90: ${what} is a failed build, and nothing is written`, async () => {
    const map = structuredClone(MAP);
    breakIt?.(map);
    const r = await build(map, MODULE, breakIt ? join(FX, 'host.ts') : RESERVED);
    assert.ok(r.errors?.length, `${what}: the build did not fail`);
    assert.ok(r.errors.some((e) => message.test(e)), r.errors.join('\n'));
    assert.equal(existsSync(join(r.out, 'host.gen.ts')), false);
  });
}
