// DB6 item 12 and DAC32: every wait of the driver has a bound, the result of replay() says what its cleanup left behind, and a
// driver test that does not end fails under its own name. Written from the item alone (rule 7a), before the code.
//
// This file cannot take its per-test timeout from the helper it tests, so each test carries its own `{ timeout }`. Every wait a
// test starts here is also raced against a deadline the test owns: on a tree without the bounds of the item, a test fails at its
// deadline, says which bound is missing, and closes what it opened, so the file still ends (the failure of finding 33 was a file
// that never ended).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dc from 'node:diagnostics_channel';
import https from 'node:https';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { replay, selfCheck, format, StandInInvalid, ORDERS } from '../demo/driver/replay.mjs';
import { createAuthority } from '../demo/stand-in/stripe/tls.mjs';
import { createStripe } from '../demo/stand-in/stripe/stripe.mjs';
import { createStripeIgnoringKeys } from './fixtures/demo/mutants/stripe-ignores-key.mjs';

const DOUBLES = fileURLToPath(new URL('./fixtures/demo/doubles/', import.meta.url));
const HELPER = fileURLToPath(new URL('./fixtures/demo/driver-test.mjs', import.meta.url));
const HELPER_URL = pathToFileURL(HELPER).href;
const WINDOWS = process.platform === 'win32';
// Generous: the item's own bounds are what end a drive, and this only stops a run on a tree that lacks them.
const TEST_MS = 120_000;
// The margin over a bound when the test makes the authority itself: a timer fires late under load.
const MARGIN_MS = 5_000;
// The margin over the bound of replay(), which first makes the authority with three blocking runs of openssl (about 350 ms measured
// alone, more in a loaded parallel run) and starts the stand-in. A driver with the bound returns as soon as it fires, so a wide
// margin costs nothing there.
const REPLAY_MARGIN_MS = 20_000;
const drive = (name, options = {}) => replay({ build: join(DOUBLES, name), start: 'node server.mjs', quietMs: 1200, maxMs: 8000, startMs: 6000, ...options });

/** A promise that never rejects: what it settled with and how long after `start()` was called. */
function settle(start) {
  const t0 = Date.now();
  let p;
  try { p = Promise.resolve(start()); } catch (error) { p = Promise.reject(error); }
  return p.then((value) => ({ value, ms: Date.now() - t0 }), (error) => ({ error, ms: Date.now() - t0 }));
}

/** The settled result, or null when `ms` passed first. The timer is cleared either way. */
async function within(settling, ms) {
  let timer;
  const deadline = new Promise((resolveDeadline) => { timer = setTimeout(() => resolveDeadline(null), ms); });
  try { return await Promise.race([settling, deadline]); } finally { clearTimeout(timer); }
}

/** Closes a server and destroys every socket it accepted, so that nothing it opened holds the file. */
function closeAll(server, sockets, timers = new Set()) {
  for (const t of timers) clearInterval(t);
  for (const s of sockets) s.destroy();
  return new Promise((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections?.(); });
}

const listen = (server) => new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveListen(server.address().port)); });

/** The object the item allows in the place of the stand-in: `port`, `reset()` and `report()`. */
const standInAt = (port) => ({ port, reset() {}, report() { return { refunds: 0 }; } });

const orders = () => JSON.parse(readFileSync(ORDERS, 'utf8'));

/** The checks of DB6 item 12 (b) on a rejection of selfCheck: StandInInvalid, with exactly the message the item gives. */
function assertNoAnswer(r, requestMs) {
  assert.ok(r, `selfCheck did not settle within ${requestMs} ms and a margin of ${MARGIN_MS} ms: its requests have no bound`);
  assert.ok(r.error, `selfCheck resolved, it should have thrown: ${JSON.stringify(r.value)}`);
  assert.ok(r.error instanceof StandInInvalid, `the error is StandInInvalid, not ${r.error?.constructor?.name}: ${r.error?.message}`);
  assert.equal(r.error.message, `the stand-in fails its own check: no answer within ${requestMs} ms`);
  // A request is bounded from the moment it is sent, so the check cannot give up before the bound (a timer may fire 1 ms early).
  assert.ok(r.ms >= requestMs - 20, `selfCheck gave up after ${r.ms} ms, before its bound of ${requestMs} ms`);
}

// ---- DB6 item 12 (b): the self-check's requests ------------------------------------------------------------------------------

test('DB6.12b: selfCheck against a server that accepts a connection and never answers throws StandInInvalid naming requestMs, within the bound and a margin', { timeout: TEST_MS }, async () => {
  const authority = createAuthority();
  const sockets = new Set();
  const server = net.createServer((s) => { sockets.add(s); s.on('error', () => {}); });
  try {
    const port = await listen(server);
    const requestMs = 500;
    const r = await within(settle(() => selfCheck(standInAt(port), authority, orders(), { requestMs })), requestMs + MARGIN_MS);
    assertNoAnswer(r, requestMs);
    assert.ok(sockets.size >= 1, 'the server accepted the connection of the check');
  } finally { await closeAll(server, sockets); authority.remove(); }
});

test('DB6.12b: the bound of a self-check request is over the whole answer: a server that sends its headers and then one byte at a time, forever, is cut at requestMs', { timeout: TEST_MS }, async () => {
  // A socket's idle timeout would never fire here, since a byte arrives every requestMs / 4. The item asks for a wall-clock timer
  // from the moment the request is sent to the end of its answer.
  const authority = createAuthority();
  const requestMs = 800;
  const sockets = new Set();
  const timers = new Set();
  const server = https.createServer({ key: authority.key, cert: authority.cert }, (req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    const t = setInterval(() => { if (!res.destroyed) res.write(' '); }, requestMs / 4);
    timers.add(t);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('error', () => {}); });
  try {
    const port = await listen(server);
    const r = await within(settle(() => selfCheck(standInAt(port), authority, orders(), { requestMs })), requestMs + MARGIN_MS);
    assertNoAnswer(r, requestMs);
  } finally { await closeAll(server, sockets, timers); authority.remove(); }
});

test('DB6.12b: each of the three self-check requests is bounded from the moment it is sent: a server that answers the first late and never the second makes selfCheck throw StandInInvalid naming requestMs', { timeout: TEST_MS }, async () => {
  // The first answer comes after 0.6 of the bound, within it. The second request then has the whole bound of its own, so the check
  // gives up no sooner than 1.6 bounds after it began. One deadline over the whole check would give up after one bound.
  const authority = createAuthority();
  const requestMs = 600;
  const firstAfterMs = Math.round(requestMs * 0.6);
  const sockets = new Set();
  const timers = new Set();
  let seen = 0;
  const server = https.createServer({ key: authority.key, cert: authority.cert }, (req, res) => {
    req.resume();
    seen += 1;
    if (seen === 1) {
      const t = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 're_bounds_1', object: 'refund' }));
      }, firstAfterMs);
      timers.add(t);
    }
    // Every later request is accepted and never answered.
  });
  server.on('connection', (s) => { sockets.add(s); s.on('error', () => {}); });
  try {
    const port = await listen(server);
    const r = await within(settle(() => selfCheck(standInAt(port), authority, orders(), { requestMs })), firstAfterMs + requestMs + MARGIN_MS);
    assertNoAnswer(r, requestMs);
    assert.ok(seen >= 2, `the second request reached the server (${seen} seen)`);
    assert.ok(r.ms >= firstAfterMs + requestMs - 20, `the second request had its own bound: the check gave up after ${r.ms} ms, before ${firstAfterMs + requestMs} ms`);
  } finally { for (const t of timers) clearTimeout(t); await closeAll(server, sockets); authority.remove(); }
});

test('DB6.12b: the default of requestMs is 10000: selfCheck with no options against a server that never answers names 10000 ms', { timeout: TEST_MS }, async () => {
  const authority = createAuthority();
  const sockets = new Set();
  const server = net.createServer((s) => { sockets.add(s); s.on('error', () => {}); });
  try {
    const port = await listen(server);
    const r = await within(settle(() => selfCheck(standInAt(port), authority, orders())), 10_000 + MARGIN_MS);
    assertNoAnswer(r, 10_000);
  } finally { await closeAll(server, sockets); authority.remove(); }
});

// The real stand-in made to never complete an answer, through the public `stripe` option of replay(): the factory wraps the real
// Stripe behaviour and declares one byte more in Content-Length than the body it gives, so the client gets the headers and waits
// for the rest. This depends on the stand-in passing the factory's headers to writeHead, which it does today.
// On a tree without the bound the self-check would wait forever inside replay(), whose stand-in this test cannot close. So at its
// deadline the test writes the missing byte on each held socket (found through the HTTP server's diagnostics channel) and lets
// every later answer through: the check then completes, replay() ends and closes what it opened, and the test fails by name.
async function driveSilentStandIn({ selfCheckMs }) {
  const bound = selfCheckMs ?? 10_000;
  const build = mkdtempSync(join(tmpdir(), 'poly-bounds-build-'));
  const marker = join(build, 'started');
  // A build that only says it was started. If the driver starts it, the marker exists.
  writeFileSync(join(build, 'server.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./started', import.meta.url), 'started');\n");
  const state = { silent: true };
  const held = new Set();
  const servers = new Set();
  // The stand-in's server closes a connection that has been idle for its keepAliveTimeout (5000 ms by default) after a response it
  // thinks complete. That would end the held answer early, as a closed connection and not as a request with no answer, and before
  // the default bound of 10000 ms. So the server is told not to: the answer is then held for as long as the client waits.
  const onRequest = ({ socket, server }) => {
    servers.add(server);
    if (!state.silent) return;
    server.keepAliveTimeout = 0;
    held.add(socket);
  };
  const silentStripe = (options) => {
    const real = createStripe(options);
    return {
      ...real,
      handle(request) {
        const h = real.handle(request);
        if (!state.silent) return h;
        return { ...h, headers: { ...h.headers, 'content-length': String(Buffer.byteLength(JSON.stringify(h.body)) + 1) } };
      },
    };
  };
  dc.subscribe('http.server.request.start', onRequest);
  try {
    const settling = settle(() => replay({ build, start: 'node server.mjs', quietMs: 300, maxMs: 3000, startMs: 3000, stripe: silentStripe, ...(selfCheckMs === undefined ? {} : { selfCheckMs }) }));
    let r = await within(settling, bound + REPLAY_MARGIN_MS);
    const inTime = r !== null;
    if (!inTime) {
      state.silent = false;
      for (const s of held) if (!s.destroyed) s.write(' ');
      held.clear();
      r = await within(settling, 30_000);
      // The last resort: a replay() that still has not returned keeps the stand-in open, so the test closes it itself.
      if (r === null) for (const s of servers) { s.close(); s.closeAllConnections?.(); }
    }
    return { r, inTime, started: existsSync(marker), bound };
  } finally {
    dc.unsubscribe('http.server.request.start', onRequest);
    rmSync(build, { recursive: true, force: true });
  }
}

function assertStandInInvalidByBound({ r, inTime, started, bound }) {
  assert.ok(inTime, `replay() did not return within the self-check bound of ${bound} ms and a margin of ${REPLAY_MARGIN_MS} ms: the self-check has no bound`);
  assert.ok(r && !r.error, `replay() threw: ${r?.error?.stack ?? 'it did not settle'}`);
  const result = r.value;
  assert.equal(result.outcome, 'stand-in-invalid', result.reason);
  assert.match(result.reason, new RegExp(`no answer within ${bound} ms`), 'the reason names the bound');
  assert.equal(result.control, null, 'no control was driven');
  assert.equal(result.run, null, 'no fault run was driven');
  assert.equal(started, false, 'no build was started');
  assert.ok(Array.isArray(result.cleanup), `a stand-in-invalid result carries cleanup (it has ${JSON.stringify(result.cleanup)})`);
  assert.deepEqual(result.cleanup, [], 'no process was started and the stand-in closed');
}

test('DB6.12b: replay({ selfCheckMs }) with a real stand-in that never completes an answer is stand-in-invalid, its reason names the bound, and no build is started', { timeout: TEST_MS }, async () => {
  assertStandInInvalidByBound(await driveSilentStandIn({ selfCheckMs: 1500 }));
});

test('DB6.12b: the default of selfCheckMs is 10000: replay() with the same stand-in and no selfCheckMs names 10000 ms', { timeout: TEST_MS }, async () => {
  assertStandInInvalidByBound(await driveSilentStandIn({}));
});

// ---- DB6 item 12 (f): the cleanup in the result ------------------------------------------------------------------------------

test('DB6.12f: a normal drive of a double that refunds once carries cleanup [], and format() prints no cleanup line', { timeout: TEST_MS }, async () => {
  const r = await drive('keys');
  assert.equal(r.outcome, 'O2', r.reason);
  assert.deepEqual(r.cleanup, [], 'every process was stopped and the stand-in closed');
  const lines = format(r).split('\n');
  assert.deepEqual(lines.filter((l) => l.startsWith('cleanup:')), [], 'no cleanup line when the list is empty');
});

test('DB6.12f: a stand-in-invalid result (the stand-in that ignores the key) also carries cleanup, an empty list', { timeout: TEST_MS }, async () => {
  const r = await drive('keys', { stripe: createStripeIgnoringKeys });
  assert.equal(r.outcome, 'stand-in-invalid', r.reason);
  assert.ok(Array.isArray(r.cleanup), `cleanup is a list (it is ${JSON.stringify(r.cleanup)})`);
  assert.deepEqual(r.cleanup, [], 'no build was started and the stand-in closed');
  assert.deepEqual(format(r).split('\n').filter((l) => l.startsWith('cleanup:')), []);
});

test('DB6.12f: format() prints one line "cleanup: <entry>" for each entry, in order, after the line of the build\'s own tests', { timeout: TEST_MS }, () => {
  const numbers = (fault) => ({ requests: 1, posts: [{ key: 'k1', status: 200, replayed: false, fault }], refunds: 1, amountRefunded: { ch_demo_1001: 4000 }, amount: { ch_demo_1001: 10000 }, reply: ['done'] });
  const cleanup = [
    'control: taskkill did not finish within 10000 ms (pid 4242); a process of the build may still be running',
    'fault lost-answer: taskkill could not be run (spawnSync taskkill ENOENT) (pid 4343); a process of the build may still be running',
    'the stand-in did not close within 5000 ms',
  ];
  const result = {
    build: '/test', start: 'node server.mjs', fault: 'lost-answer', standIn: { valid: true },
    control: { driven: true, numbers: numbers(null) }, run: { driven: true, numbers: numbers('reset') },
    outcome: 'O2', reason: 'refunds once', amount: { asked: 4000, refunded: 4000, over: false },
    tests: { status: 'passed' }, cleanup,
  };
  const lines = format(result).split('\n');
  const testsAt = lines.findIndex((l) => l.startsWith('its own tests:'));
  assert.ok(testsAt >= 0, 'format() prints the line of the build\'s own tests');
  const cleanupAt = lines.map((l, i) => (l.startsWith('cleanup:') ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(cleanupAt.map((i) => lines[i]), cleanup.map((e) => `cleanup: ${e}`), 'one line per entry, in order');
  assert.ok(cleanupAt.every((i) => i > testsAt), `every cleanup line comes after the tests line:\n${lines.join('\n')}`);
});

// ---- DB6 item 12 (d) and (f): stopping the build on Windows -----------------------------------------------------------------

const ENTRY = (label) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: taskkill did not finish within 1 ms \\(pid (\\d+)\\); a process of the build may still be running$`);

/** Every pid named by a cleanup entry. */
const pidsOf = (cleanup) => (Array.isArray(cleanup) ? cleanup : []).flatMap((e) => [...String(e).matchAll(/\(pid (\d+)\)/g)].map((m) => Number(m[1])));

/** Stops what a taskkill cut short left running, with a normal time limit, so that no process outlives the file. */
function stopLeftovers(pids) {
  for (const pid of new Set(pids)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10_000, stdio: 'ignore', windowsHide: true });
}

test('DB6.12d,f: on Windows, stopMs 1 gives one cleanup entry per drive with its label and pid, format() prints them after the tests line, and the outcome is the one of the default stopMs', { timeout: TEST_MS, skip: WINDOWS ? false : 'stopMs bounds taskkill, which only the Windows stop() runs; on POSIX stop() sends a signal and does not wait' }, async () => {
  let short;
  try {
    short = await drive('keys', { stopMs: 1 });
    assert.ok(Array.isArray(short.cleanup), `the result carries cleanup (it has ${JSON.stringify(short.cleanup)})`);
    const labels = ['control', `fault ${short.fault}`];
    assert.equal(short.cleanup.length, labels.length, `one entry for the control and one for the fault run: ${JSON.stringify(short.cleanup)}`);
    short.cleanup.forEach((e, i) => assert.match(e, ENTRY(labels[i]), `entry ${i} is the one of ${labels[i]}`));
    const lines = format(short).split('\n');
    const testsAt = lines.findIndex((l) => l.startsWith('its own tests:'));
    const cleanupAt = lines.map((l, i) => (l.startsWith('cleanup:') ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(cleanupAt.map((i) => lines[i]), short.cleanup.map((e) => `cleanup: ${e}`));
    assert.ok(testsAt >= 0 && cleanupAt.every((i) => i > testsAt), `the cleanup lines come after the tests line:\n${lines.join('\n')}`);
  } finally { stopLeftovers(pidsOf(short?.cleanup)); }
  // An entry does not change the outcome: the numbers were read before the stop.
  const normal = await drive('keys');
  assert.equal(short.outcome, normal.outcome, `${short.reason} | ${normal.reason}`);
  assert.deepEqual(normal.cleanup, []);
});

test('DB6.12d: on Windows, with the seeded fault reuse-process the one process is the control\'s, so every entry of stopMs 1 is labelled control', { timeout: TEST_MS, skip: WINDOWS ? false : 'stopMs bounds taskkill, which only the Windows stop() runs' }, async () => {
  let r;
  try {
    r = await drive('keys', { stopMs: 1, driverFault: 'reuse-process' });
    assert.ok(Array.isArray(r.cleanup) && r.cleanup.length >= 1, `the result carries an entry for the stop that did not finish: ${JSON.stringify(r.cleanup)}`);
    for (const e of r.cleanup) assert.match(e, ENTRY('control'));
  } finally { stopLeftovers(pidsOf(r?.cleanup)); }
});

test('DB6.12d: on POSIX stopMs is not used: stopMs 1 leaves cleanup empty', { timeout: TEST_MS, skip: WINDOWS ? 'on Windows stop() runs taskkill, which stopMs bounds (the test above)' : false }, async () => {
  const r = await drive('keys', { stopMs: 1 });
  assert.equal(r.outcome, 'O2', r.reason);
  assert.deepEqual(r.cleanup, []);
});

// ---- DB6 item 12 (g): a per-test timeout -------------------------------------------------------------------------------------

/** Runs node with the arguments and the environment given (the runner's own context removed), bounded by `ms`. */
function runNode(args, { env = {}, cwd, ms = 60_000 } = {}) {
  const childEnv = { ...process.env };
  // A nested runner that inherits NODE_TEST_CONTEXT reports to its parent instead of printing its reporter's output.
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.POLY_DRIVER_TEST_MS;
  Object.assign(childEnv, env);
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    child.on('close', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, stdout, stderr }); });
  });
}

/** The TAP block of the test of that name: its `ok` or `not ok` line and its YAML, or null. */
function tapBlock(tap, name) {
  const lines = tap.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^(not )?ok \\d+ - ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(l));
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && l === '  ...');
  return lines.slice(at, end < 0 ? undefined : end + 1).join('\n');
}

test('DB6.12g: the helper, loaded with no POLY_DRIVER_TEST_MS, exports DRIVER_TEST_MS 300000 and a test whose before and after are node:test\'s', { timeout: TEST_MS }, async () => {
  // The default is what the five files run with; nothing in this process sets the variable, and it is removed to be sure.
  delete process.env.POLY_DRIVER_TEST_MS;
  const nodeTest = await import('node:test');
  const helper = await import(HELPER_URL);
  assert.equal(helper.DRIVER_TEST_MS, 300_000);
  assert.equal(typeof helper.test, 'function');
  assert.equal(helper.test.before, nodeTest.before, 'test.before is node:test\'s');
  assert.equal(helper.test.after, nodeTest.after, 'test.after is node:test\'s');
});

test('DB6.12g: with POLY_DRIVER_TEST_MS 300, a test of the helper that does not end is reported under its own name as timed out after 300ms, a call\'s own timeout wins, and the file goes on', { timeout: TEST_MS }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-driver-test-'));
  try {
    // Each held test is kept alive by a ref'd timer of 2 s, so the child itself ends once they are over.
    writeFileSync(join(dir, 'held.test.mjs'), [
      `import { test } from ${JSON.stringify(HELPER_URL)};`,
      'const hold = () => new Promise((resolveHold) => setTimeout(resolveHold, 2000));',
      "test('a driver test that does not end', hold);",
      "test('a driver test with options of its own and no timeout', { skip: false }, hold);",
      "test('a driver test with its own timeout', { timeout: 200 }, hold);",
      "test('a driver test that ends', () => {});",
      '',
    ].join('\n'));
    const r = await runNode(['--test', '--test-reporter=tap', 'held.test.mjs'], { cwd: dir, env: { POLY_DRIVER_TEST_MS: '300' } });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.notEqual(r.code, 0, `the child exits non-zero:\n${out}`);
    const notEnded = tapBlock(r.stdout, 'a driver test that does not end');
    assert.ok(notEnded, `the test is reported under its own name:\n${out}`);
    assert.match(notEnded, /^not ok /);
    assert.match(notEnded, /test timed out after 300ms/);
    const withOptions = tapBlock(r.stdout, 'a driver test with options of its own and no timeout');
    assert.ok(withOptions, `the test with options is reported under its own name:\n${out}`);
    assert.match(withOptions, /test timed out after 300ms/, 'the default timeout sits under the options a call gives');
    const own = tapBlock(r.stdout, 'a driver test with its own timeout');
    assert.ok(own, `the test with its own timeout is reported under its own name:\n${out}`);
    assert.match(own, /test timed out after 200ms/, 'a call\'s own timeout wins');
    const ended = tapBlock(r.stdout, 'a driver test that ends');
    assert.ok(ended, `the timeout names the test and does not end the file:\n${out}`);
    assert.match(ended, /^ok /);
    assert.match(r.stdout, /^# cancelled 3$/m, 'each test that timed out is counted as cancelled');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DB6.12g: POLY_DRIVER_TEST_MS 0, -5, 1.5 or abc makes the helper throw when it is loaded, with a message that names the variable; 300 replaces the default', { timeout: TEST_MS }, async () => {
  // The child reports what the import gave as JSON. Its source does not hold the variable's name, so an echo of the source in an
  // error cannot satisfy the test.
  const probe = 'import(process.argv[1]).then((m) => console.log(JSON.stringify({ ok: true, ms: m.DRIVER_TEST_MS })), (e) => console.log(JSON.stringify({ ok: false, code: e?.code ?? null, message: String(e?.message ?? e) })));';
  const load = async (value) => {
    const r = await runNode(['--input-type=module', '-e', probe, HELPER_URL], { env: { POLY_DRIVER_TEST_MS: value } });
    const line = r.stdout.trim().split(/\r?\n/).pop();
    try { return JSON.parse(line); } catch { assert.fail(`the probe printed no result for ${value}: ${r.stdout} ${r.stderr}`); }
  };
  for (const value of ['0', '-5', '1.5', 'abc']) {
    const got = await load(value);
    assert.equal(got.ok, false, `POLY_DRIVER_TEST_MS=${value} is refused when the module is loaded (it loaded with ${got.ms})`);
    assert.notEqual(got.code, 'ERR_MODULE_NOT_FOUND', `the helper exists (POLY_DRIVER_TEST_MS=${value}): ${got.message}`);
    assert.match(got.message, /POLY_DRIVER_TEST_MS/, `the message names the variable (POLY_DRIVER_TEST_MS=${value})`);
  }
  assert.deepEqual(await load('300'), { ok: true, ms: 300 }, 'a whole number above 0 replaces the default');
});

const DRIVER_FILES = ['demo-driver.test.mjs', 'demo-driver-classify.test.mjs', 'demo-driver-confirm.test.mjs', 'demo-driver-hygiene.test.mjs', 'demo-driver-timeout.test.mjs'];

test('DB6.12g: each of the five driver test files takes test from ./fixtures/demo/driver-test.mjs and not from node:test', { timeout: TEST_MS }, () => {
  const fromHelper = /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*['"]\.\/fixtures\/demo\/driver-test\.mjs['"]/;
  const fromNodeNamed = /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*['"]node:test['"]/;
  const fromNodeDefault = /import\s+test\b[^;]*from\s*['"]node:test['"]/;
  const wrong = [];
  for (const file of DRIVER_FILES) {
    const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
    if (!fromHelper.test(source)) wrong.push(`${file}: does not import test from ./fixtures/demo/driver-test.mjs`);
    if (fromNodeNamed.test(source) || fromNodeDefault.test(source)) wrong.push(`${file}: imports test from node:test`);
  }
  assert.deepEqual(wrong, []);
});
