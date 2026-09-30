// Plan step 5: effects (PT6.1, PT6.2), intents in the handler semantics (PS2.1, PS2.2), path properties
// (PS5.4, PL4001), emission without a state change (S33, PL4002), the three new artefacts, and polyrun's
// check-effects as stage 3, its findings confirmed by poly-ref.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkMachine } from '@poly/ref';
import { checkFile, checkProject, render } from '@poly/check';
import { createRuntime } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import { ROOT, BUILD, build, requireModule } from './helpers.mjs';

const ORDERS = join(ROOT, 'examples', 'orders', 'orders.poly');
const OUT = join(BUILD, 'effects');

const steps = (d) => d.witness.trace.map((s) => `${s.action}(${Object.values(s.data).join(', ')})`);

test('PT4.5: the orders program has its three findings, with the witnesses the specification prints', async () => {
  const r = await checkFile(ORDERS, { root: OUT });
  const m = r.machines[0];
  const by = (code) => m.diagnostics.filter((d) => d.code === code);
  assert.equal(r.verdict, 'FINDINGS');
  // 1. Domain escape.
  assert.deepEqual(steps(by('PL3102')[0]), ['AddItem()', 'AddItem()', 'AddItem()', 'AddItem()']);
  // 2. Double charge.
  const charge = by('PL4001');
  assert.equal(charge.length, 1);
  assert.equal(charge[0].property, 'charge-at-most-once');
  assert.deepEqual(steps(charge[0]), ['AddItem()', 'Place()', 'Pay(10)', 'Pay(10)']);
  // 3. Emit without state change, confirmed by both engines (S33).
  const idle = by('PL4002');
  assert.equal(idle.length, 1);
  assert.equal(idle[0].property, 'Pay');
  assert.deepEqual(steps(idle[0]), ['AddItem()', 'Place()', 'Pay(10)', 'Pay(10)']);
  assert.match(idle[0].engine, /poly-ref.*polyrun/);
  // The finding points at the handler, the path property at its declaration.
  const src = readFileSync(ORDERS, 'utf8').split('\n');
  assert.match(src[idle[0].at.line - 1], /on Pay\(amount\)/);
  assert.match(src[charge[0].at.line - 1], /path property charge-at-most-once/);
  // The text form shows which steps emit.
  assert.match(render(r), /Pay\(10\)\s+Placed\/1\/false -> Placed\/1\/false\s+emits payment\.charge/);
});

test('S42: with place-empty narrowed to the draft state, PT4.5 has exactly its three findings', async () => {
  const r = await checkFile(ORDERS, { root: OUT });
  const m = r.machines[0];
  assert.deepEqual([...new Set(m.diagnostics.map((d) => d.code))].sort(), ['PL3102', 'PL4001', 'PL4002']);
  // The escape names a field and points at the machine; the findings of one stage do not share a position.
  const src = readFileSync(ORDERS, 'utf8').split('\n');
  const escape = m.diagnostics.find((x) => x.code === 'PL3102');
  assert.match(src[escape.at.line - 1], /machine Order/);
});

test('S42: a reject property polygraph reports points at its declaration', async () => {
  // The narrowing S42 replaced: Place in a cancelled order with no items is rejected "terminal" (PS3.2, row 1).
  const file = write('orders-wide.poly', readFileSync(ORDERS, 'utf8').replace('pre.status == Draft && pre.items == 0', 'pre.items == 0'));
  const r = await checkFile(file, { root: OUT });
  const d = r.machines[0].diagnostics.find((x) => x.code === 'PL3003');
  assert.deepEqual(steps(d), ['Cancel(Customer)', 'Place()']);
  assert.match(readFileSync(file, 'utf8').split('\n')[d.at.line - 1], /reject property place-empty/);
});

test('S41: effects that share a kind must agree; identical declarations may share it', () => {
  const two = (a, b) => `module t\nmachine M {\n  state { n : 0..1 = 0 }\n  action Go()\n  on Go { require n == 0 else reject "done"  n' = 1  emit one(1) }\n  effect one(n: 0..1) {\n    kind "k.x"\n    labels { exec }\n${a}  }\n  effect two(n: 0..1) {\n    kind "k.x"\n    labels { exec }\n${b}  }\n}\n`;
  assert.deepEqual(codes(two('', '')), []);
  assert.deepEqual(codes(two('    class irreversible\n', '')), ['PL1002']);
  // An effect with no kind has its name as its kind (S41).
  const named = 'module t\nmachine M {\n  state { n : 0..1 = 0 }\n  action Go()\n  on Go { require n == 0 else reject "done"  n\' = 1  emit ping(1) }\n  effect ping(n: 0..1) {\n    labels { exec }\n  }\n  effect pong(m: bool) {\n    kind "ping"\n    labels { exec }\n  }\n}\n';
  assert.deepEqual(codes(named), ['PL1002']);
});

test('S41: two modules of one project that declare one kind differently are PL1002', async () => {
  const dir = join(OUT, 'project-kinds');
  mkdirSync(join(dir, 'src'), { recursive: true });
  const mod = (name, cls) => `module ${name}\nmachine M {\n  state { n : 0..1 = 0 }\n  action Go()\n  on Go { require n == 0 else reject "done"  n' = 1  emit ping(1) }\n  effect ping(n: 0..1) {\n    kind "shared.ping"\n    labels { exec }\n    class ${cls}\n  }\n}\n`;
  writeFileSync(join(dir, 'src', 'a.poly'), mod('a', 'none'));
  writeFileSync(join(dir, 'src', 'b.poly'), mod('b', 'irreversible'));
  writeFileSync(join(dir, 'poly.json'), '{ "poly": "1", "name": "kinds", "modules": ["src/*.poly"] }');
  const p = await checkProject(dir, { root: OUT });
  const all = p.files.flatMap((f) => f.diagnostics);
  assert.ok(all.some((d) => d.code === 'PL1002' && /shared\.ping/.test(d.message)), JSON.stringify(all.map((d) => [d.code, d.message])));
  assert.equal(p.verdict, 'REFUSED');
  writeFileSync(join(dir, 'src', 'b.poly'), mod('b', 'none'));
  const same = await checkProject(dir, { root: OUT });
  assert.ok(!same.files.flatMap((f) => f.diagnostics).some((d) => d.code === 'PL1002'));
});

test('S37: before(k1, k2) is decided by poly-ref and by polyrun, and they agree', async () => {
  // Ship must follow Pack: before("w.pack", "w.ship"). Ship without Pack violates it at once.
  const file = write('before.poly', 'module bf\nenum P { Start, Packed, Shipped }\nmachine M {\n  state { p : P = Start }\n  terminal p == Shipped\n  action Pack()\n  action Ship()\n  on Pack { require p == Start else reject "no"  p\' = Packed  emit pack(1) }\n  on Ship { require p != Shipped else reject "no"  p\' = Shipped  emit ship(1) }\n  path property pack-first: before("w.pack", "w.ship")\n  effect pack(n: 0..1) {\n    kind "w.pack"\n    labels { write:store }\n  }\n  effect ship(n: 0..1) {\n    kind "w.ship"\n    labels { egress:external }\n  }\n}\n');
  const r = await checkFile(file, { root: OUT });
  const m = r.machines[0];
  const f = m.diagnostics.filter((d) => d.code === 'PL4001');
  assert.equal(f.length, 1);
  assert.deepEqual(steps(f[0]), ['Ship()']);
  assert.match(f[0].engine, /poly-ref.*polyrun/);
  assert.ok(!m.diagnostics.some((d) => d.code === 'PL2501'));
});

test('PT6.1: the manifest is the one the specification shows, labels and class included', () => {
  const [b] = build(ORDERS, 'effects');
  const manifest = JSON.parse(readFileSync(join(b.dir, 'effects.manifest.json'), 'utf8'));
  assert.deepEqual(manifest, { effects: { 'payment.charge': {
    payloadSchema: { amount: { type: 'number', required: true } },
    onSuccess: { action: 'PaymentOk' },
    onFailure: { action: 'PaymentFailed', data: { code: 'declined' } },
    onExhausted: { action: 'PaymentFailed', data: { code: 'exhausted' } },
    retry: { maxAttempts: 3, baseMs: 200, timeoutMs: 5000 },
    labels: ['egress:external'], class: 'irreversible',
  } } });
  const inv = readFileSync(join(b.dir, 'effect-invariants.mjs'), 'utf8');
  assert.match(inv, /name: "charge-at-most-once", pred: \(p\) => p\.count\("payment\.charge"\) <= 1/);
});

test('M1-1: the step that only emits classifies unchanged, an accepted step, and PT3.4a makes amount strict', () => {
  const [b] = build(ORDERS, 'effects');
  const mod = requireModule(b.dir);
  mod.init();
  mod.setState({ ...b.lowered.contract.initState, status: 'Placed', items: 1 });
  mod.actions.Pay({ amount: 10 });
  assert.equal(mod.instance({}).lastStep().classification, 'unchanged');
  // amount flows into the irreversible charge, so its check domain is strict: Pay(15) is refused at dispatch.
  mod.init();
  mod.setState({ ...b.lowered.contract.initState, status: 'Placed', items: 1 });
  mod.actions.Pay({ amount: 15 });
  const step = mod.instance({}).lastStep();
  assert.equal(step.classification, 'rejected');
  assert.equal(step.rejections[0].reason, 'outside-check-domain');
});

test('M1-1: polyrun runs the lowered orders machine, journals Pay accepted and derives its charge', async () => {
  const [b] = build(ORDERS, 'effects-run');
  const charges = [];
  const rt = await createRuntime({
    store: { sqlite: ':memory:' },
    machines: [{ machineId: 'orders.Order', module: join(b.dir, 'next.cjs'), contract: join(b.dir, 'contract.json'), effects: { mapper: join(b.dir, 'effects.cjs'), manifest: join(b.dir, 'effects.manifest.json') } }],
    handlers: { 'payment.charge': async (payload) => { charges.push(payload); return {}; } },
  });
  try {
    await rt.create('orders.Order', 'o1');
    await rt.dispatch('o1', 'AddItem', {}, 'a1');
    await rt.dispatch('o1', 'Place', {}, 'a2');
    const pay = await rt.dispatch('o1', 'Pay', { amount: 10 }, 'a3');
    assert.equal(pay.stepKind, 'accepted');
    await rt.workers.tickEffects();
    assert.deepEqual(charges, [{ amount: 10 }]);
  } finally {
    await rt.close();
  }
});

const codes = (src) => {
  const p = parse(src);
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  return checkModule(p.module).diagnostics.map((d) => d.code);
};
const machine = (body, extra = '') => `module t\nenum S { A, B }\nmachine M {\n  state { s : S = A }\n  action Go()\n  action Done()\n  on Done { s' = B }\n${body}\n${extra}\n}\n`;
const EFFECT = 'effect ping(n: 0..1) {\n  kind "k.ping"\n  labels { exec }\n}';

test('the checker: emit, effect declarations, labels and path properties', () => {
  assert.deepEqual(codes(machine('on Go { require s == A else reject "no"  emit ping(1) }', EFFECT)), [], 'an emit-only handler is not a silent no-op');
  assert.deepEqual(codes(machine('on Go { s\' = B }', 'effect ping(n: 0..1) {\n  kind "k.ping"\n}')), ['PL6301']);
  assert.deepEqual(codes(machine('on Go { s\' = B }', 'effect ping(n: 0..1) {\n  labels { exec, egress:moon }\n}')), ['PL1001']);
  assert.deepEqual(codes(machine('on Go { s\' = B  emit pong(1) }', EFFECT)), ['PL1001']);
  assert.deepEqual(codes(machine('on Go { s\' = B  emit ping(1, 0) }', EFFECT)), ['PL1201']);
  assert.deepEqual(codes(machine('on Go { s\' = B  emit ping(true) }', EFFECT)), ['PL1201']);
  assert.deepEqual(codes(machine('on Go { s\' = B }', 'effect ping(n: 0..1) {\n  labels { exec }\n  ok -> Nope()\n}')), ['PL1001']);
  // S40: a declared completion action with no handler has its own code.
  assert.deepEqual(codes(machine('on Go { s\' = B }', 'action Ack()\neffect ping(n: 0..1) {\n  labels { exec }\n  ok -> Ack()\n}')), ['PL6101']);
  // S37: count bounds and before(k1, k2) are the prefix-closed forms; any other shape is PL1701.
  assert.deepEqual(codes(machine('on Go { s\' = B  emit ping(1) }', `${EFFECT}\npath property p: count("k.ping") <= 1 && count("k.ping") < 2`)), []);
  assert.deepEqual(codes(machine('on Go { s\' = B  emit ping(1) }', `${EFFECT}\npath property p: count("k.ping") >= 1`)), ['PL1701']);
  assert.deepEqual(codes(machine('on Go { s\' = B  emit ping(1) }', `${EFFECT}\npath property p: count("k.ping") <= 1 || count("k.ping") <= 2`)), ['PL1701']);
  assert.deepEqual(codes(machine('on Go { s\' = B  emit ping(1) }', `${EFFECT}\npath property p: count("k.pong") <= 1`)), ['PL1001']);
  assert.deepEqual(codes(machine('on Go { s\' = B  emit ping(1) }', `${EFFECT}\npath property p: before("k.ping", "k.ping") && count("k.ping") < 3`)), []);
  assert.deepEqual(codes(machine('on Go { s\' = B  emit ping(1) }', `${EFFECT}\npath property p: before("k.ping", "k.pong")`)), ['PL1001']);
  assert.deepEqual(codes(machine('on Go { s\' = B }', `invariant i: count("k.ping") <= 1\n${EFFECT}`)), ['PL1201'], 'count is read only in a path property');
});

test('PT3.4a: a disclosed input that flows into an irreversible effect is PL1301', () => {
  const src = 'module t\nmachine M {\n  state { n : 0..1 = 0 }\n  action Pay(amount: int check { 1, 2 } disclosed)\n  on Pay(amount) { require n == 0 else reject "done"  n\' = 1  emit charge(amount) }\n  effect charge(a: int) {\n    labels { egress:external }\n    class irreversible\n  }\n}\n';
  assert.deepEqual(codes(src), ['PL1301']);
});

const write = (name, src) => {
  const dir = join(OUT, 'sources');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, src);
  return file;
};

test('PS5.4: a path property violated only around a cycle is found by poly-ref; polyrun names the cycle, which is a note (S39)', async () => {
  // Retry and Back loop between two states and both emit k.retry; count("k.retry") <= 1 fails when Back
  // returns to Idle. polyrun explores simple paths, prunes that edge and reports it as cycle-edge-emits.
  const file = write('cycle.poly', 'module cyc\nenum P { Idle, Busy }\nmachine M {\n  state { p : P = Idle }\n  action Retry()\n  action Back()\n  on Retry { require p == Idle else reject "busy"  p\' = Busy  emit retry(1) }\n  on Back { require p == Busy else reject "idle"  p\' = Idle  emit retry(0) }\n  path property one-retry: count("k.retry") <= 1\n  effect retry(n: 0..1) {\n    kind "k.retry"\n    labels { exec }\n  }\n}\n');
  const r = await checkFile(file, { root: OUT });
  const m = r.machines[0];
  const f = m.diagnostics.filter((d) => d.code === 'PL4001');
  assert.equal(f.length, 1);
  assert.deepEqual(steps(f[0]), ['Retry()', 'Back()']);
  assert.match(f[0].message, /poly-ref alone/);
  assert.ok(!m.diagnostics.some((d) => d.code === 'PL2501'), JSON.stringify(m.diagnostics.map((d) => d.message)));
  // S39: polyrun's cycle-edge-emits is a note, printed with its edge, never dropped.
  const stage = m.stages.find((s) => s.stage === 'effects');
  assert.ok(stage.notes.some((n) => /cycle-edge-emits/.test(n) && /Back\(\{\}\)/.test(n)), JSON.stringify(stage.notes));
  assert.match(render(r), /\n  note: polyrun reports cycle-edge-emits at Retry\(\{\}\), Back\(\{\}\)/);
});

test('S38: a machine that emits and has no path property is checked for PL4002 by poly-ref alone, and says so', async () => {
  const file = write('no-path.poly', 'module np\nmachine M {\n  state { n : 0..1 = 0 }\n  action Ping()\n  on Ping { emit ping(1) }\n  effect ping(n: 0..1) {\n    kind "k.ping"\n    labels { exec }\n  }\n}\n');
  const r = await checkFile(file, { root: OUT });
  const m = r.machines[0];
  assert.deepEqual(m.diagnostics.map((d) => d.code), ['PL4002']);
  assert.equal(m.instance.effectsByRefOnly, true);
  assert.match(render(r), /M: emission without a state change \(PL4002\) decided by poly-ref alone/);
});

test('poly-ref: E is in statement order, and a conditional emit appears only on its branch (PS2.1, PS2.2)', () => {
  const m = parse(readFileSync(join(ROOT, 'conformance', 'm1', 'effects.poly'), 'utf8')).module;
  const r = checkMachine(m, 'Account');
  const bill = (tier) => r.graph.edges.find((e) => e.from === 0 && e.label.action === 'Bill' && e.label.data.tier.ctor === tier);
  assert.deepEqual(bill('Basic').label.effects.map((x) => x.kind), ['billing.invoice', 'mail.receipt']);
  assert.deepEqual(bill('Gold').label.effects.map((x) => x.kind), ['billing.invoice', 'billing.perk', 'mail.receipt']);
  assert.ok(r.graph.edges.every((e) => e.label.verdict.kind === 'accepted' || e.label.effects.length === 0), 'only accepted steps emit');
});

test('polywatch: each PL4002 says polyrun agreed only for the action polyrun named', async () => {
  // Two actions emit without changing the state; polyrun reports one identity-accept-emits example per run.
  const file = write('two-idle.poly', 'module ti\nmachine M {\n  state { n : 0..1 = 0 }\n  action A()\n  action B()\n  action Go()\n  on A { emit ping(1) }\n  on B { emit ping(0) }\n  on Go { require n == 0 else reject "done"  n\' = 1 }\n  path property few: count("k.ping") <= 5\n  effect ping(v: 0..1) {\n    kind "k.ping"\n    labels { exec }\n  }\n}\n');
  const r = await checkFile(file, { root: OUT });
  const idle = r.machines[0].diagnostics.filter((d) => d.code === 'PL4002');
  assert.deepEqual(idle.map((d) => d.property).sort(), ['A', 'B']);
  assert.equal(idle.filter((d) => /polyrun/.test(d.engine)).length, 1, JSON.stringify(idle.map((d) => [d.property, d.engine])));
});

test('polywatch: a disclosed field read as pre.f in an irreversible payload is PL1301', () => {
  const src = 'module t\nmachine M {\n  state {\n    n : 0..1 = 0\n    amount : int check { 1, 2 } disclosed = 1\n  }\n  action Pay()\n  on Pay { require n == 0 else reject "done"  n\' = 1  emit charge(pre.amount) }\n  effect charge(a: int) {\n    labels { egress:external }\n    class irreversible\n  }\n}\n';
  assert.deepEqual(codes(src), ['PL1301']);
});

test('polywatch: an effect kind that is a JavaScript prototype name still lowers into the manifest', () => {
  const file = write('proto.poly', 'module pr\nmachine M {\n  state { n : 0..1 = 0 }\n  action Go()\n  on Go { require n == 0 else reject "done"  n\' = 1  emit ping(1) }\n  effect ping(v: 0..1) {\n    kind "__proto__"\n    labels { exec }\n  }\n}\n');
  const [b] = build(file, 'proto');
  const manifest = JSON.parse(readFileSync(join(b.dir, 'effects.manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.effects), ['__proto__']);
});

test('two checks of one module in one process read each its own path properties (no stale import)', async () => {
  // polyrun imports effect-invariants.mjs by path, and Node caches an import by URL; the build dir is the same.
  const src = (bound) => `module stale\nmachine M {\n  state { n : 0..2 = 0 }\n  terminal n == 2\n  action Go()\n  on Go { require n < 2 else reject "done"  n' = n + 1  emit ping(1) }\n  path property few: count("k.ping") <= ${bound}\n  effect ping(v: 0..1) {\n    kind "k.ping"\n    labels { exec }\n  }\n}\n`;
  const loose = await checkFile(write('stale.poly', src(5)), { root: OUT });
  assert.deepEqual(loose.machines[0].diagnostics.map((d) => d.code), []);
  const tight = await checkFile(write('stale.poly', src(1)), { root: OUT });
  const f = tight.machines[0].diagnostics.filter((d) => d.code === 'PL4001');
  assert.equal(f.length, 1);
  assert.match(f[0].engine, /polyrun/, 'polyrun read the new bound');
});
