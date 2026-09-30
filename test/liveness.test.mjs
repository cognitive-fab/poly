// Decision M1-2: liveness is checked from M2. Until then a liveness property
// is type-checked, listed as not run with the milestone that runs it, and
// keeps the verdict from CLEAN: INCONCLUSIVE at best, FINDINGS if a safety
// check fails. The program is no longer refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';

const OUT = join(ROOT, '.poly', 'test-build', 'liveness');
const outbox = (name) => checkFile(join(ROOT, 'examples', 'evidence', `${name}.poly`), { root: OUT });
const codes = (r) => r.machines.flatMap((m) => m.diagnostics.map((d) => d.code));

test('the three OutboxIntent forms get their safety results, with settles not run', async () => {
  const cases = [
    ['outbox-union', 'INCONCLUSIVE', [], 17],
    ['outbox-v03', 'INCONCLUSIVE', [], 33],
    ['outbox-v02', 'FINDINGS', ['PL3201', 'PL3201'], 35],
  ];
  for (const [name, verdict, want, states] of cases) {
    const r = await outbox(name);
    assert.equal(r.verdict, verdict, name);
    assert.deepEqual(codes(r), want, name);
    assert.equal(r.machines[0].instance.states, states, name);
    assert.deepEqual(r.machines[0].notRun, [{ property: 'settles', reason: 'liveness is checked from milestone M2 (PS6)' }], name);
  }
});

test('AC9: the union escape is FINDINGS, not refused', async () => {
  const r = await outbox('outbox-union-escape');
  assert.equal(r.verdict, 'FINDINGS');
  assert.ok(codes(r).includes('PL3102'));
});

test('a liveness property is still type-checked: an unknown fairness action is PL1001', () => {
  const src = 'module t\nmachine M {\n  state { x : 0..1 = 0 }\n  action A()\n  on A { x\' = 1 }\n  liveness l: eventually x == 1 under fair { A, B }\n}\n';
  assert.deepEqual(checkModule(parse(src).module).diagnostics.map((d) => d.code), ['PL1001']);
  const bad = 'module t\nmachine M {\n  state { x : 0..1 = 0 }\n  action A()\n  on A { x\' = 1 }\n  liveness l: eventually x under fair { A }\n}\n';
  assert.deepEqual(checkModule(parse(bad).module).diagnostics.map((d) => d.code), ['PL1201']);
});
