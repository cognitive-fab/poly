// The review of the M10 and M11 merge: each finding within the semantics, its reviewer's probe made a test, written
// before its fix and failing on the code it found (decisions-m11.md, "The merge with m4").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { recordedProvider } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { loaded } from './runtime-helpers.mjs';
import { admittedDesk, answer, DESK, FIX } from './routing-helpers.mjs';

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };

test('merge review F2 (PS18.4): a reservation another call took first aborts the allow, and the intent is read again', async () => {
  const a = await admittedDesk('merge-review-f2');
  const { rt } = await loaded(a);
  try {
    rt.provideTier('flash', recordedProvider([answer('Refund', 0.96)]));
    rt.provideTier('opus', recordedProvider([answer('Refund', 0.96)]));
    const real = rt.worker.opts.reserve;
    let n = 0;
    // The first Reserve finds the budget taken (another run took it between the check and the allow).
    rt.worker.opts.reserve = async (row, plan) => (n++ === 0 ? false : real(row, plan));
    await rt.create('desk.Ticket', { id: 't' });
    await rt.dispatch('t', 'Received', { text: 'where is my refund' });
    for (let i = 0; i < 8; i++) await rt.worker.tick();
    const route = rt.store.db.prepare('SELECT instance FROM poly_route').get().instance;
    const v = (await rt.chain(route)).filter((e) => e.kind === 'verdict' && e.body.stage === 'gate').map((e) => [e.body.outcome, e.body.reason ?? null]);
    // Read again, the small tier's call fits and is allowed: no deny for a budget the re-read finds open.
    assert.deepEqual(v[0], ['allowed', null], JSON.stringify(v));
    assert.ok(!v.some(([o, r]) => o === 'denied' && r === 'budget'), JSON.stringify(v));
    assert.equal((await rt.getState('t')).state.status, 'Routed');
  } finally { await rt.close(); }
});

test('merge review F3 (PT10r, PL1208): route.<r>.call is reserved for a route\'s tier, as decision., outcome. and channel.<c>.send are', async () => {
  const dir = join(ROOT, '.poly', 'test-routing', 'merge-review-f3');
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  let src = swap(DESK, '    status\' = Routed\n', '    status\' = Routed\n    emit spoof()\n');
  src = swap(src, '  path property one-classification', '  effect spoof() {\n    kind "route.triage.call"\n    labels { egress:external }\n  }\n\n  path property one-classification');
  writeFileSync(join(dir, 'desk.poly'), src);
  for (const sub of ['prices', 'maps']) cpSync(join(FIX, sub), join(dir, sub), { recursive: true });
  const r = await checkFile(join(dir, 'desk.poly'), { root: dir });
  const ds = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)];
  assert.ok(ds.some((d) => d.code === 'PL1208' && /route\./.test(d.message)), JSON.stringify(ds.map((d) => [d.code, d.message.slice(0, 120)])));
});
