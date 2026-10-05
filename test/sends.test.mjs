// Plan step 8, addresses and messages (PS1.6, PS2.2): `Ref<M>`, `none`, `self` and `send` in a machine
// checked alone. The domain of an address alone (S57), the sendTo intent and the self marker (S58), and
// stage 3 of a sending machine, which polyrun reads since M3-2. Configurations are in checkout.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { lowerMachine } from '@poly/lower';
import { checkMachine, loadLoweredModule } from '@poly/ref';
import { checkFile, render } from '@poly/check';
import { ROOT, BUILD, build } from './helpers.mjs';

const SENDS = join(ROOT, 'conformance', 'm1', 'sends.poly');
const SRC = readFileSync(SENDS, 'utf8');
const OUT = join(BUILD, 'sends');

const codes = (src) => {
  const p = parse(src);
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  return checkModule(p.module).diagnostics.map((d) => d.code);
};

test('S57: alone, an address ranges over none and one address per Ref field plus the most Ref parameters of one action', () => {
  const m = parse(SRC).module;
  const lock = checkMachine(m, 'Lock');
  // One Ref<Client> field and one Ref<Client> parameter per action: none, Client#1, Client#2.
  assert.deepEqual(lock.instance.params.map((p) => p.domain), ['{none, Client#1, Client#2}', '{none, Client#1, Client#2}']);
  assert.equal(lock.states, 3);
  // With `none` alone (M0's reading) a lock is never held, and a release by another client is never tried.
  const other = lock.graph.edges.find((e) => e.label.action === 'Release' && e.label.verdict.reason === 'not-owner');
  assert.ok(other, 'a release by a client that does not hold the lock is explored');
  assert.equal(lock.graph.states[other.from].owner === other.label.data.from, false);
  const inventory = checkMachine(m, 'Inventory');
  assert.deepEqual(inventory.instance.params.map((p) => p.domain), ['{none, Order#1}', '{none, Order#1}']);
});

test('S57: for the machine\'s own type, self is one more distinct address, in poly-ref and in the lowering', () => {
  const src = `module peers
machine Peer {
  state { next: Ref<Peer> = none   linked: bool = false }
  action Link(p: Ref<Peer>)
  action Hello(from: Ref<Peer>)
  on Link(p) { require !linked else reject "linked"   next' = p   linked' = true   send p <- Hello(from: self) }
  on Hello(from) { require from != next else reject "loop"   linked' = true }
}
`;
  const m = parse(src).module;
  // One Ref<Peer> field, one Ref<Peer> parameter per action, and self: none and three addresses.
  assert.deepEqual(checkMachine(m, 'Peer').instance.params.map((p) => p.domain), ['{none, Peer#1, Peer#2, Peer#3}', '{none, Peer#1, Peer#2, Peer#3}']);
  const check = checkModule(m);
  const { lowered } = lowerMachine(m, check, 'Peer');
  assert.deepEqual(lowered.contract.dataDomain.Link.p, [null, 'Peer#1', 'Peer#2', 'Peer#3']);
});

test('S58: a send lowers to sendTo, an address to its string, none to null, and self to the kernel marker', () => {
  const order = build(SENDS, 'sends').find((b) => b.machine === 'Order');
  const { effects } = loadLoweredModule(join(order.dir, 'effects.cjs'));
  const pre = { st: 'Idle', inv: null };
  assert.deepEqual(effects(pre, 'Place', {}, { st: 'Asked', inv: null }, 'accepted'), [{ kind: 'sendTo', target: null, action: 'Query', data: { from: { $ref: 'self' } } }]);
  assert.deepEqual(effects({ st: 'Asked', inv: 'inv-1' }, 'Available', { n: 1 }, {}, 'accepted'), [{ kind: 'sendTo', target: 'inv-1', action: 'Take', data: { from: { $ref: 'self' } } }]);
  assert.deepEqual(effects({ st: 'Asked', inv: 'inv-1' }, 'Available', { n: 0 }, {}, 'accepted'), []);
  const lock = build(SENDS, 'sends').find((b) => b.machine === 'Lock');
  const contract = JSON.parse(readFileSync(join(lock.dir, 'contract.json'), 'utf8'));
  assert.deepEqual(contract.dataDomain.Acquire.from, [null, 'Client#1', 'Client#2']);
  assert.match(readFileSync(join(lock.dir, 'next.cjs'), 'utf8'), /"from":\{"type":"string","required":true,"nullable":true\}/);
});

test('the checker types sends against the receiver, and refuses self outside a send argument and send … as', () => {
  const base = SRC;
  const swap = (from, to) => { assert.ok(base.includes(from), from); return codes(base.replace(from, to)); };
  assert.deepEqual(codes(base), []);
  assert.deepEqual(swap('send inv <- Query(from: self)', 'send inv <- Ask(from: self)'), ['PL1001']);
  assert.deepEqual(swap('send inv <- Query(from: self)', 'send inv <- Query(from: inv)'), ['PL1201']);
  assert.deepEqual(swap('send inv <- Query(from: self)', 'send st <- Query(from: self)'), ['PL1201']);
  assert.deepEqual(swap('send inv <- Query(from: self)', 'send none <- Query(from: self)'), ['PL1201']);
  assert.deepEqual(swap('send inv <- Query(from: self)', 'send inv <- Query(from: self) as q'), ['PL0901']);
  assert.deepEqual(swap("owner' = from", "owner' = self"), ['PL0901']);
  assert.deepEqual(swap('inv: Ref<Inventory> = none', 'inv: Ref<Warehouse> = none'), ['PL1001']);
  // S176: another module's machine is nameable once its module is used; without `use` it is an unknown name.
  assert.deepEqual(swap('inv: Ref<Inventory> = none', 'inv: Ref<other.Inventory> = none'), ['PL1001']);
});

test('M3-2: a machine that sends and has a path property runs polyrun\'s check-effects at stage 3', async () => {
  const dir = join(OUT, 'sources');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'path-and-send.poly');
  // A path property counts effect kinds (PS5.4), so the order gains one effect beside its sends.
  writeFileSync(file, SRC.replace("st' = Done }", "st' = Done   emit confirmed() }\n  effect confirmed() { labels { write:store } }\n  path property confirmed-once: count(\"confirmed\") <= 1"));
  const r = await checkFile(file, { root: OUT });
  const order = r.machines.find((m) => m.machine === 'Order');
  const stage = order.stages.find((s) => s.stage === 'effects');
  // S58 kept it poly-ref's alone while polyrun had no sendTo; polygraph 8.3.2 has one (S89).
  assert.match(stage.engine, /polyrun@8\.3\.2/);
  assert.doesNotMatch(stage.note ?? '', /sendTo/);
  assert.equal(order.instance.effectsByRefOnly, undefined);
  assert.equal(stage.verdict, 'CLEAN', render(r));
});

test('S63: a reply that sends and writes nothing is not PL4002; an effect beside it still is', async () => {
  const r = await checkFile(SENDS, { root: OUT });
  for (const m of r.machines) assert.equal(m.verdict, 'CLEAN', render(r));
  const m = parse(SRC.replace('on Query(from) { send from <- Available(n: onHand) }', 'on Query(from) { send from <- Available(n: onHand)   emit seen() }\n  effect seen() { labels { write:store } }')).module;
  assert.deepEqual(checkMachine(m, 'Inventory').findings.map((d) => [d.code, d.property]), [['PL4002', 'Query']]);
});
