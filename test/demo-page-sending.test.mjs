// DF18 item 3 and 4: the room page script runs in node:vm with a fake environment,
// and handles sending with timeouts, cancellation, and error handling. DAC23.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import { startRoomServer } from '../demo/host/server.mjs';
import { createRoom } from '../demo/host/room.mjs';
import { createPersonaPool } from '../demo/host/personas.mjs';
import { createLimiter } from '../demo/host/limits.mjs';
import { createStaffFeed } from '../demo/host/staff-feed.mjs';

const secret = () => randomBytes(32).toString('hex');
const WA = () => ({ appSecret: secret(), accessToken: secret(), phoneNumberId: '106540352242922', verifyToken: secret(), apiVersion: 'v23.0' });
const clockAt = (start = 1_790_000_000_000) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };

// ---- Harness: run the page script in node:vm with fake globals ---------------------------------------------------------------

function makeHarness() {
  const state = {
    elements: {},
    elementsByType: {},
    submitHandler: null,
    fetchCalls: [],
    timerIds: 0,
    timers: new Map(),
    clearedTimerIds: new Set(),
  };

  function makeElement() {
    const handlers = {};
    return {
      textContent: '',
      value: '',
      disabled: false,
      className: '',
      children: [],
      appendChild(child) { this.children.push(child); },
      scrollIntoView() {},
      addEventListener(type, fn) {
        handlers[type] = fn;
        if (type === 'submit') {
          state.submitHandler = fn;
        }
      },
      _getHandler(type) { return handlers[type]; },
    };
  }

  // Preset all required elements to ensure addEventListener works
  state.elements.f = makeElement();
  state.elements.b = makeElement();
  state.elements.t = makeElement();
  state.elements.status = makeElement();
  state.elements.log = makeElement();
  state.elements.who = makeElement();

  const fakeDocument = {
    getElementById(id) {
      if (!state.elements[id]) {
        state.elements[id] = makeElement();
      }
      return state.elements[id];
    },
    createElement(tag) {
      const el = makeElement();
      if (!state.elementsByType[tag]) state.elementsByType[tag] = [];
      state.elementsByType[tag].push(el);
      return el;
    },
  };

  const fakeFetch = async (url, options = {}) => {
    const call = { url, options: { ...options }, statusAtCall: null, disabledAtCall: null };
    state.fetchCalls.push(call);

    // Answer /api/me immediately
    if (url === '/api/me') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ persona: { id: 'guest-01', phone: '1', display: 'x', orders: ['o-1'] } }),
      };
    }

    // For /api/say, create a deferred per call
    const deferred = {};
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });
    call.deferred = deferred;

    // If signal is present, listen for abort
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        deferred.reject({ name: 'AbortError' });
      });
    }

    return deferred.promise;
  };

  const fakeSetTimeout = (fn, delay) => {
    const id = ++state.timerIds;
    state.timers.set(id, { fn, delay });
    return id;
  };

  const fakeClearTimeout = (id) => {
    state.timers.delete(id);
    state.clearedTimerIds.add(id);
  };

  const sandbox = {
    document: fakeDocument,
    fetch: fakeFetch,
    EventSource: class { constructor(url) { this.url = url; this.onmessage = null; } },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    AbortController: AbortController,
    location: { href: 'http://localhost:8080/' },
    URLSearchParams,
    console,
    JSON,
    Math,
    Promise,
  };

  state.sandbox = sandbox;
  return { state, sandbox };
}

async function runPageScript() {
  const { state, sandbox } = makeHarness();
  const ctx = createContext(sandbox);

  const { roomPageScript } = await import('../demo/host/page.mjs');
  const code = roomPageScript();

  runInContext(code, ctx);

  return { state, sandbox };
}

function fireTimer(state, delay) {
  const timers = Array.from(state.timers.entries()).filter(([_, t]) => t.delay === delay);
  timers.forEach(([id, t]) => {
    t.fn();
    state.timers.delete(id);
  });
}

// Helper to submit a message and assert the handler exists
function submit(state, text) {
  const input = state.elements.t;
  input.value = text;
  assert.ok(state.submitHandler, 'the page registered a submit handler on #f');
  state.submitHandler({ preventDefault() {} });
}

// ---- Self-check: the harness runs a script and delivers a submit -----------------------------------------------------------

test('DF18.3: the harness runs a script and delivers a submit', async () => {
  const { state, sandbox } = makeHarness();
  const ctx = createContext(sandbox);

  // Minimal test script: registers submit handler and updates status
  const minimalScript = `
    const form = document.getElementById('f');
    const status = document.getElementById('status');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      status.textContent = 'ok';
    });
  `;

  runInContext(minimalScript, ctx);

  // Verify the harness captured the handler
  assert.ok(state.submitHandler, 'harness captured the submit handler');

  // Call the submit helper
  const input = state.elements.t;
  const status = state.elements.status;
  submit(state, 'test');

  // Verify the script ran and updated status
  assert.equal(status.textContent, 'ok', 'script executed and updated status');
});

// ---- Tests: (a) to (g) of DF18 item 3 -------------------------------------------------------------------------------------

test('DF18.3: (a) on submit, button disabled and status Sending... before request sent', async () => {
  const { state } = await runPageScript();
  await new Promise((r) => setImmediate(r));

  const button = state.elements.b;
  const status = state.elements.status;
  const input = state.elements.t;

  submit(state, 'hello');

  await new Promise((r) => setImmediate(r));

  // Check before /api/say settles: button disabled, status "Sending...", input still has text
  assert.equal(button.disabled, true, 'button is disabled');
  assert.equal(status.textContent, 'Sending...', 'status is "Sending..."');
  assert.equal(input.value, 'hello', 'input text is preserved');

  // Check: /api/say was called with POST and signal
  const sayCalls = state.fetchCalls.filter((c) => c.url === '/api/say');
  assert.equal(sayCalls.length, 1, 'one /api/say request made');
  assert.equal(sayCalls[0].options.method, 'POST', 'POST method');
  assert.ok(sayCalls[0].options.signal, 'has signal (AbortController)');
});

test('DF18.3: (b) setTimeout 10000 ms registered for /api/say request', async () => {
  const { state } = await runPageScript();
  await new Promise((r) => setImmediate(r));

  submit(state, 'hello');

  await new Promise((r) => setImmediate(r));

  // Check: setTimeout 10000 ms is registered
  const tenSecTimers = Array.from(state.timers.values()).filter((t) => t.delay === 10000);
  assert.equal(tenSecTimers.length, 1, 'one 10000ms timer registered');
});

test('DF18.3: (c) timeout fires: request aborted, status says room did not answer', async () => {
  const { state } = await runPageScript();
  await new Promise((r) => setImmediate(r));

  const button = state.elements.b;
  const status = state.elements.status;
  const input = state.elements.t;

  submit(state, 'hello');

  await new Promise((r) => setImmediate(r));

  // Capture the /api/say call and its signal
  const sayCall = state.fetchCalls.find((c) => c.url === '/api/say');
  assert.ok(sayCall, '/api/say called');
  assert.ok(sayCall.options.signal, 'signal present');

  // Fire the 10000ms timeout
  fireTimer(state, 10000);

  // Wait for abort and response handling
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  // Check: signal should be aborted, status updated, button enabled, input text preserved
  assert.equal(sayCall.options.signal.aborted, true, 'signal was aborted');
  assert.equal(status.textContent, 'The room did not answer. Close other tabs of this page, reload, and send again.', 'timeout message shown');
  assert.equal(button.disabled, false, 'button is re-enabled');
  assert.equal(input.value, 'hello', 'input text still there');
});

test('DF18.3: (d) network error gives "message could not be sent" status', async () => {
  const { state } = await runPageScript();
  await new Promise((r) => setImmediate(r));

  const button = state.elements.b;
  const status = state.elements.status;

  submit(state, 'hello');

  await new Promise((r) => setImmediate(r));

  // Get the /api/say call and make it fail with network error
  const sayCall = state.fetchCalls.find((c) => c.url === '/api/say');
  assert.ok(sayCall && sayCall.deferred, '/api/say deferred');

  sayCall.deferred.reject(new Error('network'));

  // Wait for error handling
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  // Check: status and button, and NOT the timeout message
  assert.equal(status.textContent, 'The message could not be sent.', 'error message shown');
  assert.equal(button.disabled, false, 'button is re-enabled');
  assert.ok(status.textContent !== 'The room did not answer. Close other tabs of this page, reload, and send again.', 'not the timeout message');
});

test('DF18.3: (e) ok: true clears input and status, enables button, adds message to log, clears timer', async () => {
  const { state } = await runPageScript();
  await new Promise((r) => setImmediate(r));

  const button = state.elements.b;
  const status = state.elements.status;
  const log = state.elements.log;

  submit(state, 'hello');

  await new Promise((r) => setImmediate(r));

  const sayCall = state.fetchCalls.find((c) => c.url === '/api/say');
  assert.ok(sayCall && sayCall.deferred, '/api/say deferred');

  const timerId = Array.from(state.timers.keys())[0];
  assert.ok(timerId, 'timer created');

  // Resolve with ok: true
  sayCall.deferred.resolve({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  });

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  // Check: input cleared, status cleared, button enabled
  assert.equal(state.elements.t.value, '', 'input cleared');
  assert.equal(status.textContent, '', 'status cleared');
  assert.equal(button.disabled, false, 'button enabled');

  // Check: message added to log
  assert.equal(log.children.length, 1, 'message added to log');

  // Check: timer cleared
  assert.ok(state.clearedTimerIds.has(timerId), 'timer cleared');
});

test('DF18.3: (e) reason too-fast shows retry time', async () => {
  const { state } = await runPageScript();
  await new Promise((r) => setImmediate(r));

  const button = state.elements.b;
  const status = state.elements.status;

  submit(state, 'msg1');

  await new Promise((r) => setImmediate(r));

  const sayCall = state.fetchCalls.find((c) => c.url === '/api/say');
  sayCall.deferred.resolve({
    ok: false,
    status: 429,
    json: async () => ({ ok: false, reason: 'too-fast', retryInMs: 3000 }),
  });

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(status.textContent, 'One message every 5 seconds. Try again in 3 s.', 'too-fast message shown');
  assert.equal(button.disabled, false, 'button enabled after too-fast');
});

test('DF18.3: (e) reason too-many shows limit', async () => {
  const { state } = await runPageScript();
  await new Promise((r) => setImmediate(r));

  const button = state.elements.b;
  const status = state.elements.status;

  submit(state, 'msg2');

  await new Promise((r) => setImmediate(r));

  const sayCall = state.fetchCalls.find((c) => c.url === '/api/say');
  sayCall.deferred.resolve({
    ok: false,
    status: 429,
    json: async () => ({ ok: false, reason: 'too-many' }),
  });

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(status.textContent, 'That is the 12 messages each guest may send.', 'too-many message shown');
  assert.equal(button.disabled, false, 'button enabled after too-many');
});

test('DF18.3: (e) reason too-long shows character limit', async () => {
  const { state } = await runPageScript();
  await new Promise((r) => setImmediate(r));

  const button = state.elements.b;
  const status = state.elements.status;

  submit(state, 'msg3');

  await new Promise((r) => setImmediate(r));

  const sayCall = state.fetchCalls.find((c) => c.url === '/api/say');
  sayCall.deferred.resolve({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, reason: 'too-long' }),
  });

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(status.textContent, 'At most 280 characters.', 'too-long message shown');
  assert.equal(button.disabled, false, 'button enabled after too-long');
});

test('DF18.3: (e) reason halted shows presenter stopped and stays disabled', async () => {
  const { state } = await runPageScript();
  await new Promise((r) => setImmediate(r));

  const input = state.elements.t;
  const button = state.elements.b;
  const status = state.elements.status;

  submit(state, 'msg4');

  await new Promise((r) => setImmediate(r));

  const sayCall = state.fetchCalls.find((c) => c.url === '/api/say');
  sayCall.deferred.resolve({
    ok: false,
    status: 503,
    json: async () => ({ ok: false, reason: 'halted' }),
  });

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(status.textContent, 'The presenter has stopped the room.', 'halted message shown');
  assert.equal(button.disabled, true, 'button stays disabled after halted');
  assert.equal(input.disabled, true, 'input stays disabled after halted');
});

test('DF18.3: (e) unknown reason shows generic error', async () => {
  const { state } = await runPageScript();
  await new Promise((r) => setImmediate(r));

  const button = state.elements.b;
  const status = state.elements.status;

  submit(state, 'msg5');

  await new Promise((r) => setImmediate(r));

  const sayCall = state.fetchCalls.find((c) => c.url === '/api/say');
  sayCall.deferred.resolve({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, reason: 'unknown-reason' }),
  });

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(status.textContent, 'The message could not be sent.', 'unknown reason gives generic error');
  assert.equal(button.disabled, false, 'button enabled after unknown reason');
});

test('DF18.3: (f) second submit while first is waiting makes no second fetch', async () => {
  const { state } = await runPageScript();
  await new Promise((r) => setImmediate(r));

  submit(state, 'first');

  await new Promise((r) => setImmediate(r));

  const callCountAfterFirst = state.fetchCalls.filter((c) => c.url === '/api/say').length;
  assert.equal(callCountAfterFirst, 1, 'first /api/say called');

  // Try second submit while first is waiting (don't resolve the first yet)
  submit(state, 'second');

  await new Promise((r) => setImmediate(r));

  const callCountAfterSecond = state.fetchCalls.filter((c) => c.url === '/api/say').length;
  assert.equal(callCountAfterSecond, 1, 'second submit made no additional fetch');
});

test('DF18.3: (g) empty or blank text makes no request, button stays enabled', async () => {
  const { state } = await runPageScript();
  await new Promise((r) => setImmediate(r));

  const button = state.elements.b;
  const status = state.elements.status;

  // Test: empty
  submit(state, '');

  await new Promise((r) => setImmediate(r));

  const callsAfterEmpty = state.fetchCalls.filter((c) => c.url === '/api/say').length;
  assert.equal(callsAfterEmpty, 0, 'no /api/say call for empty text');
  assert.equal(button.disabled, false, 'button still enabled');
  assert.equal(status.textContent, '', 'status not set to Sending...');

  // Test: whitespace only
  submit(state, '   ');

  await new Promise((r) => setImmediate(r));

  const callsAfterBlank = state.fetchCalls.filter((c) => c.url === '/api/say').length;
  assert.equal(callsAfterBlank, 0, 'no /api/say call for blank text');
  assert.equal(button.disabled, false, 'button still enabled');
});

// ---- B: roomPage() returns HTML string with embedded roomPageScript -------------------------------------------------------

test('DF18.3: B roomPage() HTML contains roomPageScript code and required element ids', async () => {
  const { roomPage, roomPageScript } = await import('../demo/host/page.mjs');
  const html = roomPage();

  assert.ok(typeof html === 'string', 'roomPage returns a string');
  assert.match(html, /<!DOCTYPE/i, 'HTML has doctype');

  // Check that roomPageScript code is embedded in the HTML
  const script = roomPageScript();
  assert.ok(html.includes(script), 'HTML includes roomPageScript code');

  // Check for required element ids
  const requiredIds = ['log', 'status', 't', 'b', 'f', 'who'];
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `contains id="${id}"`);
  }
});

// ---- C: real room server, six event streams, seventh POST answered quickly ------------------------------------------------

test('DF18.3: C real room server with six event streams open, seventh POST /api/say answered by host within 2 seconds', async () => {
  // Build a fake runtime
  function fakeRuntime() {
    const received = [];
    return {
      received,
      async receive(channel, w) { received.push({ channel, w }); return { status: 200, contentType: 'text/plain', body: 'ok' }; },
    };
  }

  const c = clockAt();
  const wa = WA();
  const rt = fakeRuntime();
  const pool = createPersonaPool({ size: 8 });  // At least 7 personas
  const room = createRoom({ rt, wa, now: c.now, pool, limiter: createLimiter({ now: c.now }), settle: async () => {}, });
  const feed = createStaffFeed({ now: c.now });
  const server = await startRoomServer({ room, staff: feed, presenterToken: secret() });

  try {
    const base = `http://127.0.0.1:${server.port}`;

    // Open six event streams using http.get with separate cookies
    const streams = [];
    const cookies = [];
    for (let i = 0; i < 6; i++) {
      const homeRes = await fetch(`${base}/`);
      const setCookie = homeRes.headers.get('set-cookie') ?? '';
      const cookie = setCookie.split(';')[0];
      cookies.push(cookie);
      assert.match(cookie, /^room_session=/, `stream ${i} got valid session cookie`);

      const controller = new AbortController();
      const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: controller.signal });
      assert.equal(res.status, 200, `stream ${i} got 200`);
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/, `stream ${i} is event-stream`);
      streams.push({ cookie, controller, res });
    }

    // Wait for streams to establish
    await new Promise((r) => setTimeout(r, 100));

    // POST /api/say from seventh session
    const homeRes = await fetch(`${base}/`);
    const seventhCookie = (homeRes.headers.get('set-cookie') ?? '').split(';')[0];
    assert.notEqual(seventhCookie, cookies[0], 'seventh session has different cookie');

    const startTime = Date.now();
    const sayRes = await fetch(`${base}/api/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: seventhCookie },
      body: JSON.stringify({ text: 'test message' }),
      timeout: 5000,
    });
    const duration = Date.now() - startTime;

    assert.equal(sayRes.status, 200, 'POST /api/say returns 200');
    const sayBody = await sayRes.json();
    assert.deepEqual(sayBody, { ok: true }, 'response body is { ok: true }');
    assert.ok(duration < 2000, `response received within 2 seconds (${duration}ms)`);

    // Clean up streams in finally
    streams.forEach((s) => s.controller.abort());
  } finally {
    await server.close();
  }
}, { timeout: 10000 });
