// Plan step 7, child families and bounded loops (S49): indexed keys, loops unrolled to a type bound with
// an i <= n guard, the restricted loop body, PL5101 for a double spawn, and compose invariants over a
// family through forall and the aggregates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse, format } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkJoint } from '@poly/ref';
import { checkFile, render } from '@poly/check';
import { createRuntime } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import { ROOT, BUILD, build } from './helpers.mjs';

const FAMILIES = join(ROOT, 'conformance', 'm1', 'families.poly');
const SRC = readFileSync(FAMILIES, 'utf8');
const OUT = join(BUILD, 'families');

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

test('S49: the families case checks clean; poly-ref and check-product count the same joint states', async () => {
  const r = await checkFile(FAMILIES, { root: OUT });
  assert.equal(r.verdict, 'CLEAN', render(r));
  const d = r.machines.find((m) => m.machine === 'Dispatch');
  assert.match(d.stages.find((s) => s.stage === 'composition').note, /^32 joint states \(polyrun 32\)$/);
  // The completion's childKey ranges over the family's keys (S51).
  assert.match(render(r), /Landed\.childKey ∈ \{"t1", "t2"\}/);
});

test('S49: the loop runs to n, so Plan(1) spawns t1 and Plan(2) spawns t1 and t2, each with its timer', () => {
  const r = checkJoint(parse(SRC).module, 'Dispatch');
  const plan = (n) => r.graph.edges.find((e) => e.from === 0 && e.stimulus.action === 'Plan' && e.stimulus.data.n === n);
  assert.deepEqual(r.graph.states[plan(1).to].children.map(([k]) => k), ['t1']);
  assert.deepEqual(r.graph.states[plan(2).to].children.map(([k]) => k), ['t1', 't2']);
});

test('S49: the formatter prints loops and indexed keys as they parse', () => {
  const m = parse(SRC).module;
  assert.equal(format(parse(format(m)).module), format(m));
  assert.match(format(m), /for i in 1\.\.n \{\n\s+spawn Truck as t\[i\] on complete -> Landed on parent terminal -> Drop/);
});

test('S49: the checker', () => {
  const swap = (a, b) => codes(SRC.replace(a, b));
  assert.deepEqual(codes(SRC), []);
  // (2) the bound is a literal, or a field or parameter with a range type.
  assert.deepEqual(swap('for i in 1..n {', 'for i in 1..n + 1 {'), ['PL1201']);
  // The index of a key is the loop variable, plus or minus a constant, or a constant.
  assert.deepEqual(swap('spawn Truck as t[i]', 'spawn Truck as t[n]').filter((c) => c === 'PL1201'), ['PL1201']);
  // (3) a timer key not indexed by i is armed twice by two copies: PL2301.
  assert.deepEqual(swap('after 1h -> Stop() as late[i]', 'after 1h -> Stop() as late'), ['PL2301']);
  // A whole write in the body is written twice by two copies: PL2102.
  assert.deepEqual(swap('      marks\' = marks with [i] = true', '      landed\' = 0'), ['PL2102']);
  // Only intents and map-entry writes: a require is refused.
  assert.deepEqual(swap('      marks\' = marks with [i] = true', '      require trucks < 2 else reject "full"'), ['PL1201']);
  // (4) spawning one key twice on one path is PL5101: a key not indexed, in a loop that runs twice.
  assert.deepEqual(swap('spawn Truck as t[i] on complete', 'spawn Truck as t[1] on complete').filter((c) => c === 'PL5101'), ['PL5101']);
  // Compose invariants: t[i] narrows children.t[i]; [*] only inside an aggregate, over one family.
  assert.deepEqual(swap('forall i in t: t[i] spawned implies parent.phase != Idle', 'forall i in t: children.t[i].leg != Waiting'), ['PL5103']);
  assert.deepEqual(swap('forall i in t: t[i] spawned implies parent.phase != Idle', 'children.t[*].leg != Waiting'), ['PL1201']);
  assert.deepEqual(swap('forall i in t: t[i] spawned implies parent.phase != Idle', 'forall i in u: parent.trucks >= 0'), ['PL1001']);
});

test('S49: a violated count over a family is found by poly-ref and confirmed by check-product', async () => {
  const file = write('miscount.poly', SRC.replace('>= parent.landed', '<= parent.landed'));
  const r = await checkFile(file, { root: OUT });
  const f = r.machines.find((m) => m.machine === 'Dispatch').diagnostics.filter((d) => d.code === 'PL5001');
  assert.equal(f.length, 1, render(r));
  assert.equal(f[0].property, 'landed-counts');
  assert.match(f[0].engine, /poly-ref.*polyrun/);
  assert.ok(!r.machines.flatMap((m) => m.diagnostics).some((d) => d.code === 'PL2501'));
});

test('S49: under polyrun, Plan(2) spawns t1 and t2 and arms late1 and late2', async () => {
  const [truck, dispatch] = build(FAMILIES, 'families-run');
  const rt = await createRuntime({
    store: { sqlite: ':memory:' },
    machines: [
      { machineId: 'fleet.Dispatch', module: join(dispatch.dir, 'next.cjs'), contract: join(dispatch.dir, 'contract.json'), effects: { mapper: join(dispatch.dir, 'effects.cjs'), manifest: join(dispatch.dir, 'effects.manifest.json') } },
      { machineId: 'fleet.Truck', module: join(truck.dir, 'next.cjs'), contract: join(truck.dir, 'contract.json') },
    ],
  });
  try {
    await rt.create('fleet.Dispatch', 'd1');
    await rt.dispatch('d1', 'Plan', { n: 2 }, 'a1');
    const kids = await rt.store.listChildren('d1');
    assert.deepEqual(kids.map((c) => c.child_key).sort(), ['t1', 't2']);
    const s = (await rt.getState('d1')).state;
    assert.deepEqual(s.marks, [false, true, true]);
    // A truck that arrives completes into the parent with its key and state.
    await rt.dispatch(kids[0].instance_id, 'Go', {}, 'a2');
    await rt.dispatch(kids[0].instance_id, 'Arrive', {}, 'a3');
    assert.equal((await rt.getState('d1')).state.landed, 1);
  } finally {
    await rt.close();
  }
});

test('polywatch: a completion wired to a family takes the family\'s keys as its childKey domain in the lowered contract', () => {
  const [, dispatch] = build(FAMILIES, 'families-domain');
  assert.deepEqual(dispatch.lowered.contract.dataDomain.Landed.childKey, ['t1', 't2']);
});

test('polywatch: signal t[i] names one member of the family', async () => {
  const src = SRC.replace('      marks\' = marks with [i] = true', '      marks\' = marks with [i] = true\n      signal t[i] -> Go()');
  assert.deepEqual(codes(src), []);
  const r = await checkFile(write('signal-family.poly', src), { root: OUT });
  assert.ok(!r.machines.flatMap((m) => m.diagnostics).some((d) => d.code === 'PL2501'), render(r));
});

test('polywatch: an entry write outside the loop and the loop\'s entry writes both land', async () => {
  const src = SRC.replace('    trucks\' = n\n', '    trucks\' = n\n    marks\' = marks with [0] = true\n');
  assert.deepEqual(codes(src), []);
  const r = await checkFile(write('map-both.poly', src), { root: OUT });
  assert.ok(!r.machines.flatMap((m) => m.diagnostics).some((d) => d.code === 'PL2501'), render(r));
});

test('S55: entry writes combine only for distinct constant keys: literals, constructors, or loop indices', () => {
  const m = (body) => `module t\nenum Door { Open, Shut }\nmachine M {\n  state {\n    k : 0..1 = 0\n    d : map<Door, 0..1> = { Open: 0, Shut: 0 }\n  }\n  action Go(x: Door)\n  on Go(x) {\n    require k == 0 else reject "done"\n    k' = 1\n${body}\n  }\n}\n`;
  assert.deepEqual(codes(m('    d\' = d with [Open] = 1\n    d\' = d with [Shut] = 1')), [], 'two constructors');
  assert.deepEqual(codes(m('    d\' = d with [Open] = 1\n    d\' = d with [Door.Open] = 0')), ['PL2102'], 'one constructor twice');
  assert.deepEqual(codes(m('    d\' = d with [x] = 1\n    d\' = d with [Shut] = 1')), ['PL2102'], 'a parameter key with another entry');
  assert.deepEqual(codes(m('    d\' = d with [x] = 1')), [], 'a parameter key alone');
  assert.deepEqual(codes(m('    d\' = { Open: 1, Shut: 1 }\n    d\' = d with [Shut] = 0')), ['PL2102'], 'a whole write with an entry write');
});
