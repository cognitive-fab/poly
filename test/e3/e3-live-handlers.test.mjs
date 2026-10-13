// plan-e3.md E3.7: the live act and stageCheck handlers, over the host's exec transport, in a real scratch copy. No admission:
// the handlers are called with a fake capability set that mirrors what the runtime passes (store, and exec bound to the
// commands the effects declare in harness.poly). The runtime's own refusal of an undeclared command is mirrored here and
// proved in poly-runtime's tests; what is proved here is that the host runs only the copy it was given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';
import { applyReference, originalsUnchanged, prepare, taskOf } from '../../examples/harness/host/tasks.mjs';
import { makeHost } from '../../examples/harness/host/transports.mjs';
import { act, stageCheck } from '../../examples/harness/host/handlers/tools.mjs';

const run = `live-${process.pid}`;

/** What the runtime passes: the store, and exec.run limited to the declared commands. */
function capsFor(host, declared) {
  return {
    store: host.transports.store,
    exec: { run: async (c, a = []) => {
      if (!declared.includes(c)) throw new Error(`command ${c} is not among the declared commands ${JSON.stringify(declared)}`);
      return host.transports.exec(c, [...a]);
    } },
  };
}

test('the module declares exec on act and stageCheck with exactly the commands the host serves, and stageCheck takes the stage', () => {
  const poly = readFileSync(join(ROOT, 'examples', 'harness', 'harness.poly'), 'utf8');
  assert.match(poly, /effect act\(fused: bool\) \{[^}]*labels \{ read:store, write:store, exec \}[^}]*exec: \["harness-tool"\]/);
  assert.match(poly, /effect stageCheck\(stage: 0\.\.3\) \{[^}]*labels \{ read:store, write:store, exec \}[^}]*exec: \["harness-check"\]/);
  assert.match(poly, /emit stageCheck\(stage: step\)/);
  assert.equal((poly.match(/exec: \[/g) ?? []).length, 2, 'no other effect runs a command');
});

test('act, live: the calls run in the copy the host set, the output is stored, a refused call is a failed call and not a throw', async () => {
  const host = makeHost();
  const { copy } = prepare('snip-headtail', run);
  host.setWorld({ copy, task: taskOf('snip-headtail') });
  const caps = capsFor(host, ['harness-tool']);
  const calls = JSON.stringify([{ tool: 'write', path: 'notes/a.txt', content: 'hi' }, { tool: 'bash', command: 'ls' }]);
  await host.store.write('calls', 'i1', calls);
  assert.deepEqual(await act({ fused: false }, caps, { instanceId: 'i1' }), { ok: true });
  const out = await host.store.read('output', 'i1');
  assert.equal(out.exitStatus, 1);
  assert.match(out.text, /wrote notes\/a\.txt/);
  assert.match(out.text, /refused:/);
  assert.equal(readFileSync(join(copy, 'notes', 'a.txt'), 'utf8'), 'hi');
  // no calls row: a permanent error
  await assert.rejects(act({ fused: false }, caps, { instanceId: 'none' }), /no calls/);
  // the world is set once
  assert.throws(() => host.setWorld({ copy, task: taskOf('snip-headtail') }), /set once/);
  // a command the effect does not declare cannot be run through its capability
  await assert.rejects(caps.exec.run('harness-check', ['0']), /not among the declared/);
});

test('act, live, with no copy set by the host: nothing runs', async () => {
  const host = makeHost();
  await host.store.write('calls', 'i1', '[]');
  await assert.rejects(act({ fused: false }, capsFor(host, ['harness-tool']), { instanceId: 'i1' }), /no task copy/);
});

test('stageCheck, live: the broken copy fails the stage as a permanent error, the fixed copy passes it', async () => {
  const host = makeHost();
  const task = taskOf('snip-headtail');
  const { copy } = prepare('snip-headtail', run);
  host.setWorld({ copy, task });
  const caps = capsFor(host, ['harness-check']);
  await assert.rejects(stageCheck({ stage: 0 }, caps, { instanceId: 'i1' }), (e) => e.permanent === true && /stage check failed/.test(e.message));
  applyReference(copy, task.stages[0]);
  assert.deepEqual(await stageCheck({ stage: 0 }, caps, { instanceId: 'i1' }), { ok: true });
  // stage 1 is still broken
  await assert.rejects(stageCheck({ stage: 1 }, caps, { instanceId: 'i1' }), (e) => e.permanent === true);
  applyReference(copy, task.stages[1]);
  assert.deepEqual(await stageCheck({ stage: 1 }, caps, { instanceId: 'i1' }), { ok: true });
  // a stage the task does not have is not a pass
  await assert.rejects(stageCheck({ stage: 3 }, caps, { instanceId: 'i1' }), /no stage 3/);
});

test('the recorded handlers are unchanged: a recorded row is used, and the host is not asked', async () => {
  const host = makeHost();
  const caps = { store: host.transports.store, exec: { run: async () => { throw new Error('the host was asked'); } } };
  await host.store.write('calls', 'i1', '[]');
  await host.store.write('recorded-tool', 'i1', { output: 'PASS', exitStatus: 0 });
  await act({ fused: false }, caps, { instanceId: 'i1' });
  assert.deepEqual(await host.store.read('output', 'i1'), { text: 'PASS', exitStatus: 0 });
  await host.store.write('recorded-stage', 'i1', [true, false]);
  assert.deepEqual(await stageCheck({ stage: 0 }, caps, { instanceId: 'i1' }), { ok: true });
  await assert.rejects(stageCheck({ stage: 1 }, caps, { instanceId: 'i1' }), (e) => e.permanent === true);
});

test('the originals are unchanged after the live handlers ran', () => {
  assert.deepEqual(originalsUnchanged(), { 'todo-app': true, snip: true });
});
