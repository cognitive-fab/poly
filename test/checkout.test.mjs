// Plan step 8, configurations (PS13, PT7a), with the checkout evidence (AC10, the M1 gate):
//   - the optimistic order: PL5401 with PT7a's six-step witness;
//   - the order that waits for Taken: clean over 44 global states, no PL5402, settle listed as not run;
// both with PT7a's bounds, transit 4. When Python 3 is present, docs/reviews/evidence/config_check.py is
// run and poly-ref must print what it prints. Then the rules of PS13 one by one, and the checker's codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkConfiguration } from '@poly/ref';
import { checkFile, configurationReports, render } from '@poly/check';
import { ROOT, BUILD } from './helpers.mjs';

const WAITING = join(ROOT, 'examples', 'checkout', 'checkout.poly');
const OPTIMISTIC = join(ROOT, 'examples', 'checkout', 'checkout-optimistic.poly');
const OUT = join(BUILD, 'checkout');
const SRC = readFileSync(WAITING, 'utf8');

const moduleOf = (src) => {
  const p = parse(src);
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  return p.module;
};
const ref = (src) => checkConfiguration(moduleOf(src), 'two-buyers');
const codes = (src) => {
  const p = parse(src);
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  return checkModule(p.module).diagnostics.map((d) => d.code);
};
const steps = (d) => d.witness.trace.map((s) => `${s.global.kind.padEnd(8)}${s.global.text}`);

const WITNESS = [
  'input   Place@order[0]',
  'input   Place@order[1]',
  'deliver Query(order[0]) -> inv',
  'deliver Query(order[1]) -> inv',
  'deliver Available(1) -> order[0]',
  'deliver Available(1) -> order[1]',
];

test('AC10: the optimistic order confirms two orders against one unit, PL5401 with PT7a\'s six-step witness', async () => {
  const r = await checkFile(OPTIMISTIC, { root: OUT });
  const c = r.configurations.find((x) => x.configuration === 'two-buyers');
  assert.deepEqual(c.diagnostics.map((d) => [d.code, d.property]), [['PL5401', 'confirmed-within-stock']]);
  assert.deepEqual(steps(c.diagnostics[0]), WITNESS);
  assert.equal(c.diagnostics[0].at.line, 38); // the property's line, after the file's expected-verdict line (V10 item 4)
  assert.deepEqual(c.instance.bounds, ['transit ≤ 4']);
  assert.deepEqual(c.instance.instances, ['inv: Inventory', 'order[0..1]: Order']);
  assert.equal(c.stages[0].verdict, 'FINDINGS');
  assert.equal(r.verdict, 'FINDINGS');
  const text = render(r);
  assert.match(text, /PL5401 CONFIGURATION_INVARIANT {2}confirmed-within-stock\n.*\n {2}witness \(6 global steps\):\n {4}input {3}Place@order\[0\]\n/);
  assert.match(text, /checkout\.two-buyers {2}over inv: Inventory, order\[0\.\.1\]: Order; transit ≤ 4; \d+ global states; kernel assumptions K1, K2, K4, K7, K8/);
});

test('AC10 and the M2 gate: the waiting order is clean over 44 global states, no stuck state, and settle holds', async () => {
  const r = await checkFile(WAITING, { root: OUT });
  const c = r.configurations.find((x) => x.configuration === 'two-buyers');
  assert.deepEqual(c.diagnostics, [], render(r));
  assert.equal(c.instance.states, 44);
  assert.equal(c.stages[0].verdict, 'CLEAN');
  assert.deepEqual(c.notRun, []);
  assert.equal(c.verdict, 'CLEAN');
  // S63: a reply is not PL4002, so the machines alone are clean and the file's verdict follows its configuration.
  assert.deepEqual(r.machines.flatMap((m) => m.diagnostics), []);
  assert.equal(r.verdict, 'CLEAN');
});

const PYTHON = ['python3', 'python', 'py'].find((cmd) => {
  const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === '3';
});

test('config_check.py prints the same results as poly-ref', (t) => {
  if (!PYTHON) { t.skip('Python 3 is not available: the evidence script was not run'); return; }
  const run = spawnSync(PYTHON, [join(ROOT, 'docs', 'reviews', 'evidence', 'config_check.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const [optimistic, waiting] = run.stdout.split(/\n(?=order waits)/);
  // The script stops at its first violation; poly-ref finds the same state first, by the same path.
  assert.match(optimistic, /confirmed-within-stock VIOLATED \| bound hit False \| stuck \[\]/);
  const scriptWitness = optimistic.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
  const opt = ref(readFileSync(OPTIMISTIC, 'utf8'));
  assert.deepEqual(steps(opt.findings[0]).map((s) => s.replace(/\s+/, ' ')), scriptWitness.map((s) => s.replace(/\s+/, ' ')));
  assert.match(waiting, /states explored 44 \| confirmed-within-stock holds \| bound hit False \| stuck \[\]/);
  assert.equal(ref(SRC).states, 44);
});

test('PS13.3: a delivery the receiver rejects consumes the message and changes no state', () => {
  const r = ref(readFileSync(OPTIMISTIC, 'utf8'));
  const g = r.graph;
  // An optimistic order is Done when Taken arrives: rejected as terminal, and the message is gone.
  const e = g.edges.find((x) => x.label.via === 'deliver' && x.label.action === 'Taken' && x.label.verdict.kind === 'rejected');
  assert.ok(e);
  assert.equal(e.label.verdict.reason, 'terminal');
  const [from, to] = [g.states[e.from], g.states[e.to]];
  assert.deepEqual(to.sigma, from.sigma);
  assert.equal(to.mu.length, from.mu.length - 1);
});

test('PS13.2a: copies of one message are one choice, and μ holds them both', () => {
  // Two queries from one order: an order that may place again while it waits.
  const r = ref(SRC.replace('on Place      { require st is Idle   else', 'on Place      { require st is Idle || st is Asked else'));
  assert.ok(r.graph.states.some((s) => new Set(s.mu.map((m) => JSON.stringify(m))).size < s.mu.length), 'some state holds two copies of one message');
  for (const [i, s] of r.graph.states.entries()) {
    const keys = s.mu.map((m) => JSON.stringify(m));
    const distinct = new Set(keys).size;
    const deliveries = r.graph.out[i].map((k) => r.graph.edges[k]).filter((e) => e.label.via === 'deliver').length;
    assert.equal(deliveries, distinct);
  }
});

test('PS13.5: a transit bound hit is PL5301 and INCONCLUSIVE, never CLEAN', async () => {
  const r = ref(SRC.replace('bounds    { transit 4 }', 'bounds    { transit 1 }'));
  assert.deepEqual(r.findings.map((d) => [d.code, d.field]), [['PL5301', 'transit']]);
  assert.equal(r.findings[0].severity, 'inconclusive');
  const dir = join(OUT, 'sources');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'transit-1.poly');
  writeFileSync(file, SRC.replace('bounds    { transit 4 }', 'bounds    { transit 1 }'));
  const report = await checkFile(file, { root: OUT });
  assert.equal(report.configurations[0].stages[0].verdict, 'INCONCLUSIVE');
});

test('PS13.6: a quiescent state with an order not terminal is PL5402, with its witness', () => {
  // An inventory that never answers a Take leaves the order waiting in Taking.
  const r = ref(SRC.replace("if onHand > 0 { onHand' = onHand - 1   send from <- Taken() }", "if onHand > 0 { onHand' = onHand - 1 }"));
  const stuck = r.findings.filter((d) => d.code === 'PL5402');
  assert.equal(stuck.length, 1);
  assert.match(stuck[0].message, /order\[0\] is not terminal/);
  // Quiescent means no input is accepted either (PS13.6), so the other order has settled first.
  assert.deepEqual(steps(stuck[0]), ['input   Place@order[0]', 'input   Place@order[1]', 'deliver Query(order[0]) -> inv', 'deliver Available(1) -> order[0]', 'deliver Take(order[0]) -> inv', 'deliver Query(order[1]) -> inv', 'deliver Available(0) -> order[1]']);
});

test('S29: a send to none inside a configuration is PL5404, and adds nothing to μ', () => {
  const r = ref(SRC.replace('order[2]  : Order { inv: inv }', 'order[2]  : Order'));
  const f = r.findings.filter((d) => d.code === 'PL5404');
  assert.deepEqual(f.map((d) => d.property), ['Order.Place']);
  assert.deepEqual(steps(f[0]), ['input   Place@order[0]']);
  assert.ok(r.graph.states.every((s) => s.mu.length === 0));
  // With no reply, each placed order waits in Asked for ever: stuck.
  assert.ok(r.findings.some((d) => d.code === 'PL5402'));
});

test('the checker: groups, S32 names, init, inputs, addresses and bounds', () => {
  const swap = (from, to) => { assert.ok(SRC.includes(from), from); return codes(SRC.replace(from, to)); };
  assert.deepEqual(codes(SRC), []);
  // PS13.6: a group outside a quantifier or an aggregate.
  assert.deepEqual(swap('invariant confirmed-within-stock: count(order[*] is Done) <= init(inv.onHand)', 'invariant confirmed-within-stock: order[*] is Done'), ['PL5403']);
  assert.deepEqual(swap('invariant confirmed-within-stock: count(order[*] is Done) <= init(inv.onHand)', 'invariant confirmed-within-stock: order is Done'), ['PL5403']);
  assert.deepEqual(swap('inputs    { order[*].Place }', 'inputs    { order.Place }'), ['PL5403']);
  // S32: `is` needs one field with the constructor; an unknown field is PL1001.
  assert.deepEqual(swap('init(inv.onHand)', 'init(inv.stock)'), ['PL1001']);
  assert.deepEqual(swap('count(order[*] is Done)', 'count(order[*] is Nope)'), ['PL1005']);
  assert.deepEqual(swap('init(inv.onHand)', 'init(init(inv.onHand))'), ['PL1201']);
  assert.deepEqual(swap('count(order[*] is Done)', 'count(inv.onHand == 1)'), ['PL1201']);
  // Inputs name instances and actions.
  assert.deepEqual(swap('inputs    { order[*].Place }', 'inputs    { order[*].Pay }'), ['PL1001']);
  assert.deepEqual(swap('inputs    { order[*].Place }', 'inputs    { order[2].Place }'), ['PL1201']);
  assert.deepEqual(swap('inputs    { order[*].Place }', 'inputs    { order[*].Place, order[*].Place }'), ['PL1002']);
  // PS13.1: an address is none, an instance or a member, of the field's machine.
  assert.deepEqual(swap('order[2]  : Order { inv: inv }', 'order[2]  : Order { inv: order[0] }'), ['PL1201']);
  assert.deepEqual(swap('order[2]  : Order { inv: inv }', 'order[2]  : Order { inv: order }'), ['PL5403']);
  assert.deepEqual(swap('order[2]  : Order { inv: inv }', 'order[2]  : Order { inv: stock }'), ['PL1201']);
  assert.deepEqual(swap('order[2]  : Order { inv: inv }', 'order[2]  : Order { inv: inv, inv: none }'), ['PL1002']);
  assert.deepEqual(swap('inv       : Inventory', 'inv       : Inventory { onHand: 2 }'), ['PL1201']);
  // S62: the transit bound is required, with its own code.
  assert.deepEqual(swap('  bounds    { transit 4 }\n', ''), ['PL5303']);
  // S56: a machine's liveness states its fairness, and a quantifier ranges over a configuration's group.
  assert.deepEqual(swap("on OutOfStock {", "liveness done: st is Asked leads to st is Done\n  on OutOfStock {"), ['PL1201']);
});

test('S61: a machine with attached children is refused in a configuration (PL0901)', () => {
  const src = SRC.replace('type OrderState', 'machine Note {\n  state { seen: bool = false }\n  action Seen()\n  on Seen { seen\' = true }\n}\n\ntype OrderState')
    .replace("on Taken      { require st is Taking else reject \"not-taking\"  st' = Done }", "on Taken      { require st is Taking else reject \"not-taking\"  st' = Done   spawn Note as note }");
  assert.deepEqual(codes(src), ['PL0901']);
});

// Review findings on step 8 (polywatch). Each test failed before its fix.
test('an index of a group outside 0..n-1 is PL1201 at the checker, constant or quantified', () => {
  const swap = (from, to) => { assert.ok(SRC.includes(from), from); return codes(SRC.replace(from, to)); };
  assert.deepEqual(swap('count(order[*] is Done)', 'count(order[5] is Done)'), ['PL1201']);
  assert.deepEqual(swap('count(order[*] is Done) <= init(inv.onHand)', '(forall i in order: order[i + 1] is Done) implies true'), ['PL1201']);
  assert.deepEqual(swap('count(order[*] is Done) <= init(inv.onHand)', 'forall i in order: order[i] is Done | Refused | Idle | Asked | Taking'), []);
});

test('a configuration the explorer cannot follow is an ERROR report, not a rejected check', async () => {
  // The checker refuses this source (no machine Warehouse); the stage is run as if it had not, to reach the explorer's throw.
  const m = moduleOf(SRC.replace('inv       : Inventory', 'inv       : Warehouse'));
  const r = configurationReports(m, false);
  assert.equal(r.configurations.length, 0);
  assert.match(r.error, /two-buyers: .*Warehouse/);
});

// ── liveness in a configuration (plan-m2 step 3; S56, S73; PS13.2b, PS14.2) ──

test('settle fails with a lasso when the inventory never answers Take', () => {
  const r = ref(SRC.replace("if onHand > 0 { onHand' = onHand - 1   send from <- Taken() }", "if onHand > 0 { onHand' = onHand - 1 }"));
  const f = r.findings.find((d) => d.code === 'PL3301');
  assert.ok(f, JSON.stringify(r.findings.map((d) => d.code)));
  assert.equal(f.property, 'settle');
  const w = f.witness;
  assert.ok(w.cycle !== undefined && w.cycle < w.length);
  assert.match(f.message, /for i = 0/);
});

test('S73: an input named in the fairness clause is fair, and nothing else is', () => {
  // Without a fair Place, an order may never be placed, and `eventually` its state is Done fails.
  const base = SRC.replace('  liveness  settle: forall i in order: order[i] is Asked leads to order[i] is Done | Refused', '  liveness  placed: forall i in order: eventually order[i] is Done | Refused');
  assert.ok(ref(base).findings.some((d) => d.code === 'PL3301'));
  const fair = base.replace('eventually order[i] is Done | Refused', 'eventually order[i] is Done | Refused under fair { order[*].Place }');
  assert.deepEqual(codes(fair), []);
  assert.deepEqual(ref(fair).findings.filter((d) => d.code === 'PL3301'), []);
  // A machine's action name alone, or an unknown instance, is refused in a configuration.
  assert.deepEqual(codes(base.replace('eventually order[i] is Done | Refused', 'eventually order[i] is Done | Refused under fair { Place }')), ['PL1201']);
  assert.deepEqual(codes(base.replace('eventually order[i] is Done | Refused', 'eventually order[i] is Done | Refused under fair { buyer[*].Place }')), ['PL1001']);
});

test('S77: config_liveness_check.py runs its controls, reproduces config_check.py, and finds settle holding', (t) => {
  if (!PYTHON) { t.skip('Python 3 is not available: the evidence script was not run'); return; }
  const run = spawnSync(PYTHON, [join(ROOT, 'docs', 'reviews', 'evidence', 'config_liveness_check.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  // The owner's conditions (decisions-m2.md): both mutants are controls, run first and violated.
  const [controls, rest] = run.stdout.split(/\n(?=optimistic order)/);
  assert.match(controls, /control inventory never answers OutOfStock: settle VIOLATED for order\[0\] \(1 fair component\) and order\[1\] \(1 fair component\)/);
  assert.match(controls, /control fairness ignored: settle VIOLATED for order\[0\] \(29 components\) and order\[1\] \(29 components\)/);
  const [optimistic, waiting] = rest.split(/\n(?=order waits)/);
  assert.deepEqual(optimistic.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((s) => s.replace(/\s+/, ' ')), steps(ref(readFileSync(OPTIMISTIC, 'utf8')).findings[0]).map((s) => s.replace(/\s+/, ' ')));
  assert.match(waiting, /states explored 44 \| confirmed-within-stock holds/);
  assert.match(waiting, /settle for order\[0\]: holds/);
  assert.match(waiting, /settle for order\[1\]: holds/);
  assert.deepEqual(ref(SRC).findings, []);
});

test('S77: with a bound hit, config_liveness_check.py reports settle INCONCLUSIVE, never holding', (t) => {
  if (!PYTHON) { t.skip('Python 3 is not available: the evidence script was not run'); return; }
  const run = spawnSync(PYTHON, [join(ROOT, 'docs', 'reviews', 'evidence', 'config_liveness_check.py'), '--transit', '1'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const waiting = run.stdout.slice(run.stdout.indexOf('order waits'));
  assert.match(waiting, /bound hit True/);
  assert.match(waiting, /settle for order\[0\]: INCONCLUSIVE \(bound hit\)/);
  assert.doesNotMatch(waiting, /settle for order\[\d\]: holds/);
});

test('S73: a fairness InputRef formats back to itself', async () => {
  const { format } = await import('@poly/lang');
  const { digest } = await import('@poly/core');
  const src = SRC.replace('  liveness  settle: forall i in order: order[i] is Asked leads to order[i] is Done | Refused', '  liveness  placed: forall i in order: eventually order[i] is Done | Refused under fair { order[*].Place(*) | order[1].Place, inv.Query }');
  const m = parse(src).module;
  const out = format(m);
  assert.match(out, /under fair \{ order\[\*\]\.Place\(\*\) \| order\[1\]\.Place, inv\.Query \}/);
  assert.equal(digest(parse(out).module), digest(m));
});
