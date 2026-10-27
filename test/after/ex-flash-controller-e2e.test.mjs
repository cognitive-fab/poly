// Flash-controller end-to-end test over recorded device.
// Tests the machine through recorded device answers with no network calls.
// Rule 7a: Written from spec alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayRuntime, replaySessions } from '@poly/check';
import { ROOT } from '../helpers.mjs';
import { loadExample, settle, admitExample } from '../ex-kit.mjs';

let cachedAdmission;
/** One admission for the whole file: each test loads its own runtime from the same certified build. */
const admitted = () => (cachedAdmission ??= admitExample('flash-controller'));

const EX_DIR = join(ROOT, 'examples', 'flash-controller');

test('flash-controller: admission checks the program and policy; the example admits', { timeout: 60_000 }, async () => {
  const a = await admitted();
  assert.ok(a.dir);
  assert.ok(a.report);
  assert.equal(a.report.verdict, 'CLEAN', JSON.stringify(a.report.diagnostics));
});

test('flash-controller: main path - program with 2, verify once: Verified, data 2, retries 0', { timeout: 120_000 }, async () => {
  const { recordedDevice: recorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  // The spec's shape is { calls, device }; these tests use one object, the device with its calls on it.
  const recordedDevice = (script) => { const r = recorded(script); return Object.assign(r.device, { calls: r.calls }); };
  const { driveBlock } = await import(pathToFileURL(join(EX_DIR, 'host', 'controller.ts')).href);

  const a = await admitted();
  const { rt } = await loadExample(a);
  try {
    await rt.create('flash.Block', { id: 'block-main' });
    const id = 'block-main';

    // Device answers ok for all operations.
    const device = recordedDevice({ program: ['ok'], verify: ['ok'], erase: ['ok'] });

    // Drive the block with value 2.
    const finalState = await driveBlock(rt, id, device, 2);

    // Check the final state: should be Verified.
    const state = (await rt.getState(id)).state;
    assert.equal(state.state, 'Verified', `Block state is Verified; got ${state.state}`);
    assert.equal(state.data, 2, `data is 2; got ${state.data}`);
    assert.equal(state.retries, 0, `retries is 0; got ${state.retries}`);

    // Check device calls: should be program(2) and verify exactly once.
    const calls = device.calls ?? [];
    const callOps = calls.map((c) => [c.op, c.value]);
    assert.ok(callOps.some((op) => op[0] === 'program' && op[1] === 2), 'program(2) was called');
    assert.ok(callOps.some((op) => op[0] === 'verify'), 'verify() was called');
    const verifyCount = callOps.filter((op) => op[0] === 'verify').length;
    assert.equal(verifyCount, 1, `verify called once; got ${verifyCount}`);

    console.log(`flash-controller main path: Block Verified with data 2, retries 0`);
  } finally {
    await rt.close();
  }
});

test('flash-controller: refusal - Program on Programmed is rejected not-erased; state unchanged', { timeout: 120_000 }, async () => {
  const { recordedDevice: recorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  // The spec's shape is { calls, device }; these tests use one object, the device with its calls on it.
  const recordedDevice = (script) => { const r = recorded(script); return Object.assign(r.device, { calls: r.calls }); };

  const a = await admitted();
  const { rt } = await loadExample(a);
  try {
    await rt.create('flash.Block', { id: 'block-refusal-1' });
    const id = 'block-refusal-1';

    // Get initial state (should be Erased).
    const initialState = await rt.getState(id);
    assert.equal(initialState.state.state, 'Erased', 'initial state is Erased');

    // Program the block (goes to Programming then Programmed).
    const device = recordedDevice({ program: ['ok'], verify: ['ok'] });
    await rt.dispatch(id, 'Program', { value: 1 });
    await rt.dispatch(id, 'ProgramDone', {});

    // Now block is Programmed.
    const afterProgram = await rt.getState(id);
    assert.equal(afterProgram.state.state, 'Programmed', 'after ProgramDone, state is Programmed');

    // Try to Program again: should be rejected with not-erased.
    const result = await rt.dispatch(id, 'Program', { value: 2 });
    assert.equal(result.stepKind, 'rejected', 'Program on Programmed is rejected');
    assert.equal(result.rejectReason, 'not-erased', `rejection reason is not-erased; got ${result.rejectReason}`);

    // State should be unchanged.
    const stateAfterRejection = await rt.getState(id);
    assert.deepEqual(stateAfterRejection.state, afterProgram.state, 'state is unchanged after rejection');

    // Test Erase on a fresh erased block: should be rejected nothing-to-erase.
    await rt.create('flash.Block', { id: 'block-refusal-erase' });
    const eraseResult = await rt.dispatch('block-refusal-erase', 'Erase', {});
    assert.equal(eraseResult.stepKind, 'rejected', 'Erase on Erased is rejected');
    assert.equal(eraseResult.rejectReason, 'nothing-to-erase', `rejection reason is nothing-to-erase; got ${eraseResult.rejectReason}`);

    console.log(`flash-controller refusal: Program rejected when not erased, Erase rejected on erased block`);
  } finally {
    await rt.close();
  }
});

test('flash-controller: within limit - verify fails twice then passes: Verified, retries 2, erase called twice', { timeout: 120_000 }, async () => {
  const { recordedDevice: recorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  // The spec's shape is { calls, device }; these tests use one object, the device with its calls on it.
  const recordedDevice = (script) => { const r = recorded(script); return Object.assign(r.device, { calls: r.calls }); };
  const { driveBlock } = await import(pathToFileURL(join(EX_DIR, 'host', 'controller.ts')).href);

  const a = await admitted();
  const { rt } = await loadExample(a);
  try {
    await rt.create('flash.Block', { id: 'block-retry' });
    const id = 'block-retry';

    // Device: program ok, verify fails twice then passes, erase ok.
    const device = recordedDevice({
      program: ['ok'],
      verify: ['fail', 'fail', 'ok'],
      erase: ['ok', 'ok'],
    });

    // Drive the block.
    await driveBlock(rt, id, device, 3);

    // Final state should be Verified with retries 2.
    const state = (await rt.getState(id)).state;
    assert.equal(state.state, 'Verified', `Block state is Verified; got ${state.state}`);
    assert.equal(state.data, 3, `data is 3; got ${state.data}`);
    assert.equal(state.retries, 2, `retries is 2 (two failures); got ${state.retries}`);

    // Check that erase was called twice.
    const calls = device.calls ?? [];
    const eraseCalls = calls.filter((c) => c.op === 'erase');
    assert.equal(eraseCalls.length, 2, `erase called twice; got ${eraseCalls.length}`);

    console.log(`flash-controller within limit: retries 2 when verify fails twice then passes`);
  } finally {
    await rt.close();
  }
});

test('flash-controller: at limit - verify fails always: Bad, retries 2, all actions rejected terminal', { timeout: 120_000 }, async () => {
  const { recordedDevice: recorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  // The spec's shape is { calls, device }; these tests use one object, the device with its calls on it.
  const recordedDevice = (script) => { const r = recorded(script); return Object.assign(r.device, { calls: r.calls }); };
  const { driveBlock } = await import(pathToFileURL(join(EX_DIR, 'host', 'controller.ts')).href);

  const a = await admitted();
  const { rt } = await loadExample(a);
  try {
    await rt.create('flash.Block', { id: 'block-bad' });
    const id = 'block-bad';

    // Device: program ok, verify fails always (repeats fail).
    const device = recordedDevice({
      program: ['ok'],
      verify: ['fail'],
      erase: ['ok'],
    });

    // Drive the block: should hit the limit and go Bad.
    // No error is swallowed: driveBlock returns the block's final state, which is Bad.
    const returned = await driveBlock(rt, id, device, 0);
    assert.equal(returned?.state ?? returned, 'Bad', 'driveBlock returns the final state');

    // Final state should be Bad with retries 2.
    const state = (await rt.getState(id)).state;
    assert.equal(state.state, 'Bad', `Block state is Bad; got ${state.state}`);
    assert.equal(state.retries, 2, `retries is 2 (hit limit); got ${state.retries}`);

    // Now every action should be rejected with terminal.
    const actions = ['Program', 'ProgramDone', 'ProgramFailed', 'Verify', 'VerifyPassed', 'VerifyFailed', 'Erase', 'EraseDone'];
    assert.ok(actions.length === 8, 'testing all 8 action names');
    for (const action of actions) {
      const payload = action === 'Program' ? { value: 0 } : {};
      const result = await rt.dispatch(id, action, payload);
      assert.equal(result.stepKind, 'rejected', `${action} is rejected on Bad block`);
      assert.equal(result.rejectReason, 'terminal', `${action} rejected with terminal; got ${result.rejectReason}`);
      // State should be unchanged.
      const stateAfter = await rt.getState(id);
      assert.equal(stateAfter.state.state, 'Bad', `state is still Bad after rejected ${action}`);
    }

    console.log(`flash-controller at limit: all 8 actions rejected with terminal on Bad block`);
  } finally {
    await rt.close();
  }
});

test('flash-controller: erase and rewrite - Verified block erased then programmed with new value', { timeout: 120_000 }, async () => {
  const { recordedDevice: recorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  // The spec's shape is { calls, device }; these tests use one object, the device with its calls on it.
  const recordedDevice = (script) => { const r = recorded(script); return Object.assign(r.device, { calls: r.calls }); };
  const { driveBlock } = await import(pathToFileURL(join(EX_DIR, 'host', 'controller.ts')).href);

  const a = await admitted();
  const { rt } = await loadExample(a);
  try {
    await rt.create('flash.Block', { id: 'block-erase-rewrite' });
    const id = 'block-erase-rewrite';

    // First write: program with 1, verify passes.
    const device1 = recordedDevice({ program: ['ok'], verify: ['ok'], erase: ['ok'] });
    await driveBlock(rt, id, device1, 1);

    const afterFirst = await rt.getState(id);
    assert.equal(afterFirst.state.state, 'Verified', 'after first write, block is Verified');
    assert.equal(afterFirst.state.data, 1, 'data is 1');

    // Now erase the block explicitly.
    const eraseResult = await rt.dispatch(id, 'Erase', {});
    assert.equal(eraseResult.stepKind, 'accepted', 'Erase is accepted on Verified block');

    const afterErase = await rt.getState(id);
    assert.equal(afterErase.state.state, 'Erasing', 'after Erase, state is Erasing');

    // Dispatch EraseDone.
    const eraseDoneResult = await rt.dispatch(id, 'EraseDone', {});
    assert.equal(eraseDoneResult.stepKind, 'accepted', 'EraseDone is accepted on Erasing block');

    const afterEraseDone = await rt.getState(id);
    assert.equal(afterEraseDone.state.state, 'Erased', 'after EraseDone, state is Erased');

    // Now rewrite with value 3.
    const device2 = recordedDevice({ program: ['ok'], verify: ['ok'], erase: ['ok'] });
    await driveBlock(rt, id, device2, 3);

    const afterSecond = await rt.getState(id);
    assert.equal(afterSecond.state.state, 'Verified', 'after second write, block is Verified');
    assert.equal(afterSecond.state.data, 3, 'data is now 3');

    console.log(`flash-controller erase and rewrite: Verified block erased and programmed with new value`);
  } finally {
    await rt.close();
  }
});

test('flash-controller: journal replays with no divergence', { timeout: 120_000 }, async () => {
  const { recordedDevice: recorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  // The spec's shape is { calls, device }; these tests use one object, the device with its calls on it.
  const recordedDevice = (script) => { const r = recorded(script); return Object.assign(r.device, { calls: r.calls }); };
  const { driveBlock } = await import(pathToFileURL(join(EX_DIR, 'host', 'controller.ts')).href);

  const a = await admitted();
  const { rt } = await loadExample(a);
  try {
    await rt.create('flash.Block', { id: 'block-replay' });
    const id = 'block-replay';

    // Run a simple sequence: program, verify.
    const device = recordedDevice({ program: ['ok'], verify: ['ok'], erase: ['ok'] });
    await driveBlock(rt, id, device, 2);

    // Replay the runtime.
    const replays = await replayRuntime(rt);
    assert.ok(replays.length > 0, 'there are replayed runs');
    for (const r of replays) {
      assert.deepEqual([r.diagnostics, r.notRun ?? null, r.gateNotRun], [[], null, 0], `divergence in ${r.machine}: ${JSON.stringify(r.diagnostics)}`);
    }

    // Check that flash.Block is among the replayed machines.
    const kinds = new Set(replays.map((x) => x.machine));
    assert.ok(kinds.has('flash.Block'), `flash.Block should be in replayed machines; got ${[...kinds].join(', ')}`);

    // Replay sessions (policy gates).
    const sessions = await replaySessions(rt);
    for (const s of sessions) {
      assert.deepEqual([s.diagnostics.length, s.notRun.length], [0, 0], `session divergence: ${JSON.stringify(s.diagnostics)}`);
    }

    console.log(`replay: ${replays.length} runs, ${replays.reduce((n, x) => n + x.rows, 0)} rows; ${sessions.length} gate sessions`);
  } finally {
    await rt.close();
  }
});
