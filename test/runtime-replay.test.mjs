// M4a, the replay half (AC6, PS11.4, PF8.6): a run's journal is folded again through poly-ref's δ over the
// certified source and through polygraph's replayer over the certified module, and every verdict, reason and
// post-state is reproduced; the snapshot is the fold's cache, so one that disagrees with the fold is a kernel
// fault (PL9001). Programs with a cascade, effects, timers, unions and records; messages are M4c's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayRuntime } from '@poly/check';
import { admitted, loaded } from './runtime-helpers.mjs';

const a = await admitted('replay', [
  'conformance/m1/children.poly', 'conformance/m1/effects.poly', 'conformance/m1/timers.poly',
  'conformance/m1/unions.poly', 'conformance/m1/records.poly',
]);

async function drive(rt, clock) {
  const o = await rt.create('shop.Order', { id: 'order-1' });
  await rt.dispatch(o.id, 'Checkout');
  await rt.dispatch(o.id, 'Checkout'); // rejected
  await rt.dispatch(o.id, 'Hurry');
  const [box] = await rt.list('shop.Shipment');
  await rt.dispatch(box.instance_id, 'Deliver'); // the child ends; the cascade completes the parent
  const acct = await rt.create('effects.Account', { id: 'acct-1' });
  await rt.dispatch(acct.id, 'Bill', { tier: 'Gold' });
  await rt.dispatch(acct.id, 'Remind', { copies: 2 });
  await rt.dispatch(acct.id, 'Remind', { copies: 3 }); // outside its strict domain
  await rt.dispatch(acct.id, 'Close');
  await rt.dispatch(acct.id, 'Notify'); // terminal
  const hold = await rt.create('timers.Hold', { id: 'hold-1' });
  await rt.dispatch(hold.id, 'Open', { minutes: 1 });
  clock.advance(2 * 60_000);
  await rt.tick();
  const board = await rt.create('unions.Board', { id: 'board-1' });
  await rt.dispatch(board.id, 'Assign', { s: 'A', job: { $: 'Busy', n: 2 } });
  await rt.dispatch(board.id, 'Grab', { s: 'B' });
  await rt.dispatch(board.id, 'Assign', { s: 'B', job: { $: 'Idle' } }); // PS9.1b: a constructor of a union with payloads is an object below the top
  const packer = await rt.create('rec.Packer', { id: 'packer-1' });
  await rt.dispatch(packer.id, 'Fill', { with: { size: 'Large', count: 2 } });
  await rt.dispatch(packer.id, 'Seal');
}

test('every run of every program replays: each verdict, reason and post-state, by poly-ref and by polygraph', async () => {
  const { rt, clock } = await loaded(a);
  try {
    await drive(rt, clock);
    const runs = await replayRuntime(rt);
    // Six program runs, and one OutboxIntent run per effect the account emitted (its worker's trace, M4b).
    assert.equal(runs.filter((r) => !r.machine.endsWith('.OutboxIntent')).length, 6);
    assert.ok(runs.some((r) => r.machine.endsWith('.OutboxIntent')));
    for (const r of runs) assert.deepEqual(r.diagnostics.map((d) => d.message), [], r.run);
    const total = runs.reduce((n, r) => n + r.rows, 0);
    assert.equal(runs.reduce((n, r) => n + r.folded, 0), total, 'every row is folded');
    assert.ok(runs.reduce((n, r) => n + r.windows, 0) >= 10, 'polygraph replays the accepted windows');
    const hold = await rt.getJournal('hold-1');
    assert.ok(hold.some((row) => row.action === 'Expire' && row.step_kind === 'accepted'), 'the timer fired and its step replays');
  } finally { await rt.close(); }
});

test('a snapshot that disagrees with the fold is a kernel fault (PL9001, PS11.4)', async () => {
  const { rt, clock } = await loaded(a);
  try {
    await drive(rt, clock);
    rt.store.db.prepare(`UPDATE pr_instance SET state = json_set(state, '$.phase', 'Open') WHERE instance_id = 'acct-1'`).run();
    const [r] = await replayRuntime(rt, { runs: ['acct-1'] });
    assert.deepEqual(r.diagnostics.map((d) => d.code), ['PL9001']);
    assert.match(r.diagnostics[0].message, /snapshot disagrees with the fold/);
  } finally { await rt.close(); }
});

test('a journal row whose post-state is not δ of its pre-state is found at its seq, by both folds', async () => {
  const { rt, clock } = await loaded(a);
  try {
    await drive(rt, clock);
    rt.store.db.prepare(`UPDATE pr_journal SET post = json_set(post, '$.count', 1) WHERE instance_id = 'packer-1' AND action = 'Fill'`).run();
    const [r] = await replayRuntime(rt, { runs: ['packer-1'] });
    const messages = r.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n');
    assert.match(messages, /PL9001 run packer-1, seq \d+: the post-state of Fill is not δ of its pre-state/);
    assert.match(messages, /polygraph's replay of the certified module gives fail/);
  } finally { await rt.close(); }
});
