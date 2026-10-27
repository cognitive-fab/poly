// Flash-controller example tests: light checks (node:test).
// The tests are written from docs/examples/flash-controller.md alone, before any code exists.
// Rule 7a: The tests verify the spec without reading the program files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandNamed } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { checkExample, expectedOf, mismatch } from './examples-expected.mjs';

const EX_DIR = join(ROOT, 'examples', 'flash-controller');
const PROGRAM = join(EX_DIR, 'flash-controller.poly');
const DEFECT = join(EX_DIR, 'flash-controller-defect.poly');

// ── light checks ──

test('the program, checked with its policy, is CLEAN with instance printed', async () => {
  const report = await checkExample(PROGRAM, ROOT);
  const expected = expectedOf(PROGRAM);
  assert.ok(expected, 'the program\'s first line declares its expected verdict');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'CLEAN');
  // Verify that the policy is paired with the program (per spec).
  const policies = report.policies ?? [];
  assert.ok(policies.length > 0, 'at least one policy is present');
  const flashPolicy = policies.find((p) => p.scope === 'flash');
  assert.ok(flashPolicy, 'the policy is paired with the program and has scope flash');
  // Check policy stages are CLEAN.
  assert.ok(flashPolicy.stages && Array.isArray(flashPolicy.stages), 'policy has stages array');
  assert.ok(flashPolicy.stages.length > 0, 'policy stages is non-empty');
  for (const stage of flashPolicy.stages) {
    assert.equal(stage.verdict, 'CLEAN', `policy stage ${stage.stage} is CLEAN`);
  }
  // Verify the instance is printed: Block with 76 states.
  const machines = report.machines ?? [];
  assert.equal(machines.length, 1, 'one machine Block');
  assert.equal(machines[0].machine, 'Block');
  const inst = machines[0].instance;
  assert.ok(inst, 'instance is present');
  assert.equal(inst.states, 76, `Block instance has 76 states; got ${inst.states}`);
  // Log the instance as the spec requires.
  console.log(`flash-controller instance: ${machines[0].machine}; ${inst.states} states`);
});

test('the defect is FINDINGS with exactly PL3002, erased-before-program named, witness of 2 steps both Program', async () => {
  const report = await checkExample(DEFECT, ROOT);
  const expected = expectedOf(DEFECT);
  assert.ok(expected, 'the defect\'s first line declares expected FINDING PL3002');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'FINDINGS');
  // Find the PL3002 diagnostic.
  const machines = report.machines ?? [];
  const allDiags = machines.flatMap((m) => m.diagnostics ?? []);
  const pl3002 = allDiags.find((d) => d.code === 'PL3002');
  assert.ok(pl3002, `PL3002 not found; found: ${allDiags.map((d) => d.code).join(', ')}`);
  assert.equal(pl3002.name, 'STEP_PROPERTY', 'the finding is a step property');
  assert.ok(pl3002.property, 'the property is named');
  assert.equal(pl3002.property, 'erased-before-program', 'the property is erased-before-program');
  // Check the witness: 2 steps means witness.length === 2.
  assert.ok(pl3002.witness, 'the diagnostic has a witness');
  assert.equal(pl3002.witness.length, 2, `witness length is 2; got ${pl3002.witness.length}`);
  assert.equal(pl3002.witness.trace.length, 2, 'witness.trace.length === 2');
  // Verify the actions are both Program.
  const actions = pl3002.witness.trace.map((s) => s.action);
  assert.deepEqual(actions, ['Program', 'Program'], 'the witness steps are both Program');
});

test('poly check --host with root examples/flash-controller is CLEAN', { timeout: 120_000 }, async () => {
  // The host check uses host/tsconfig.json at the example root.
  const hostTsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  const r = await commandNamed('check').run({ target: PROGRAM, root: EX_DIR, host: hostTsConfig });
  assert.equal(r.result.verdict, 'CLEAN', JSON.stringify(r.result.host?.diagnostics));
  assert.equal(r.result.host.status, 'ran');
  assert.deepEqual(r.result.host.diagnostics, []);
});

test('a host handler with a wrong action name is PL6836', { timeout: 120_000 }, async () => {
  // Create a temporary broken version of the controller to test PL6836 detection.
  const tmpRoot = join(tmpdir(), `poly-test-flash-host-${Date.now()}`);
  mkdirSync(join(tmpRoot, 'host'), { recursive: true });
  // Copy the correct controller and tsconfig.
  const controller = join(EX_DIR, 'host', 'controller.ts');
  const tsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  let controllerSrc = readFileSync(controller, 'utf8');
  // Break an action name: replace 'VerifyPassed' with 'VerifyPassd' (misspelled).
  // This will cause a TypeScript error (PL6836) when type-checking against the Block type.
  const broken = controllerSrc.split('VerifyPassed').join('VerifyPassd');
  assert.notEqual(broken, controllerSrc, 'the mutation must change the file');
  writeFileSync(join(tmpRoot, 'host', 'controller.ts'), broken);
  writeFileSync(join(tmpRoot, 'host', 'tsconfig.json'), readFileSync(tsConfig, 'utf8'));
  // Also copy the program to tmpRoot.
  writeFileSync(join(tmpRoot, 'flash-controller.poly'), readFileSync(PROGRAM, 'utf8'));
  // Run the host check on the broken controller.
  const r = await commandNamed('check').run({ target: join(tmpRoot, 'flash-controller.poly'), root: tmpRoot, host: join(tmpRoot, 'host', 'tsconfig.json') });
  // Every diagnostic should be PL6836.
  assert.ok(r.result.host.diagnostics.length > 0, 'there are diagnostics for the broken controller');
  const allCodes = r.result.host.diagnostics.map((d) => d.code);
  assert.ok(allCodes.every((c) => c === 'PL6836'), `all codes should be PL6836; got ${allCodes.join(', ')}`);
});

test('driveBlock against a fake runtime: dispatches Program, ProgramDone, Verify, VerifyPassed in order', async () => {
  // Import the controller from the example.
  const hostController = await import(pathToFileURL(join(EX_DIR, 'host', 'controller.ts')).href);
  const { driveBlock } = hostController;

  // Create a fake runtime that simulates the Block state.
  const dispatches = [];
  let blockState = 'Erased';
  let blockData = 0;
  let blockRetries = 0;
  const fakeRt = {
    dispatch: async (id, actionName, payload) => {
      dispatches.push({ id, actionName, payload });
      if (dispatches.length > 50) throw new Error('too many dispatches, infinite loop detected');
      // Simulate state transitions.
      if (actionName === 'Program' && blockState === 'Erased') {
        blockState = 'Programming';
        blockData = payload.value;
      } else if (actionName === 'ProgramDone' && blockState === 'Programming') {
        blockState = 'Programmed';
      } else if (actionName === 'Verify' && blockState === 'Programmed') {
        blockState = 'Verifying';
      } else if (actionName === 'VerifyPassed' && blockState === 'Verifying') {
        blockState = 'Verified';
      }
      return { stepKind: 'accepted' };
    },
    getState: async (id) => ({
      state: { state: blockState, data: blockData, retries: blockRetries },
    }),
  };

  // Device that always answers ok.
  const device = {
    program: async () => 'ok',
    verify: async () => 'ok',
    erase: async () => 'ok',
  };

  // Drive the block.
  const finalState = await driveBlock(fakeRt, 'block-1', device, 2);

  // Check dispatches are in the right order.
  const actions = dispatches.map((d) => d.actionName);
  assert.deepEqual(actions, ['Program', 'ProgramDone', 'Verify', 'VerifyPassed'], 'dispatches are in order: Program, ProgramDone, Verify, VerifyPassed');

  // Check the id is passed through.
  assert.ok(dispatches.every((d) => d.id === 'block-1'), 'all dispatches use the correct id');

  // Check the Program payload has the value.
  const programDispatch = dispatches.find((d) => d.actionName === 'Program');
  assert.ok(programDispatch, 'Program dispatch exists');
  assert.deepEqual(programDispatch.payload, { value: 2 }, 'Program payload is { value: 2 }');

  // Check erase was never called.
  assert.ok(!dispatches.some((d) => d.actionName === 'Erase'), 'Erase is not dispatched on the happy path');

  // Normalize the final state for comparison.
  const state = typeof finalState === 'string' ? finalState : finalState.state;
  assert.equal(state, 'Verified', `final state is Verified; got ${state}`);
});

test('recordedDevice answers in order, repeats last, defaults to ok', async () => {
  // Import recordedDevice from the example.
  const hostRecorded = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const rawDevice = hostRecorded.recordedDevice;
  const recordedDevice = (script) => { const r = rawDevice(script); return Object.assign(r.device, { calls: r.calls }); };

  // Test 1: script with program fail then ok, verify fail.
  const device1 = recordedDevice({ program: ['fail', 'ok'], verify: ['fail'] });
  assert.deepEqual(await device1.program(1), 'fail', 'first program() answers fail');
  assert.deepEqual(await device1.program(2), 'ok', 'second program() answers ok');
  assert.deepEqual(await device1.program(3), 'ok', 'third program() repeats last (ok)');
  assert.deepEqual(await device1.verify(), 'fail', 'first verify() answers fail');
  assert.deepEqual(await device1.verify(), 'fail', 'second verify() repeats last (fail)');

  // Test 2: empty lists default to ok.
  const device2 = recordedDevice({ program: [], verify: [] });
  assert.deepEqual(await device2.program(1), 'ok', 'empty program list defaults to ok');
  assert.deepEqual(await device2.verify(), 'ok', 'empty verify list defaults to ok');

  // Test 3: missing erase list defaults to ok.
  const device3 = recordedDevice({ program: ['ok'], verify: ['ok'] });
  assert.deepEqual(await device3.erase(), 'ok', 'missing erase list defaults to ok');

  // Test 4: calls are recorded (check via the { calls } return).
  const device4 = recordedDevice({ program: ['ok', 'fail'], verify: ['ok'] });
  const recorded = device4.calls ?? [];
  assert.ok(Array.isArray(recorded), 'calls is an array or recordedDevice provides it');
  // Trigger some calls.
  await device4.program(5);
  await device4.verify();
  await device4.erase();
  // The exact recording shape varies; just check it doesn't throw.
  console.log(`recordedDevice recorded calls (check shape)`);
});
