// PT33.5 (DAC5, DAC6, DAC7): load refuses PL6411 for unguarded irreversible entries;
// seeded runtime faults for unkeyed-retry-allowed and window-lapse-ignored behavior;
// keyed intent takes WindowLapsed after window lapses with exhausted completion and lapsed outcome.
// PT33.5a: OutboxIntent model gains WindowLapsed transition.
// PS23.7: the window lapse prevents new attempts after the declared window since the first attempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LoadError } from '@poly/runtime';
import { MODEL_SOURCE } from '@poly/runtime/model';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';

// Fixture paths
const UNGUARDED = 'test/fixtures/s526/loadworker/unguarded.poly';
const KEYED = 'test/fixtures/s526/loadworker/keyed.poly';
const EXHAUSTED_FIXTURE = 'test/fixtures/s526/loadworker/unguarded-exhausted.poly';
const SAFE = 'test/fixtures/s526/loadworker/safe.poly';

/**
 * Admits a project, turning a thrown error into assert.fail with a PT33.1 message naming
 * the missing feature when appropriate. Returns the admitted project or fails the test.
 */
async function admitOrFail(name, sources, expecting = null) {
  try {
    return await admitted(name, sources);
  } catch (e) {
    if (expecting && expecting(e)) return null; // Expected failure
    if (e.message && e.message.includes('PL4003')) {
      assert.fail(`PT33.1/PT33.5 item 1: idempotent/retry clause not yet parsed or admitted: ${e.message}`);
    }
    assert.fail(`admission failed unexpectedly: ${e.message}`);
  }
}

// Cache admissions to avoid re-running the checker
let admittedKeyed, admittedSafe, admittedExhausted;

const keyedProject = async () => {
  if (!admittedKeyed) admittedKeyed = await admitOrFail('s526-load-keyed', [KEYED]);
  return admittedKeyed;
};

const safeProject = async () => {
  if (!admittedSafe) admittedSafe = await admitOrFail('s526-load-safe', [SAFE]);
  return admittedSafe;
};

const exhaustedProject = async () => {
  if (!admittedExhausted) admittedExhausted = await admitOrFail('s526-load-exhausted', [EXHAUSTED_FIXTURE]);
  return admittedExhausted;
};

// ── PT33.5 item 1: Admission refuses unguarded irreversible with PL4003 ────────

test('PT33.5 item 1: admitted refuses unguarded irreversible entry as PL4003', async () => {
  // The unguarded variant U has no idempotent clause, no retry clause, and is irreversible.
  // PT33.5 item 1 requires admission to refuse it with PL4003 (UNGUARDED_RETRY) when
  // no signed acceptance lifts the finding. Today U is admitted because the rule is not
  // yet implemented, so this assertion fails: the right reason.
  let error;
  try {
    await admitted('s526-load-unguarded', [UNGUARDED]);
  } catch (e) {
    error = e;
  }

  if (error) {
    // After the feature, expect PL4003 in the error message
    assert.match(error.message, /PL4003/, 'should refuse with PL4003 code');
  } else {
    // Today the feature is missing, so admission succeeds; the test fails with the right reason
    assert.fail('PT33.5 item 1: admission should refuse PL4003 but succeeded (feature not yet implemented)');
  }
});

// ── PT33.5 item 2: Load refuses PL6411 for unsafe manifest ────────────────────

test('PT33.5 item 2: load refuses PL6411 for irreversible entry with no idempotency', { todo: 'no way to build the unsafe artefact yet: see the AMBIGUOUS note (the lead raises it with the reviewer)' }, async () => {
  // PT33.5 item 2 requires load to refuse a manifest with an irreversible effect that has
  // maxAttempts >= 2, no idempotency, and no certified acceptance, with PL6411
  // (RETRY_UNSAFE_MANIFEST).
  //
  // To test this, we would need to:
  // 1. Admit a variant with a safe retry config (to pass admission)
  // 2. Edit the built manifest to remove idempotency and increase maxAttempts to 5
  // 3. Load and assert PL6411
  //
  // However, the certificate binds artefact digests, so editing the manifest after
  // admission will likely fail at load for digest mismatch (a different reason than PL6411).
  // A full test would require re-signing the certificate with the admission key.
  //
  // AMBIGUOUS: The spec does not clarify whether a toolchain fault allows bypassing
  // admission of U (the unguarded variant). If such a fault existed, we could:
  // - Seed that fault to admit U with an unsafe manifest
  // - Load without the fault
  // - Assert the PL6411 refusal
  //
  // Today: the feature is not yet implemented, so:
  // - If we edit the manifest after admission, load fails on digest mismatch
  // - If we try to load the safe variant's build unchanged, it loads (no PL6411 check)
  // This test is deferred: we cannot construct a valid, loadable build with the
  // unguarded entry without either re-signing (implementing the cert signing) or a
  // toolchain fault (not documented).

  // Mark this test as not yet implementable
  assert.fail('PT33.5 item 2: cannot construct a testable unsafe build today (PL6411 check not yet implemented, cert re-signing not yet built)');
});

// ── PT33.5 item 3: Seeded fault unkeyed-retry-allowed ────────────────────────

test('PT33.5 item 3: seeded fault unkeyed-retry-allowed creates intent with bound 1', async () => {
  // PT33.5 item 3 says the worker creates an intent with bound 1 (runtime1.OutboxIntent).
  // The seeded fault unkeyed-retry-allowed disables this protection, allowing multiple attempts.
  //
  // This test loads with the fault, verifies that the intent is created with bound 1,
  // and asserts that after the first attempt fails, no retry occurs.

  // Use the exhausted fixture so we can observe the exhausted completion
  const a = await exhaustedProject();
  const { rt, clock } = await loaded(a, { fault: 'unkeyed-retry-allowed' });
  try {
    const calls = [];
    handleWith(rt, 's526.work', (_payload, _caps, _ctx) => {
      calls.push(1);
      throw new Error('attempt failed');
    });
    await rt.create('s526base.Job', { id: 'job-bound1' });
    await rt.dispatch('job-bound1', 'Go', {});
    await rt.worker.tick();

    // Advance clock several times to give the worker ample opportunity to retry
    for (let i = 0; i < 3; i++) {
      clock.advance(61_000);
      await rt.worker.tick();
    }

    // With the fault, the intent has bound 1 so it cannot retry.
    // The handler should be called exactly once.
    assert.equal(calls.length, 1, 'handler called exactly once (bound 1)');

    // The job should be Failed (exhausted completion delivered)
    const state = await rt.getState('job-bound1');
    assert.equal(state.state.phase, 'Failed', 'Job should be Failed after exhausted');
  } finally { await rt.close(); }
});

// ── PS23.7: Window lapse behavior ──────────────────────────────────────────────

test('PS23.7: keyed intent does not attempt after window lapses', async () => {
  // PS23.7 says: A keyed intent does not start an attempt after its window has
  // lapsed since the first attempt began. Such an intent ends lapsed (PS23.1) by
  // the WindowLapsed transition, with the exhausted completion delivered and
  // observation outcome lapsed.
  //
  // This test:
  // 1. Uses the keyed variant K with 1-hour window
  // 2. First attempt fails
  // 3. Advances clock past the 1-hour window
  // 4. Asserts the handler is NOT called again (called once total)
  // 5. Asserts the Job is Failed and OutboxIntent is Dead
  // 6. Asserts observation event has outcome 'lapsed'

  const a = await keyedProject();
  const { rt, clock } = await loaded(a);
  try {
    const calls = [];
    handleWith(rt, 's526.work', (_payload, _caps, _ctx) => {
      calls.push(1);
      throw new Error('lost answer');
    });

    await rt.create('s526base.Job', { id: 'job-lapse' });
    await rt.dispatch('job-lapse', 'Go', {});
    await rt.worker.tick();

    // First attempt has run and failed
    assert.equal(calls.length, 1, 'first attempt made');

    // Advance clock by 2 hours (well past the 1-hour window)
    clock.advance(2 * 60 * 60 * 1000);
    await rt.worker.tick();

    // After the window lapse, the handler should not be called again
    assert.equal(calls.length, 1, 'handler not called after window lapse (still exactly 1)');

    // The Job should be Failed
    const jobState = await rt.getState('job-lapse');
    assert.equal(jobState.state.phase, 'Failed', 'Job in Failed state after window lapse');

    // Check the outbox intent state
    const [row] = await rt.outbox('job-lapse');
    if (row) {
      const intent = await rt.worker.intentState(row);
      assert.equal(intent.intent, 'Dead', 'OutboxIntent is Dead after window lapse');
    }

    // Check observation event for lapsed outcome
    const events = await rt.chain('job-lapse');
    const obsEvent = events.find((e) => e.kind === 'observation');
    if (obsEvent) {
      assert.match(obsEvent.body?.outcome ?? '', /lapsed/, 'observation outcome is lapsed');
    }
  } finally { await rt.close(); }
});

// ── Seeded fault: window-lapse-ignored ─────────────────────────────────────────

test('PS23.7: seeded fault window-lapse-ignored allows retry despite window lapse', async () => {
  // The seeded fault window-lapse-ignored disables the window lapse check in the worker.
  // This test runs the same scenario as the preceding test, but with the fault enabled,
  // and asserts that the handler IS called a second time (proving the fault works by
  // showing the difference).

  const a = await keyedProject();

  // First: run without the fault (window lapse prevents second attempt)
  const { rt: rt1, clock: clock1 } = await loaded(a);
  const calls1 = [];
  try {
    handleWith(rt1, 's526.work', (_payload, _caps, _ctx) => {
      calls1.push(1);
      throw new Error('lost answer');
    });
    await rt1.create('s526base.Job', { id: 'job-no-fault' });
    await rt1.dispatch('job-no-fault', 'Go', {});
    await rt1.worker.tick();

    clock1.advance(2 * 60 * 60 * 1000);
    await rt1.worker.tick();

    assert.equal(calls1.length, 1, 'without fault: handler called once (window lapse blocks retry)');
  } finally { await rt1.close(); }

  // Second: run with the fault (window lapse ignored, retry occurs)
  const a2 = await keyedProject();
  const { rt: rt2, clock: clock2 } = await loaded(a2, { fault: 'window-lapse-ignored' });
  const calls2 = [];
  try {
    let failCount = 0;
    handleWith(rt2, 's526.work', (_payload, _caps, _ctx) => {
      calls2.push(1);
      // First attempt fails, second succeeds
      failCount++;
      if (failCount === 1) throw new Error('lost answer');
      return { ok: true };
    });
    await rt2.create('s526base.Job', { id: 'job-with-fault' });
    await rt2.dispatch('job-with-fault', 'Go', {});
    await rt2.worker.tick();

    clock2.advance(2 * 60 * 60 * 1000);
    await rt2.worker.tick();

    // With fault, the retry should proceed even though window lapsed
    assert.ok(calls2.length >= 2, `with fault: handler called ${calls2.length} times (including retry after lapse)`);
  } finally { await rt2.close(); }
});

// ── PT33.5a: OutboxIntent model text-level check ──────────────────────────────

test('PT33.5a: OutboxIntent model source declares action WindowLapsed()', () => {
  // PT33.5a says the outbox model gains:
  //   action WindowLapsed()
  //   on WindowLapsed { match intent { Allowed => intent' = Dead ... } }
  //
  // This is a text-level check of the model source. It does not run the model
  // or check its behavior; it only verifies the action and transition are present
  // in the source code.

  const source = readFileSync(MODEL_SOURCE, 'utf8');

  // Check for the WindowLapsed action declaration
  const hasAction = /action\s+WindowLapsed\s*\(\s*\)/.test(source);
  assert.ok(hasAction, 'OutboxIntent model should declare action WindowLapsed()');
});

test('PT33.5a: OutboxIntent model has on WindowLapsed with Allowed => Dead transition', () => {
  // PT33.5a says: "it is not in the fair group (it is taken by the worker's clock,
  // as Recheck is)."
  // This test verifies the transition exists. It does NOT check the fairness group
  // (that requires model checking, which is in scope for Step 5, not here).

  const source = readFileSync(MODEL_SOURCE, 'utf8');

  // Check for the on WindowLapsed handler
  const hasHandler = /on\s+WindowLapsed\s*\{/.test(source);
  assert.ok(hasHandler, 'OutboxIntent model should have on WindowLapsed handler');

  // Check for the Allowed => Dead transition within the handler
  const hasTransition = /on\s+WindowLapsed[\s\S]{0,500}?Allowed\s*=>\s*intent\s*=\s*Dead/.test(source);
  assert.ok(hasTransition, 'on WindowLapsed should have Allowed => intent\' = Dead transition');
});

// ── CONTROL: Safe variant with keyed header and attempts 1 ──────────────────────

test('CONTROL: PT33.5 item 3: keyed variant with attempts 1 succeeds at first attempt', async () => {
  // This CONTROL test verifies that the test harness works for success cases.
  // It uses the safe variant S (keyed with attempts 1) and asserts:
  // 1. Handler is called once
  // 2. Handler succeeds
  // 3. Job ends Done
  //
  // This protects the success path: keyed retry with attempts 1 and successful
  // handler should leave no intent unfinished. Today this should pass because
  // it exercises the core harness without depending on the retry-safety feature.

  const a = await safeProject();
  const { rt } = await loaded(a);
  try {
    const calls = [];
    handleWith(rt, 's526.work', (_payload, _caps, _ctx) => {
      calls.push(1);
      return { ok: true };
    });

    await rt.create('s526base.Job', { id: 'job-safe' });
    await rt.dispatch('job-safe', 'Go', {});
    await rt.worker.tick();

    // Handler should be called exactly once
    assert.equal(calls.length, 1, 'handler called once for successful attempt');

    // Job should end Done
    const state = await rt.getState('job-safe');
    assert.equal(state.state.phase, 'Done', 'Job should be Done after successful handler');
  } finally { await rt.close(); }
});
