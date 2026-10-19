// DB6 item 10: driver hygiene (error handling, process group cleanup), and request option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { platform } from 'node:os';
import { classify, format, replay, REQUEST } from '../demo/driver/replay.mjs';

const DOUBLES = fileURLToPath(new URL('./fixtures/demo/doubles/', import.meta.url));
const DEMO_DIR = fileURLToPath(new URL('../demo', import.meta.url));
const DEMO_MJS = join(DEMO_DIR, 'demo.mjs');
let TEMP_BASE;

test.before(() => {
  TEMP_BASE = mkdtempSync(join(tmpdir(), '.temp-hygiene-'));
});

test.after(() => {
  try { rmSync(TEMP_BASE, { recursive: true }); } catch { /* might be already gone */ }
});

// ---- Helper: timeout wrapper with proper cleanup ----

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

// ---- Helper: check if a process is alive (handles Linux zombies) ----

async function isAlive(pid) {
  try {
    process.kill(pid, 0);
    if (platform() !== 'linux') return true;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.split(' ');
      const state = fields[2];
      return state !== 'Z';
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

// ---- (a) A command that cannot be started ----

test('(a1) missing build folder => O3 with outcome.driven false and why contains "could not be started"', async () => {
  const uncaughtExceptions = [];
  const unhandledRejections = [];
  const onException = (err) => uncaughtExceptions.push(err);
  const onRejection = (reason) => unhandledRejections.push(reason);

  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);

  try {
    const result = await withTimeout(
      replay({
        build: join(TEMP_BASE, 'no-such-build'),
        start: 'node server.mjs',
        startMs: 3000,
        quietMs: 300,
        maxMs: 5000,
      }),
      30000
    );
    assert.equal(result.outcome, 'O3');
    assert.equal(result.control.driven, false);
    assert.match(result.control.why, /could not be started/);
    assert.equal(result.run, null);
  } finally {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  }

  assert.equal(uncaughtExceptions.length, 0, 'no uncaughtException events');
  assert.equal(unhandledRejections.length, 0, 'no unhandledRejection events');
});

test('(a2) build folder exists, command does not (non-existent program) => O3 with outcome.driven false', async () => {
  const result = await withTimeout(
    replay({
      build: join(DOUBLES, 'no-retry'),
      start: 'definitely-not-a-command-xyz',
      startMs: 3000,
      quietMs: 300,
      maxMs: 5000,
    }),
    30000
  );
  assert.equal(result.outcome, 'O3');
  assert.equal(result.control.driven, false);
});

// ---- (b) Stopping the whole process group ----

test('(b) spawns-grandchild: parent and child are killed when replay returns', async () => {
  const pidFile1 = join(TEMP_BASE, 'parent.pid');
  const pidFile2 = join(TEMP_BASE, 'child.pid');
  let parentPid;
  let childPid;

  try {
    const result = await withTimeout(
      replay({
        build: join(DOUBLES, 'spawns-grandchild'),
        start: `node server.mjs "${pidFile1}" "${pidFile2}"`,
        startMs: 3000,
        quietMs: 300,
        maxMs: 5000,
        env: {
          PARENT_PID_FILE: pidFile1,
          CHILD_PID_FILE: pidFile2,
        },
      }),
      30000
    );

    assert.equal(result.outcome, 'O3');
    assert.equal(result.control.driven, true, 'build should start and be reached');

    parentPid = Number(readFileSync(pidFile1, 'utf8').trim());
    childPid = Number(readFileSync(pidFile2, 'utf8').trim());
    assert.ok(Number.isInteger(parentPid) && parentPid > 0, 'parent pid should be valid');
    assert.ok(Number.isInteger(childPid) && childPid > 0, 'child pid should be valid');
    assert.notEqual(parentPid, childPid, 'parent and child pids should differ');

    await new Promise((r) => setTimeout(r, 200));

    const parentAlive = await isAlive(parentPid);
    const childAlive = await isAlive(childPid);
    assert.equal(parentAlive, false, 'parent should not be alive after replay returns');
    assert.equal(childAlive, false, 'child should not be alive after replay returns');

    process.off('uncaughtException', () => {});
    process.off('unhandledRejection', () => {});
  } finally {
    const CLEANUP_TIMEOUT = 5000;
    const startTime = Date.now();
    while (Date.now() - startTime < CLEANUP_TIMEOUT) {
      try {
        if (parentPid && parentPid > 0) {
          try {
            process.kill(-parentPid, 'SIGKILL');
          } catch {
            try { process.kill(parentPid, 'SIGKILL'); } catch { /* ignore */ }
          }
        }
        if (childPid && childPid > 0) {
          try {
            process.kill(-childPid, 'SIGKILL');
          } catch {
            try { process.kill(childPid, 'SIGKILL'); } catch { /* ignore */ }
          }
        }
      } catch {
        /* ignore */
      }
      if (!parentPid || !childPid || !(await isAlive(parentPid)) && !(await isAlive(childPid))) break;
    }
  }
});

// ---- (c) The request option ----

test('(c1) request option with custom text and amount: turns[0] is request.text', async () => {
  const logFile = join(TEMP_BASE, 'c1.log');
  writeFileSync(logFile, '');

  const result = await withTimeout(
    replay({
      build: join(DOUBLES, 'confirms-then-refunds-with-key'),
      start: `node server.mjs "${logFile}"`,
      startMs: 3000,
      quietMs: 300,
      maxMs: 5000,
      request: { text: 'Please refund CUPS-4 from order ORD-1001.', amount: 4000 },
    }),
    30000
  );

  assert.ok(Array.isArray(result.control.turns) && result.control.turns.length > 0, 'turns should exist');
  assert.equal(result.control.turns[0], 'Please refund CUPS-4 from order ORD-1001.');
  assert.deepEqual(result.request, { text: 'Please refund CUPS-4 from order ORD-1001.', amount: 4000 });
});

test('(c2) request option with custom text and amount: first inbound message in log', async () => {
  const logFile = join(TEMP_BASE, 'c2.log');
  writeFileSync(logFile, '');

  await withTimeout(
    replay({
      build: join(DOUBLES, 'confirms-then-refunds-with-key'),
      start: `node server.mjs "${logFile}"`,
      startMs: 3000,
      quietMs: 300,
      maxMs: 5000,
      request: { text: 'Please refund CUPS-4 from order ORD-1001.', amount: 4000 },
    }),
    30000
  );

  const logContent = readFileSync(logFile, 'utf8');
  const lines = logContent.trim().split('\n').filter((l) => l.length > 0);
  const inLines = lines.filter((l) => JSON.parse(l).ev === 'in');
  const firstIn = inLines.length > 0 ? JSON.parse(inLines[0]) : null;
  assert.ok(firstIn, 'should have at least one inbound message');
  assert.equal(firstIn.text, 'Please refund CUPS-4 from order ORD-1001.');
});

test('(c3) request option with custom amount 6000: amount.asked equals request.amount', async () => {
  const logFile = join(TEMP_BASE, 'c3.log');
  writeFileSync(logFile, '');

  const result = await withTimeout(
    replay({
      build: join(DOUBLES, 'confirms-then-refunds-with-key'),
      start: `node server.mjs "${logFile}"`,
      startMs: 3000,
      quietMs: 300,
      maxMs: 5000,
      request: { text: "Hello, I'd like a refund of 60.00 for order ORD-1001.", amount: 6000 },
    }),
    30000
  );

  assert.ok(result.control.driven, 'control should be driven');
  assert.equal(result.outcome, 'O2');
  assert.equal(result.amount.asked, 6000);
  assert.equal(result.amount.over, false);
});

test('(c4) request option: result.request deepEquals the option', async () => {
  const logFile = join(TEMP_BASE, 'c4.log');
  writeFileSync(logFile, '');

  const customRequest = { text: 'Test request', amount: 5000 };
  const result = await withTimeout(
    replay({
      build: join(DOUBLES, 'confirms-then-refunds-with-key'),
      start: `node server.mjs "${logFile}"`,
      startMs: 3000,
      quietMs: 300,
      maxMs: 5000,
      request: customRequest,
    }),
    30000
  );

  assert.deepEqual(result.request, customRequest);
});

test('(c5) no request option: result.request deepEquals REQUEST default', async () => {
  const logFile = join(TEMP_BASE, 'c5.log');
  writeFileSync(logFile, '');

  const result = await withTimeout(
    replay({
      build: join(DOUBLES, 'confirms-then-refunds-with-key'),
      start: `node server.mjs "${logFile}"`,
      startMs: 3000,
      quietMs: 300,
      maxMs: 5000,
    }),
    30000
  );

  assert.deepEqual(result.request, { text: REQUEST.text, amount: REQUEST.amount });
});

test('(c6) format() with custom request includes request line', () => {
  const control = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const run = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: 'reset' }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const customRequest = { text: 'Custom refund request', amount: 5000 };
  const classifyResult = classify(control, run);
  const result = {
    build: '/test',
    fault: 'test-fault',
    start: 'node server.mjs',
    standIn: { valid: true },
    control,
    run,
    tests: { status: 'not given' },
    request: customRequest,
    ...classifyResult,
  };

  const formatted = format(result);
  assert.match(formatted, /request: Custom refund request \(not the pre-registered request\)/);
});

test('(c7) format() without custom request has no request line', () => {
  const control = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const run = {
    driven: true,
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
    request: { text: REQUEST.text, amount: REQUEST.amount },
    ...classifyResult,
  };

  const formatted = format(result);
  assert.doesNotMatch(formatted, /^request: /m);
});

test('(c8) classify(control, run, request) with request option and custom amount', () => {
  const log = JSON.parse(readFileSync(
    fileURLToPath(new URL('../docs/demo/step10-replay/second-pass/poly-kept.json', import.meta.url)), 'utf8'
  ));

  const customRequest = { text: 'Custom text', amount: 6000 };
  const result = classify(log.control, log.run, customRequest);
  assert.equal(result.amount.asked, 6000);
  assert.equal(result.amount.over, false);
});

test('(c9) classify(control, run) with default request', () => {
  const log = JSON.parse(readFileSync(
    fileURLToPath(new URL('../docs/demo/step10-replay/second-pass/poly-kept.json', import.meta.url)), 'utf8'
  ));

  const result = classify(log.control, log.run);
  assert.equal(result.amount.asked, REQUEST.amount);
  assert.equal(result.amount.over, true);
});

// ---- (d) The command line ----

test('(d1) CLI with --request-text but no --request-amount => exit 2 with usage message', () => {
  const result = spawnSync(process.execPath, [
    DEMO_MJS,
    'replay',
    '--build', join(DOUBLES, 'no-retry'),
    '--start', 'node server.mjs',
    '--request-text', 'Test request',
    '--quiet-ms', '300',
  ], {
    encoding: 'utf8',
    timeout: 120000,
  });

  assert.equal(result.status, 2);
  const output = result.stdout + result.stderr;
  assert.match(output, /request-amount/);
});

test('(d2) CLI with --request-amount but no --request-text => exit 2 with usage message', () => {
  const result = spawnSync(process.execPath, [
    DEMO_MJS,
    'replay',
    '--build', join(DOUBLES, 'no-retry'),
    '--start', 'node server.mjs',
    '--request-amount', '5000',
    '--quiet-ms', '300',
  ], {
    encoding: 'utf8',
    timeout: 120000,
  });

  assert.equal(result.status, 2);
  const output = result.stdout + result.stderr;
  assert.match(output, /request-text/);
});

test('(d3) CLI with both --request-text and --request-amount and --json => prints JSON with request field', () => {
  const logFile = join(TEMP_BASE, 'd3.log');
  writeFileSync(logFile, '');

  const result = spawnSync(process.execPath, [
    DEMO_MJS,
    'replay',
    '--build', join(DOUBLES, 'confirms-then-refunds-with-key'),
    '--start', `node server.mjs "${logFile}"`,
    '--request-text', "Please refund item CUPS-4 from order ORD-1001.",
    '--request-amount', '4000',
    '--json',
    '--quiet-ms', '300',
  ], {
    encoding: 'utf8',
    timeout: 120000,
  });

  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch (e) {
    assert.fail(`failed to parse JSON from stdout: ${e.message}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }

  assert.ok(output.request);
  assert.deepEqual(output.request, { text: "Please refund item CUPS-4 from order ORD-1001.", amount: 4000 });
});
