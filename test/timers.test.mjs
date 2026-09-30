// Plan step 6, timers (PT6.3): `after` and `cancel` in the checker, poly-ref and the lowering; every
// `after` lowers to a cancel, then a set (S26), so a re-armed key fires once under polyrun.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkMachine } from '@poly/ref';
import { createRuntime } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import { ROOT, build } from './helpers.mjs';

const TIMERS = join(ROOT, 'conformance', 'm1', 'timers.poly');

const codes = (src) => {
  const p = parse(src);
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  return checkModule(p.module).diagnostics.map((d) => d.code);
};
const machine = (body) => `module t\nenum S { A, B }\nmachine M {\n  state { s : S = A }\n  action Go()\n  action Tick(n: 0..1)\n  on Tick(n) { s' = B }\n  ${body}\n}\n`;

test('the checker: after and cancel (PT6.3)', () => {
  assert.deepEqual(codes(machine('on Go { require s == A else reject "no"  after 5s -> Tick(1) as t }')), [], 'a step that only arms a timer is not a silent no-op');
  assert.deepEqual(codes(machine('on Go { s\' = B  after 5s -> Tick(1) as t  after 1s -> Tick(0) as t }')), ['PL2301']);
  assert.deepEqual(codes(machine('on Go { s\' = B  if s == A { after 5s -> Tick(1) as t } else { after 1s -> Tick(0) as t } }')), [], 'one key on two branches is armed once per path');
  assert.deepEqual(codes(machine('on Go { s\' = B  cancel nope }')), ['PL1001']);
  assert.deepEqual(codes(machine('on Go { s\' = B  after 5s -> Nope() as t }')), ['PL1001']);
  assert.deepEqual(codes(machine('on Go { s\' = B  after 5s -> Tick(true) as t }')), ['PL1201']);
  assert.deepEqual(codes(machine('on Go { s\' = B  after 5s -> Tick() as t }')), ['PL1201']);
});

test('poly-ref: an after is a timer set in E, a cancel a cancel, in statement order (PS2.1)', () => {
  const m = parse(`module t\nmachine M {\n  state { n : 0..1 = 0 }\n  action Go()\n  action Tick()\n  on Tick { n' = 0 }\n  on Go { require n == 0 else reject "no"  n' = 1  cancel t  after 2m -> Tick() as t }\n}\n`).module;
  const r = checkMachine(m, 'M');
  const go = r.graph.edges.find((e) => e.from === 0 && e.label.action === 'Go');
  assert.deepEqual(go.label.effects.map((x) => [x.kind, x.key, x.ms ?? null]), [['cancelTimer', 't', null], ['timer', 't', 120000]]);
});

test('S26: under polyrun, a re-armed key fires once, and a cancelled one does not fire', async () => {
  const [b] = build(TIMERS, 'timers-run');
  let now = 1_000_000;
  const rt = await createRuntime({
    store: { sqlite: ':memory:' },
    now: () => now,
    machines: [{ machineId: 'timers.Hold', module: join(b.dir, 'next.cjs'), contract: join(b.dir, 'contract.json'), effects: { mapper: join(b.dir, 'effects.cjs'), manifest: join(b.dir, 'effects.manifest.json') } }],
  });
  try {
    // Armed twice: the second Open cancels the first timer before it arms its own.
    await rt.create('timers.Hold', 'h1');
    await rt.dispatch('h1', 'Open', { minutes: 5 }, 'a1');
    await rt.dispatch('h1', 'Open', { minutes: 1 }, 'a2');
    now += 6 * 60_000;
    await rt.workers.tickTimers(now);
    const j1 = await rt.getJournal('h1');
    const fired = j1.filter((e) => e.action === 'Expire');
    assert.equal(fired.length, 1, JSON.stringify(j1.map((e) => [e.action, e.step_kind ?? e.stepKind])));
    assert.deepEqual((await rt.getState('h1')).state.phase, 'Expired');
    // Armed, then cancelled by Pay: the timer never fires.
    await rt.create('timers.Hold', 'h2');
    await rt.dispatch('h2', 'Open', { minutes: 1 }, 'b1');
    await rt.dispatch('h2', 'Pay', {}, 'b2');
    now += 2 * 60_000;
    await rt.workers.tickTimers(now);
    assert.equal((await rt.getJournal('h2')).filter((e) => e.action === 'Expire').length, 0);
  } finally {
    await rt.close();
  }
});
