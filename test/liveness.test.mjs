// Liveness under weak fairness (PS5.5, PS6.4), plan-m2 step 2, and the M2 gate's liveness evidence:
//   - `settles` holds for the v0.3 and union forms of OutboxIntent, and fails for the v0.2 form with a fair
//     cycle at each of its two deadlocked states (outbox_check.py, outbox_sum_check.py);
//   - `exactly-once` holds for the two Delivery variants that keep dedupe records (delivery_check.py).
// When Python 3 is present the scripts are run and compared; without it that half is reported as skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkMachine } from '@poly/ref';
import { checkFile, render } from '@poly/check';
import { ROOT } from './helpers.mjs';

const OUT = join(ROOT, '.poly', 'test-build', 'liveness');
const outbox = (name) => checkFile(join(ROOT, 'examples', 'evidence', `${name}.poly`), { root: OUT });
const codes = (r) => r.machines.flatMap((m) => m.diagnostics.map((d) => d.code));
const ref = (file, machine) => checkMachine(parse(readFileSync(join(ROOT, file), 'utf8')).module, machine);
const tuple = (s) => [s.status, s.attempts, s.decisions, s.executed, s.approved];

test('settles: holds for the union and v0.3 forms, fails for v0.2 with a fair cycle at each deadlocked state', async () => {
  const cases = [['outbox-union', 'CLEAN', [], 17], ['outbox-v03', 'CLEAN', [], 33], ['outbox-v02', 'FINDINGS', ['PL3201', 'PL3201', 'PL3301'], 35]];
  for (const [name, verdict, want, states] of cases) {
    const r = await outbox(name);
    assert.equal(r.verdict, verdict, render(r));
    assert.deepEqual(codes(r).sort(), want, name);
    assert.equal(r.machines[0].instance.states, states, name);
    assert.deepEqual(r.machines[0].notRun, [], name);
    assert.equal(r.machines[0].stages.find((s) => s.stage === 'liveness').status, 'ran');
  }
  const v02 = ref('examples/evidence/outbox-v02.poly', 'OutboxIntent');
  // One finding for the property, with every fair component: one at each deadlocked state, each alone.
  const [lasso] = v02.findings.filter((d) => d.code === 'PL3301');
  assert.deepEqual(lasso.components.map((c) => c.map(tuple)).sort(), [[['Allowed', 3, 1, true, false]], [['Allowed', 3, 2, true, true]]]);
});

test('a lasso is a real path: the cycle returns to its first state, and the goal never holds on it', () => {
  const r = ref('examples/evidence/outbox-v02.poly', 'OutboxIntent');
  for (const d of r.findings.filter((x) => x.code === 'PL3301')) {
    const w = d.witness;
    assert.ok(w.cycle < w.trace.length);
    for (let i = 1; i < w.trace.length; i++) assert.deepEqual(w.trace[i].pre, w.trace[i - 1].post);
    assert.deepEqual(w.trace[w.trace.length - 1].post, w.trace[w.cycle].pre);
    for (const s of w.trace.slice(w.cycle)) assert.ok(!['Done', 'Denied', 'Dead'].includes(s.pre.status));
  }
});

test('exactly-once: holds for the two Delivery variants that keep dedupe records', () => {
  for (const [file, states] of [['examples/delivery/delivery.poly', 1147], ['examples/delivery/delivery-parallel.poly', 2368]]) {
    const r = ref(file, 'Delivery');
    assert.equal(r.states, states);
    assert.deepEqual(r.findings.filter((d) => d.code === 'PL3301'), [], file);
  }
});

test('fairness is what makes it hold: without the listed group, the same goal fails', () => {
  const src = 'module t\nmachine M {\n  state { x : 0..2 = 0 }\n  terminal x == 2\n  action Up()\n  action Idle()\n  on Up { require x < 2 else reject "top"  x\' = x + 1 }\n  on Idle { require x < 2 else reject "top"  x\' = x }\n  liveness top: eventually x == 2 under fair { Up }\n  liveness top2: eventually x == 2 under fair { Idle }\n  liveness steps: x == 1 leads to x == 2 under fair { Up }\n}\n';
  const r = checkMachine(parse(src).module, 'M');
  const failed = [...new Set(r.findings.filter((d) => d.code === 'PL3301').map((d) => d.property))];
  assert.deepEqual(failed, ['top2']);
  const w = r.findings.find((d) => d.property === 'top2').witness;
  assert.deepEqual(w.trace.slice(w.cycle).map((s) => s.action), ['Idle']);
});

const PYTHON = ['python3', 'python', 'py'].find((cmd) => {
  const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === '3';
});

test('the evidence scripts print the same liveness results', (t) => {
  if (!PYTHON) { t.skip('Python 3 is not available: the evidence scripts were not run'); return; }
  const run = (name, ...args) => spawnSync(PYTHON, [join(ROOT, 'docs', 'reviews', 'evidence', name), ...args], { encoding: 'utf8' }).stdout;
  assert.match(run('outbox_check.py', 'v0.3'), /liveness violations\): \[\]/);
  // The script prints its components in set order, which varies; each must be there, alone in its component.
  const v02 = run('outbox_check.py', 'v0.2').split('\n').find((l) => l.startsWith('fair non-terminal'));
  assert.match(v02, /\[\('Allowed', 3, 2, True, True\)\]/);
  assert.match(v02, /\[\('Allowed', 3, 1, True, False\)\]/);
  assert.equal((v02.match(/\[\(/g) ?? []).length, 2);
  assert.match(run('outbox_sum_check.py'), /liveness violations \[\]/);
  const d = run('delivery_check.py');
  assert.match(d, /in-order worker, dedupe kept on archive: 1147 states; at-most-once holds; liveness violations: 0/);
  assert.match(d, /parallel worker, dedupe kept on archive: 2368 states; at-most-once holds; liveness violations: 0/);
});

test('AC9: the union escape is FINDINGS, not refused', async () => {
  const r = await outbox('outbox-union-escape');
  assert.equal(r.verdict, 'FINDINGS');
  assert.ok(codes(r).includes('PL3102'));
});

test('a liveness property is type-checked: an unknown fairness action is PL1001', () => {
  const src = 'module t\nmachine M {\n  state { x : 0..1 = 0 }\n  action A()\n  on A { x\' = 1 }\n  liveness l: eventually x == 1 under fair { A, B }\n}\n';
  assert.deepEqual(checkModule(parse(src).module).diagnostics.map((d) => d.code), ['PL1001']);
  const bad = 'module t\nmachine M {\n  state { x : 0..1 = 0 }\n  action A()\n  on A { x\' = 1 }\n  liveness l: eventually x under fair { A }\n}\n';
  assert.deepEqual(checkModule(parse(bad).module).diagnostics.map((d) => d.code), ['PL1201']);
});
