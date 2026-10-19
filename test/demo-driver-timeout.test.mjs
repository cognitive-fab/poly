// DB6 item 11: the listen timeout and the time a build took to start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { replay, format, classify } from '../demo/driver/replay.mjs';

const DOUBLES = fileURLToPath(new URL('./fixtures/demo/doubles/', import.meta.url));
const DEMO_DIR = fileURLToPath(new URL('../demo', import.meta.url));
const DEMO_MJS = join(DEMO_DIR, 'demo.mjs');
let TEMP_BASE;

test.before(() => {
  TEMP_BASE = mkdtempSync(join(tmpdir(), '.temp-timeout-'));
});

test.after(() => {
  try { rmSync(TEMP_BASE, { recursive: true }); } catch { /* might be already gone */ }
});

// Helper: timeout wrapper with proper cleanup.
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);
    timer.unref();
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

// ---- DB6.11a: flag validation and timeout behavior ----

test('DB6.11a: --listen-timeout 0 exits 2 with usage message naming --listen-timeout', () => {
  const result = spawnSync(process.execPath, [
    DEMO_MJS,
    'replay',
    '--build', join(TEMP_BASE, 'nonexistent'),
    '--start', 'node server.mjs',
    '--quiet-ms', '300',
    '--listen-timeout', '0',
  ], {
    encoding: 'utf8',
    timeout: 25000,
  });

  assert.equal(result.status, 2, 'should exit with status 2 for zero listen-timeout');
  const output = result.stderr;
  assert.match(output, /--listen-timeout/, 'stderr should name the flag');
});

test('DB6.11a: --listen-timeout -5 exits 2 with usage message naming --listen-timeout', () => {
  const result = spawnSync(process.execPath, [
    DEMO_MJS,
    'replay',
    '--build', join(TEMP_BASE, 'nonexistent'),
    '--start', 'node server.mjs',
    '--quiet-ms', '300',
    '--listen-timeout', '-5',
  ], {
    encoding: 'utf8',
    timeout: 25000,
  });

  assert.equal(result.status, 2, 'should exit with status 2 for negative listen-timeout');
  const output = result.stderr;
  assert.match(output, /--listen-timeout/, 'stderr should name the flag');
});

test('DB6.11a: --listen-timeout 1.5 exits 2 with usage message naming --listen-timeout', () => {
  const result = spawnSync(process.execPath, [
    DEMO_MJS,
    'replay',
    '--build', join(TEMP_BASE, 'nonexistent'),
    '--start', 'node server.mjs',
    '--quiet-ms', '300',
    '--listen-timeout', '1.5',
  ], {
    encoding: 'utf8',
    timeout: 25000,
  });

  assert.equal(result.status, 2, 'should exit with status 2 for fractional listen-timeout');
  const output = result.stderr;
  assert.match(output, /--listen-timeout/, 'stderr should name the flag');
});

test('DB6.11a: --listen-timeout abc exits 2 with usage message naming --listen-timeout', () => {
  const result = spawnSync(process.execPath, [
    DEMO_MJS,
    'replay',
    '--build', join(TEMP_BASE, 'nonexistent'),
    '--start', 'node server.mjs',
    '--quiet-ms', '300',
    '--listen-timeout', 'abc',
  ], {
    encoding: 'utf8',
    timeout: 25000,
  });

  assert.equal(result.status, 2, 'should exit with status 2 for non-numeric listen-timeout');
  const output = result.stderr;
  assert.match(output, /--listen-timeout/, 'stderr should name the flag');
});

test('DB6.11a: --listen-timeout with empty string exits 2 with usage message naming --listen-timeout', () => {
  const result = spawnSync(process.execPath, [
    DEMO_MJS,
    'replay',
    '--build', join(TEMP_BASE, 'nonexistent'),
    '--start', 'node server.mjs',
    '--quiet-ms', '300',
    '--listen-timeout', '',
  ], {
    encoding: 'utf8',
    timeout: 25000,
  });

  assert.equal(result.status, 2, 'should exit with status 2 for empty listen-timeout');
  const output = result.stderr;
  assert.match(output, /--listen-timeout/, 'stderr should name the flag');
});

test('DB6.11a: --listen-timeout missing (flag last with no value) exits 2 with usage message naming --listen-timeout', () => {
  const result = spawnSync(process.execPath, [
    DEMO_MJS,
    'replay',
    '--build', join(TEMP_BASE, 'nonexistent'),
    '--start', 'node server.mjs',
    '--quiet-ms', '300',
    '--listen-timeout',
  ], {
    encoding: 'utf8',
    timeout: 25000,
  });

  assert.equal(result.status, 2, 'should exit with status 2 for missing listen-timeout value');
  const output = result.stderr;
  assert.match(output, /--listen-timeout/, 'stderr should name the flag');
});

test('DB6.11a: --listen-timeout 800 on slow-listener exits 3 with control.driven false and why names the timeout (DB6 item 11a)', () => {
  const logFile = join(TEMP_BASE, 'a-timeout.log');
  writeFileSync(logFile, '');

  const result = spawnSync(process.execPath, [
    DEMO_MJS,
    'replay',
    '--build', join(DOUBLES, 'slow-listener'),
    '--start', `node server.mjs`,
    '--quiet-ms', '300',
    '--listen-timeout', '800',
    '--json',
  ], {
    encoding: 'utf8',
    timeout: 25000,
  });

  assert.equal(result.status, 3, 'should exit with status 3 for timeout');
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch (e) {
    assert.fail(`failed to parse JSON from stdout: ${e.message}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  assert.equal(output.control.driven, false, 'control should not be driven due to timeout');
  assert.match(output.control.why, /within 800 ms/, 'control.why should name the timeout (800 ms)');
});

test('DB6.11a: --listen-timeout 20000 on slow-listener is driven and startedMs is present and >= 2500 (DB6 item 11a)', () => {
  const logFile = join(TEMP_BASE, 'a-generous.log');
  writeFileSync(logFile, '');

  const result = spawnSync(process.execPath, [
    DEMO_MJS,
    'replay',
    '--build', join(DOUBLES, 'slow-listener'),
    '--start', `node server.mjs`,
    '--quiet-ms', '300',
    '--listen-timeout', '20000',
    '--json',
  ], {
    encoding: 'utf8',
    timeout: 30000,
  });

  assert.equal(result.status, 0, 'should exit with status 0 for successful refund (O2)');
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch (e) {
    assert.fail(`failed to parse JSON from stdout: ${e.message}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  assert.equal(output.control.driven, true, 'control should be driven with generous timeout');
  assert.ok(Number.isInteger(output.control.startedMs), 'startedMs should be an integer');
  assert.ok(output.control.startedMs >= 2500, 'startedMs should be at least 2500 ms (the delay)');
});

// ---- DB6.11b: startedMs property on driven and not-driven builds ----

test('DB6.11b: driven build has startedMs property as integer > 0 and <= elapsed time (DB6 item 11b)', async () => {
  const t0 = Date.now();
  const r = await withTimeout(
    replay({
      build: join(DOUBLES, 'no-retry'),
      start: 'node server.mjs',
      startMs: 6000,
      quietMs: 300,
      maxMs: 10000,
    }),
    25000
  );
  const elapsed = Date.now() - t0;

  assert.equal(r.control.driven, true, 'control should be driven');
  assert.ok(Number.isInteger(r.control.startedMs), 'control.startedMs should be an integer');
  assert.ok(r.control.startedMs > 0, 'control.startedMs should be above 0');
  assert.ok(r.control.startedMs <= elapsed, 'control.startedMs should not exceed total elapsed time');
});

test('DB6.11b: run that listened has startedMs property as integer > 0 and <= elapsed time (DB6 item 11b)', async () => {
  const t0 = Date.now();
  const r = await withTimeout(
    replay({
      build: join(DOUBLES, 'keys'),
      start: 'node server.mjs',
      startMs: 6000,
      quietMs: 300,
      maxMs: 10000,
      fault: 'lost-answer',
    }),
    25000
  );
  const elapsed = Date.now() - t0;

  assert.equal(r.run.driven, true, 'run should be driven');
  assert.ok(Number.isInteger(r.run.startedMs), 'run.startedMs should be an integer');
  assert.ok(r.run.startedMs > 0, 'run.startedMs should be above 0');
  assert.ok(r.run.startedMs <= elapsed, 'run.startedMs should not exceed total elapsed time');
});

test('DB6.11b: drive that did not listen has no startedMs property (DB6 item 11b)', async () => {
  const r = await withTimeout(
    replay({
      build: join(DOUBLES, 'slow-listener'),
      start: 'node server.mjs',
      startMs: 700,
      quietMs: 300,
      maxMs: 5000,
    }),
    25000
  );

  assert.equal(r.control.driven, false, 'control should not be driven due to timeout');
  assert.equal(Object.hasOwn(r.control, 'startedMs'), false, 'control should not have startedMs property when not driven');
});

// ---- DB6.11c: format() output includes startedMs in output ----

test('DB6.11c: format(result) adds " | started in <n> ms" to control row with startedMs (DB6 item 11c)', () => {
  const control = {
    driven: true,
    why: null,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
    startedMs: 1234,
  };
  const run = {
    driven: true,
    why: null,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: 'reset' }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const classifyResult = classify(control, run);
  const result = {
    build: '/test',
    fault: 'test-fault',
    start: 'node server.mjs',
    standIn: { valid: true },
    control,
    run,
    tests: { status: 'not given' },
    request: { text: 'test', amount: 5000 },
    ...classifyResult,
  };

  const formatted = format(result);
  assert.match(formatted, /control.*\| started in 1234 ms/, 'control line should include " | started in 1234 ms"');
});

test('DB6.11c: format(result) adds " | started in <n> ms" to fault run row when run has startedMs (DB6 item 11c)', () => {
  const control = {
    driven: true,
    why: null,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
    startedMs: 1234,
  };
  const run = {
    driven: true,
    why: null,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: 'reset' }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
    startedMs: 5678,
  };
  const classifyResult = classify(control, run);
  const result = {
    build: '/test',
    fault: 'test-fault',
    start: 'node server.mjs',
    standIn: { valid: true },
    control,
    run,
    tests: { status: 'not given' },
    request: { text: 'test', amount: 5000 },
    ...classifyResult,
  };

  const formatted = format(result);
  assert.match(formatted, /\| started in 5678 ms/, 'fault run line should include " | started in 5678 ms"');
});

test('DB6.11c: format(result) adds no " | started in" to row without startedMs (DB6 item 11c)', () => {
  const control = {
    driven: true,
    why: null,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const run = {
    driven: true,
    why: null,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: 'reset' }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const classifyResult = classify(control, run);
  const result = {
    build: '/test',
    fault: 'test-fault',
    start: 'node server.mjs',
    standIn: { valid: true },
    control,
    run,
    tests: { status: 'not given' },
    request: { text: 'test', amount: 5000 },
    ...classifyResult,
  };

  const formatted = format(result);
  const lines = formatted.split('\n');
  const linesWithStarted = lines.filter((line) => line.match(/started in/));
  assert.equal(linesWithStarted.length, 0, 'no line should contain "started in" when neither control nor run has startedMs');
});

// ---- DB6.11d: timeout reason and default ----

test('DB6.11d: startMs 700 on slow-listener reasons message names the timeout value (DB6 item 11d)', async () => {
  const r = await withTimeout(
    replay({
      build: join(DOUBLES, 'slow-listener'),
      start: 'node server.mjs',
      startMs: 700,
      quietMs: 300,
      maxMs: 5000,
    }),
    25000
  );

  assert.equal(r.control.driven, false, 'control should not be driven due to timeout');
  assert.match(r.control.why, /within 700 ms/, 'timeout reason should name the startMs value (700 ms)');
});

test('DB6.11d: replay() with no startMs and fast double is driven; default 15000 is not tested cheaply (DB6 item 11d)', async () => {
  // The default listen-timeout is 15000 ms. This cannot be tested cheaply as it would require waiting 15+ seconds.
  // This test verifies that when no startMs is given, a fast double (no-retry) is driven successfully,
  // confirming the default allows normal operation. The actual default value (15000) is verified by the CLI
  // documentation and the code, not by a timed wait here.
  const r = await withTimeout(
    replay({
      build: join(DOUBLES, 'no-retry'),
      start: 'node server.mjs',
      quietMs: 300,
      maxMs: 8000,
    }),
    15000
  );

  assert.equal(r.control.driven, true, 'control should be driven with the default startMs');
});
