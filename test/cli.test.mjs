// `poly check`: verdicts, exit codes (PT12.3) and the instance line (PT12.3a).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const OUT = join(ROOT, '.poly', 'test-build', 'cli');

function poly(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', OUT], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const src = (p) => join(ROOT, p);

test('CLEAN, exit 0, with the checked instance', () => {
  const r = poly('check', src('examples/hello/hello-empty.poly'));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /verdict: CLEAN \(exit 0\)  hello\.Gate  over coins ∈ 0\.\.3; 7 states; kernel assumptions K7/);
  assert.match(r.out, /translation-validation CLEAN \(21 transitions/);
});

test('FINDINGS, exit 1: the README deadlock with its witness', () => {
  const r = poly('check', src('examples/hello/hello.poly'));
  assert.equal(r.code, 1);
  assert.match(r.out, /PL3201 DEADLOCK  Gate/);
  assert.match(r.out, /Push\(\)   Unlocked\/3 -> Locked\/3/);
  assert.match(r.out, /then Coin: coin-box-full, Push: locked/);
  assert.match(r.out, /verdict: FINDINGS \(exit 1\)  hello\.Gate  over coins ∈ 0\.\.3; 7 states/);
});

test('FINDINGS, exit 1: an invariant violated, found by polygraph on the lowered module', () => {
  const r = poly('check', src('test/fixtures/cli/invariant.poly'));
  assert.equal(r.code, 1);
  assert.match(r.out, /PL3001 INVARIANT_REACHABLE/);
  assert.match(r.out, /invariant small is violated/);
});

test('FINDINGS, exit 1: AC9, a union payload leaves its type (PL3102)', () => {
  const r = poly('check', src('test/fixtures/cli/escape.poly'));
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /PL3102 DOMAIN_ESCAPE/);
});

test('INCONCLUSIVE, exit 2: raft checked up to its bound, never CLEAN (PS4.2a)', () => {
  const r = poly('check', src('examples/field-studies/raft/raft.poly'));
  assert.equal(r.code, 2);
  assert.match(r.out, /PL3901 BOUND_HIT/);
  assert.match(r.out, /verdict: INCONCLUSIVE \(exit 2\)  raft\.Node  over term ∈ 0\.\.9; NewerTermSeen\.term ∈ \{1, 2, 3, 5, 8\}; 38 states; bound hit: term/);
});

test('REFUSED, exit 2: a type error stops at stage 0 and lists what did not run', () => {
  const r = poly('check', src('test/fixtures/cli/refused.poly'));
  assert.equal(r.code, 2);
  assert.match(r.out, /PL1201 TYPE_MISMATCH/);
  assert.match(r.out, /not run: lower, validate, translation-validation, model-check, deadlock/);
  assert.match(r.out, /verdict: REFUSED \(exit 2\)/);
});

test('CLEAN, exit 0: a liveness property is checked, with the safety results (PS6, M2)', () => {
  const r = poly('check', src('examples/evidence/outbox-union.poly'));
  assert.equal(r.code, 0);
  assert.match(r.out, /liveness CLEAN \(1 property under weak fairness \(PS6\.4\)\)/);
  assert.match(r.out, /verdict: CLEAN \(exit 0\)  runtime\.OutboxIntent  over 17 states/);
  assert.doesNotMatch(r.out, /PL0901/);
});

test('--json: the report, with every diagnostic in poly.diagnostic/1 form', () => {
  const r = poly('check', src('examples/hello/hello.poly'), '--json');
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out);
  assert.equal(j.verdict, 'FINDINGS');
  assert.equal(j.exit, 1);
  const d = j.machines[0].diagnostics[0];
  assert.equal(d.schema, 'poly.diagnostic/1');
  assert.equal(d.code, 'PL3201');
  assert.equal(j.machines[0].instance.states, 7);
  // S16: both SAM versions are recorded. S36: polygraph 8.3.1 vendors the same 2.3.0 that poly runs.
  assert.equal(j.engines['sam-pattern'], '2.3.0');
  assert.equal(j.engines['polygraph sam-pattern (vendored)'], '2.3.0');
});

test('usage errors exit 64', () => {
  assert.equal(poly().code, 64);
  assert.equal(poly('check').code, 64);
  assert.equal(poly('lint', src('examples/hello/hello.poly')).code, 64);
  assert.equal(poly('check', src('no/such/file.poly')).code, 64);
});
