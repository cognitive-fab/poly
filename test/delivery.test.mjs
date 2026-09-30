// Plan step 9 (M1-3): the Delivery machine of PT9.8 in its four variants, safety only. poly-ref and the
// pipeline must print what docs/reviews/evidence/delivery_check.py prints: 1,147 and 2,368 states with
// at-most-once and in-order holding, the 4-step in-order witness and the 10-step at-most-once witness.
// exactly-once is liveness and is listed as not run (M2). When Python 3 is present the script is run and
// compared, as in M0; without it the script half is reported as skipped, never as passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from '@poly/lang';
import { checkMachine } from '@poly/ref';
import { checkFile, render } from '@poly/check';
import { ROOT, BUILD } from './helpers.mjs';

const DIR = join(ROOT, 'examples', 'delivery');
const OUT = join(BUILD, 'delivery');
const ref = (name) => {
  const p = parse(readFileSync(join(DIR, `${name}.poly`), 'utf8'));
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  return checkMachine(p.module, 'Delivery');
};
const steps = (d) => d.witness.trace.map((s) => `${s.action}${Object.values(s.data).length ? `(${Object.values(s.data).join(', ')})` : ''}`);

const IN_ORDER = ['Emit(M1)', 'Emit(M2)', 'Send(M2)', 'DeliverReq(M2)'];
const AT_MOST_ONCE = ['Emit(M1)', 'Emit(M2)', 'Send(M1)', 'Resend(M1)', 'DeliverReq(M1)', 'DeliverAck(M1)', 'Send(M2)', 'DeliverReq(M2)', 'Archive', 'DeliverReq(M1)'];

test('the in-order worker with the dedupe table kept: 1,147 states, safety clean, exactly-once not run', async () => {
  assert.equal(ref('delivery').states, 1147);
  const r = await checkFile(join(DIR, 'delivery.poly'), { root: OUT });
  const m = r.machines[0];
  assert.deepEqual(m.diagnostics, [], render(r));
  assert.equal(m.instance.states, 1147);
  assert.match(m.stages.find((s) => s.stage === 'model-check').note, /^1147 states explored/);
  assert.deepEqual(m.notRun.map((p) => p.property), ['exactly-once']);
  assert.equal(r.verdict, 'INCONCLUSIVE');
});

test('the parallel worker with the dedupe table kept: 2,368 states, at-most-once holds', async () => {
  assert.equal(ref('delivery-parallel').states, 2368);
  const r = await checkFile(join(DIR, 'delivery-parallel.poly'), { root: OUT });
  assert.deepEqual(r.machines[0].diagnostics, [], render(r));
  assert.equal(r.machines[0].instance.states, 2368);
});

test('the parallel worker that still claims in-order: violated in 4 steps', async () => {
  const f = ref('delivery-parallel-fifo').findings;
  assert.deepEqual(f.map((d) => [d.code, d.property]), [['PL3001', 'in-order']]);
  assert.deepEqual(steps(f[0]), IN_ORDER);
  // polygraph finds it on the lowered module too, and poly-ref confirms it.
  const r = await checkFile(join(DIR, 'delivery-parallel-fifo.poly'), { root: OUT });
  const d = r.machines[0].diagnostics.find((x) => x.property === 'in-order');
  assert.match(d.engine, /^polygraph@/);
  assert.equal(d.witness.length, 4);
});

test('the dedupe table cleared on archive: at-most-once violated in 10 steps, and at-most-once alone (S64)', () => {
  const f = ref('delivery-cleared').findings;
  // S64: in-order is steps[M2] >= 1 implies steps[M1] >= 1, which a second step of M1 does not break.
  assert.deepEqual(f.map((d) => [d.code, d.property]), [['PL3001', 'at-most-once']]);
  assert.deepEqual(steps(f[0]), AT_MOST_ONCE);
});

const PYTHON = ['python3', 'python', 'py'].find((cmd) => {
  const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === '3';
});

test('delivery_check.py prints the same numbers and witnesses as poly-ref', (t) => {
  if (!PYTHON) { t.skip('Python 3 is not available: the evidence script was not run'); return; }
  const run = spawnSync(PYTHON, [join(ROOT, 'docs', 'reviews', 'evidence', 'delivery_check.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const line = (prefix) => run.stdout.split('\n').find((l) => l.startsWith(prefix));
  assert.match(line('in-order worker, dedupe kept on archive'), new RegExp(`: ${ref('delivery').states} states; at-most-once holds`));
  assert.match(line('parallel worker, dedupe kept on archive'), new RegExp(`: ${ref('delivery-parallel').states} states; at-most-once holds`));
  const witness = (l) => JSON.parse(l.slice(l.indexOf('witness ') + 8).replace(/'/g, '"'));
  assert.deepEqual(witness(line('parallel worker, fifo order required')), steps(ref('delivery-parallel-fifo').findings[0]));
  assert.deepEqual(witness(line('in-order worker, dedupe cleared on archive')), steps(ref('delivery-cleared').findings[0]));
});
