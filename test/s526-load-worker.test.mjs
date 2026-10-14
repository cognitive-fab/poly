// PT33.5, PT33.5a, PT33.5b, PS23.7 (DAC5): the runtime enforces the rule a second and a third time.
//   item 1  admission refuses an unguarded irreversible entry (PL4003, no acceptance);
//   item 2  load refuses it again, PL6411, even when the certificate's signature is valid;
//   item 3  the worker creates the intent with bound 1, so the target is reached once even if load let it through;
//   PS23.7  a keyed intent starts no attempt after its window has lapsed, and ends `lapsed`.
// The unsafe artefact is built by test/fixtures/s526/forge-unsafe-build.mjs (PT33.5b): it edits the manifest of an
// admitted build and signs the certificate with the test trust key, bypassing the checker. Each seeded runtime fault is
// caught by its own test, so neither layer hides behind the other (the names are in S526_RUNTIME_FAULTS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { certificateDigest } from '@poly/core';
import { load, LoadError, RUNTIME_FAULTS } from '@poly/runtime';
import { MODEL_SOURCE } from '@poly/runtime/model';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';
import { forgeUnsafeBuild } from './fixtures/s526/forge-unsafe-build.mjs';
import { S526_RUNTIME_FAULTS } from './toolchain-faults.mjs';

const UNGUARDED = 'test/fixtures/s526/loadworker/unguarded.poly';
const KEYED = 'test/fixtures/s526/loadworker/keyed.poly';
const SAFE = 'test/fixtures/s526/loadworker/safe.poly'; // retry { attempts 1 }, ok/failed/exhausted: CLEAN today

/** Admits a keyed variant; a refusal fails with the name of the missing feature, never as a bare crash. */
async function admitKeyed(name) {
  try {
    return await admitted(name, [KEYED]);
  } catch (e) {
    return assert.fail(`PT33.1: the idempotent clause is not accepted yet: ${e.message}`);
  }
}

/** An admitted safe build whose manifest and certificate are then forged to an unguarded irreversible entry of 5 attempts. */
async function unsafeBuild(name) {
  return forgeUnsafeBuild(await admitted(name, [SAFE]), { kind: 's526.work', maxAttempts: 5 });
}

const loadOptions = (a, extra = {}) => ({ certificate: a.certificate, trust: a.trust, ...extra });

/** Runs a Job whose handler always fails (a lost answer) for many worker ticks and reports what the target saw. */
async function runLost(a, extra = {}) {
  const { rt, clock } = await loaded(a, extra);
  try {
    let calls = 0;
    handleWith(rt, 's526.work', () => { calls++; throw new Error('lost answer'); });
    await rt.create('s526base.Job', { id: 'job' });
    await rt.dispatch('job', 'Go', {});
    for (let i = 0; i < 12; i++) { await rt.worker.tick(); clock.advance(70_000); }
    return { calls, phase: (await rt.getState('job')).state.phase };
  } finally { await rt.close(); }
}

// ---- the helper itself ------------------------------------------------------------------------------------------------

test('CONTROL: PT33.5b: the forged build has an unguarded entry of 5 attempts and a certificate that is sealed and signed', async () => {
  // Protects the helper (it passes today and must keep passing): without a valid seal and signature the load tests below
  // would fail for the wrong reason.
  const a = await unsafeBuild('s526-forge-control');
  const cert = JSON.parse(readFileSync(a.certificate, 'utf8'));
  assert.equal(cert.digest, certificateDigest(cert), 'the certificate is sealed');
  assert.equal(cert.signatures[0].keyId, a.key.id, 'it is signed with the test trust key');
  const man = JSON.parse(readFileSync(`${a.build}/s526base.Job/effects.manifest.json`, 'utf8')).effects['s526.work'];
  assert.equal(man.retry.maxAttempts, 5);
  assert.equal(man.class, 'irreversible');
  assert.equal(man.idempotency, undefined);
});

// ---- the seeded faults exist -------------------------------------------------------------------------------------------

test('PT33.5: the four seeded runtime faults are listed and exist in RUNTIME_FAULTS', () => {
  assert.deepEqual([...S526_RUNTIME_FAULTS].sort(), ['idempotency-header-dropped', 'unkeyed-retry-admitted-at-load', 'unkeyed-retry-unclamped', 'window-lapse-ignored']);
  const known = Array.isArray(RUNTIME_FAULTS) ? RUNTIME_FAULTS : Object.keys(RUNTIME_FAULTS ?? {});
  for (const f of S526_RUNTIME_FAULTS) assert.ok(known.includes(f), `RUNTIME_FAULTS names ${f} (it has: ${known.join(', ')})`);
});

// ---- item 1: admission -------------------------------------------------------------------------------------------------

test('PT33.5 item 1: admission refuses the unguarded irreversible entry, naming PL4003', async () => {
  await assert.rejects(admitted('s526-load-unguarded', [UNGUARDED]), (e) => /PL4003|FINDINGS/.test(e.message), 'PL4003 is an unaccepted finding: not admitted');
});

// ---- item 2: load ------------------------------------------------------------------------------------------------------

test('PT33.5 item 2: load refuses the forged unguarded build with PL6411, although its signature is valid', async () => {
  const a = await unsafeBuild('s526-load-refuse');
  await assert.rejects(load(a.build, loadOptions(a)), (e) => e instanceof LoadError && /PL6411/.test(e.message), 'PL6411 RETRY_UNSAFE_MANIFEST');
});

test('PT33.5 item 2, its own fault: unkeyed-retry-admitted-at-load disables the load check and nothing else', async () => {
  const a = await unsafeBuild('s526-load-fault');
  await assert.rejects(load(a.build, loadOptions(a)), (e) => e instanceof LoadError && /PL6411/.test(e.message), 'without the fault load refuses (PL6411)');
  const rt = await load(a.build, loadOptions(a, { fault: 'unkeyed-retry-admitted-at-load' }));
  await rt.close();
});

test('PT33.5 item 2, its own fault: unkeyed-retry-unclamped does not disable the load check', async () => {
  const a = await unsafeBuild('s526-load-unclamped');
  await assert.rejects(load(a.build, loadOptions(a, { fault: 'unkeyed-retry-unclamped' })), (e) => e instanceof LoadError && /PL6411/.test(e.message), 'the load layer still refuses');
});

// ---- item 3: the worker clamp ------------------------------------------------------------------------------------------

test('PT33.5 item 3: with the load check bypassed, the intent is created with bound 1: the target is reached once and the exhausted completion ends the job', async () => {
  const a = await unsafeBuild('s526-clamp');
  const r = await runLost(a, { fault: 'unkeyed-retry-admitted-at-load' });
  assert.equal(r.calls, 1, 'the handler (the target) ran once');
  assert.equal(r.phase, 'Failed', 'the job ended through the exhausted completion');
});

test('PT33.5 item 3, its own fault: unkeyed-retry-unclamped removes the clamp (seeded on both layers the target is reached 5 times), and the clamp is the layer that held', async () => {
  const a = await unsafeBuild('s526-clamp-fault');
  const clamped = await runLost(a, { fault: 'unkeyed-retry-admitted-at-load' });
  assert.equal(clamped.calls, 1, 'only the load layer seeded: the clamp holds, one call');
  const both = await runLost(a, { fault: ['unkeyed-retry-admitted-at-load', 'unkeyed-retry-unclamped'] });
  assert.equal(both.calls, 5, 'both layers seeded: the target is reached once per attempt, 5 times');
});

// ---- PS23.7: the window ------------------------------------------------------------------------------------------------

test('PS23.7: a keyed intent starts no attempt after its window has lapsed: Dead, the exhausted completion, observation `lapsed`', async () => {
  const a = await admitKeyed('s526-load-keyed');
  const { rt, clock } = await loaded(a);
  try {
    let calls = 0;
    handleWith(rt, 's526.work', () => { calls++; throw new Error('lost answer'); });
    await rt.create('s526base.Job', { id: 'job-lapse' });
    await rt.dispatch('job-lapse', 'Go', {});
    await rt.worker.tick();
    assert.equal(calls, 1, 'the first attempt ran');
    clock.advance(2 * 60 * 60 * 1000); // past the declared 1h window
    await rt.worker.tick();
    assert.equal(calls, 1, 'no second attempt after the window lapsed');
    assert.equal((await rt.getState('job-lapse')).state.phase, 'Failed', 'the exhausted completion was delivered');
    const [row] = await rt.outbox('job-lapse');
    assert.ok(row, 'the intent has an outbox row');
    assert.equal((await rt.worker.intentState(row)).intent, 'Dead');
    const obs = (await rt.chain('job-lapse')).filter((e) => e.kind === 'observation');
    assert.ok(obs.some((e) => e.body?.outcome === 'lapsed'), `an observation with outcome lapsed: ${JSON.stringify(obs.map((e) => e.body?.outcome))}`);
  } finally { await rt.close(); }
});

test('PS23.7, its own fault: window-lapse-ignored lets the attempt run after the window (the difference shows the check is the cause)', async () => {
  const a = await admitKeyed('s526-load-keyed-fault');
  const run = async (extra) => {
    const { rt, clock } = await loaded(a, extra);
    try {
      let calls = 0;
      handleWith(rt, 's526.work', () => { calls++; throw new Error('lost answer'); });
      await rt.create('s526base.Job', { id: 'job-w' });
      await rt.dispatch('job-w', 'Go', {});
      await rt.worker.tick();
      clock.advance(2 * 60 * 60 * 1000);
      await rt.worker.tick();
      return calls;
    } finally { await rt.close(); }
  };
  assert.equal(await run({}), 1, 'without the fault: one call');
  assert.equal(await run({ fault: 'window-lapse-ignored' }), 2, 'with the fault: the second attempt runs after the window');
});

// ---- PT33.5a: the model ------------------------------------------------------------------------------------------------

test('PT33.5a: the OutboxIntent model source declares `action WindowLapsed()`', () => {
  assert.match(readFileSync(MODEL_SOURCE, 'utf8'), /action\s+WindowLapsed\s*\(\s*\)/);
});

test('PT33.5a: `on WindowLapsed` takes Allowed to Dead and is not in the fair group', () => {
  const source = readFileSync(MODEL_SOURCE, 'utf8');
  assert.match(source, /on\s+WindowLapsed\s*\{[\s\S]{0,300}?Allowed\s*=>\s*intent'\s*=\s*Dead/);
  const fair = source.slice(source.indexOf('under fair'));
  assert.ok(source.includes('under fair'), 'the model states its fairness');
  assert.doesNotMatch(fair, /WindowLapsed/, 'WindowLapsed is taken by the worker clock, not by fairness');
});
