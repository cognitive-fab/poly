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
import { checkFile, render } from '@poly/check';
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

test('S42: the orders reject property place-empty is also violated, by Place in a cancelled order', async () => {
  // PT4.5 says the program has three findings. Under PS3.2 the terminal row comes first, so Place in
  // Cancelled with no items is rejected "terminal", not "empty-order". Raised as S42; this pins today's answer.
  const r = await checkFile(ORDERS, { root: OUT });
  const d = r.machines[0].diagnostics.find((x) => x.code === 'PL3003');
  assert.equal(d.property, 'place-empty');
  assert.deepEqual(steps(d), ['Cancel(Customer)', 'Place()']);
  // polygraph names the property, so the finding points at its declaration. The escape names a field
  // and stays at the machine: the two findings of one stage no longer share one position.
  const src = readFileSync(ORDERS, 'utf8').split('\n');
  assert.match(src[d.at.line - 1], /reject property place-empty/);
  const escape = r.machines[0].diagnostics.find((x) => x.code === 'PL3102');
  assert.match(src[escape.at.line - 1], /machine Order/);
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
  // S40 (provisional): a completion action must have a handler.
  assert.deepEqual(codes(machine('on Go { s\' = B }', 'action Ack()\neffect ping(n: 0..1) {\n  labels { exec }\n  ok -> Ack()\n}')), ['PL1001']);
  // S37 (provisional): only count bounds are prefix-closed forms.
  assert.deepEqual(codes(machine('on Go { s\' = B  emit ping(1) }', `${EFFECT}\npath property p: count("k.ping") <= 1 && count("k.ping") < 2`)), []);
  assert.deepEqual(codes(machine('on Go { s\' = B  emit ping(1) }', `${EFFECT}\npath property p: count("k.ping") >= 1`)), ['PL1201']);
  assert.deepEqual(codes(machine('on Go { s\' = B  emit ping(1) }', `${EFFECT}\npath property p: count("k.pong") <= 1`)), ['PL1001']);
  assert.deepEqual(codes(machine('on Go { s\' = B  emit ping(1) }', `${EFFECT}\npath property p: before("k.ping", "k.ping")`)), ['PL0901']);
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
  const stage = m.stages.find((s) => s.stage === 'effects');
  assert.match(stage.note, /cycle-edge-emits.*not a poly property.*S39/);
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
