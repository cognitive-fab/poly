// The evidence scripts are acceptance tests (CLAUDE.md, PT18 M0 gate).
//
// poly-ref must reproduce every number and witness the single-machine
// scripts in docs/reviews/evidence print. Each test checks poly-ref against
// the numbers fixed in the M0 gate, and, when Python 3 is available, runs the
// script and checks that it still prints those numbers. Without Python the
// script half is reported as skipped (not run), never as passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@poly/lang';
import { checkMachine } from '@poly/ref';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const EVIDENCE = join(ROOT, 'docs', 'reviews', 'evidence');

function ref(file, machine) {
  const r = parse(readFileSync(join(ROOT, file), 'utf8'));
  assert.ok(r.module, `${file} parses`);
  return checkMachine(r.module, machine);
}

const PYTHON = ['python3', 'python', 'py'].find((cmd) => {
  const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === '3';
});

function script(t, name, ...args) {
  if (!PYTHON) {
    t.skip('Python 3 is not available: the evidence script was not run');
    return null;
  }
  const r = spawnSync(PYTHON, [join(EVIDENCE, name), ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const codes = (report) => report.findings.map((d) => d.code);
const actions = (d) => d.witness.trace.map((s) => s.action);

test('hello turnstile: 7 states, PL3201 at Locked/3 with witness Coin, Coin, Coin, Push', () => {
  const r = ref('examples/hello/hello.poly', 'Gate');
  assert.equal(r.states, 7);
  assert.deepEqual(codes(r), ['PL3201']);
  assert.deepEqual(r.deadlocks, [{ mode: 'Locked', coins: 3 }]);
  assert.deepEqual(actions(r.findings[0]), ['Coin', 'Coin', 'Coin', 'Push']);
  // README: "then Coin: coin-box-full, Push: locked".
  assert.deepEqual(r.findings[0].rejections, ['Coin: coin-box-full', 'Push: locked']);
});

test('hello turnstile with Empty: 7 states, no deadlock', () => {
  const r = ref('examples/hello/hello-empty.poly', 'Gate');
  assert.equal(r.states, 7);
  assert.deepEqual(codes(r), []);
});

test('turnstile_check.py still prints those numbers', (t) => {
  const out = script(t, 'turnstile_check.py');
  if (out === null) return;
  const [a, b] = out.trim().split('\n');
  assert.match(a, /\['Coin', 'Push'\] states 7 deadlocks \[\('Locked', 3\)\] witness \['Coin', 'Coin', 'Coin', 'Push'\]/);
  assert.match(b, /\['Coin', 'Push', 'Empty'\] states 7 deadlocks \[\] witness \[\]/);
});

test('OutboxIntent, union form: 17 states, 24 accepted steps, no deadlock', () => {
  const r = ref('examples/evidence/outbox-union.poly', 'OutboxIntent');
  assert.equal(r.states, 17);
  assert.equal(r.accepted, 24);
  assert.deepEqual(codes(r), []);
});

test('outbox_sum_check.py still prints those numbers', (t) => {
  const out = script(t, 'outbox_sum_check.py');
  if (out === null) return;
  assert.match(out, /representable 17; reachable 17 edges 24 deadlocks \[\] liveness violations \[\]/);
});

test('OutboxIntent, union form with the Dead branch replaced (AC9): PL3102', () => {
  const r = ref('examples/evidence/outbox-union-escape.poly', 'OutboxIntent');
  assert.deepEqual(codes(r), ['PL3102']);
  assert.deepEqual(r.findings[0].witness.trace.at(-1).post, { intent: { Allowed: { attempts: 3 } } });
});

test('OutboxIntent, v0.3 five-field form: 33 states, 40 accepted steps, no deadlock', () => {
  const r = ref('examples/evidence/outbox-v03.poly', 'OutboxIntent');
  assert.equal(r.states, 33);
  assert.equal(r.accepted, 40);
  assert.deepEqual(codes(r), []);
});

test('OutboxIntent, v0.2 form (AC9): 35 states, deadlocked at (Allowed, 3, 1, T, F) and (Allowed, 3, 2, T, T)', () => {
  const r = ref('examples/evidence/outbox-v02.poly', 'OutboxIntent');
  assert.equal(r.states, 35);
  assert.equal(r.accepted, 40);
  // The safety half of the evidence; settles is checked in liveness.test.mjs.
  assert.deepEqual(codes(r).filter((c) => c !== 'PL3301'), ['PL3201', 'PL3201']);
  const tuples = r.deadlocks.map((s) => [s.status, s.attempts, s.decisions, s.executed, s.approved]).sort();
  assert.deepEqual(tuples, [['Allowed', 3, 1, true, false], ['Allowed', 3, 2, true, true]]);
});

test('outbox_check.py v0.3 and v0.2 still print those numbers', (t) => {
  const v3 = script(t, 'outbox_check.py', 'v0.3');
  if (v3 === null) return;
  assert.match(v3, /v0\.3 states 33 accepted steps 40 deadlocks \[\]/);
  const v2 = script(t, 'outbox_check.py', 'v0.2');
  assert.match(v2, /v0\.2 states 35 accepted steps 40 deadlocks \[\('Allowed', 3, 1, True, False\), \('Allowed', 3, 2, True, True\)\]/);
});
