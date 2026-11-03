// DF28, DAC32: the recorded room says what it answers, and the page says when the concierge sent nothing. Fast cases of DF28 item 6,
// written from the spec before the code (rule 7a). The heavy case is in test/after/demo-room-answers.test.mjs.
// The new exports are imported inside each test, so that a missing export fails its own tests and not the file: the cases DF28 says
// are unchanged (the route-exhausted line, an other error) must pass before the code exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createRoom } from '../demo/host/room.mjs';
import { createPersonaPool } from '../demo/host/personas.mjs';
import { createLimiter } from '../demo/host/limits.mjs';
import { createStaffFeed } from '../demo/host/staff-feed.mjs';
import { startRoomServer } from '../demo/host/server.mjs';
import { describeFailure } from '../demo/host/failures.mjs';
import { roomPage, roomPageScript } from '../demo/host/page.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'concierge', 'answers.json'), 'utf8'));

// The texts DF28 fixes, written out here so that a test compares against the spec and not against the code's own constants.
const UNANSWERED_TEXT = 'The concierge did not answer this message.';
const RECORDED_ONLY_TEXT = 'This room answers only its recorded messages.';
const NOTE_SOME = 'This room answers only its recorded messages. Pick one to put it in the box, then send it.';
const NOTE_NONE = 'This room answers only its recorded messages, and this guest has none.';

const secret = () => randomBytes(32).toString('hex');
const WA = () => ({ appSecret: secret(), accessToken: secret(), phoneNumberId: '106540352242922', verifyToken: secret(), apiVersion: 'v23.0' });
const clockAt = (start = 1_790_000_000_000) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };
const tick = () => new Promise((r) => setImmediate(r));
const ticks = async (n = 5) => { for (let k = 0; k < n; k++) await tick(); };

function fakeRuntime() {
  return { async receive() { return { status: 200, contentType: 'text/plain', body: 'ok' }; } };
}

// A local messagesOf, so that the room and server tests fail on the room and the server, not on recordedMessagesOf.
const MESSAGES = { 1: ['first of guest 1', 'second of guest 1'], 2: ['only of guest 2'] };
const spyMessagesOf = () => {
  const calls = [];
  const fn = (persona) => { calls.push(persona); return MESSAGES[persona.n] ?? []; };
  return { fn, calls };
};

function newRoom(roomOptions = {}) {
  const c = clockAt();
  const pool = createPersonaPool({ size: 4 });
  const replies = [];
  const room = createRoom({ rt: fakeRuntime(), wa: WA(), now: c.now, pool, limiter: createLimiter({ now: c.now }), settle: async () => {}, onReply: (x) => replies.push(x), ...roomOptions });
  return { c, pool, room, replies };
}

// ---- DF28 item 2: recordedMessagesOf over the real fixture ---------------------------------------------------------------------

test('DF28 item 2: recordedMessagesOf gives guests 1 to 4 five, three, one and no texts of the fixture, in its order', async () => {
  const { recordedMessagesOf } = await import('../demo/host/recorded-orders.mjs');
  assert.equal(typeof recordedMessagesOf, 'function', 'recorded-orders.mjs exports recordedMessagesOf');
  const messagesOf = recordedMessagesOf(FIXTURE);
  const of = (from) => FIXTURE.messages.filter((m) => m.from === from).map((m) => m.text);
  assert.deepEqual(messagesOf({ n: 1 }), of('wa-1'));
  assert.deepEqual(messagesOf({ n: 2 }), of('wa-2'));
  assert.deepEqual(messagesOf({ n: 3 }), of('wa-3'));
  assert.deepEqual(messagesOf({ n: 4 }), []);
  assert.deepEqual([1, 2, 3, 4].map((n) => messagesOf({ n }).length), [5, 3, 1, 0], 'the counts the runbook step 2.5 assigns');
  // The first text of guest 1 is the recorded status question of item 1.
  assert.equal(messagesOf({ n: 1 })[0], 'Hi, where is my order 1002? It was due on Monday.');
});

// ---- DF28 item 2: room.recorded and room.suggestions ---------------------------------------------------------------------------

test('DF28 item 2: a room given messagesOf is recorded, and its suggestions are the texts messagesOf gives the session\'s persona', () => {
  const spy = spyMessagesOf();
  const { room } = newRoom({ messagesOf: spy.fn });
  assert.equal(room.recorded, true);
  const p1 = room.join('s1');
  const p2 = room.join('s2');
  assert.deepEqual(room.suggestions('s1'), MESSAGES[1]);
  assert.deepEqual(room.suggestions('s2'), MESSAGES[2]);
  assert.ok(spy.calls.some((p) => p && p.id === p1.id && p.n === 1), 'messagesOf is called with the persona of s1');
  assert.ok(spy.calls.some((p) => p && p.id === p2.id && p.n === 2), 'messagesOf is called with the persona of s2');
});

test('DF28 item 2: room.suggestions returns a new array each time', () => {
  // One array held by messagesOf, so that a room that hands it back without a copy is caught.
  const fixed = ['a', 'b'];
  const { room } = newRoom({ messagesOf: () => fixed });
  room.join('s1');
  const first = room.suggestions('s1');
  assert.notEqual(first, fixed, 'not the array messagesOf gave');
  first.push('changed');
  first[0] = 'changed';
  assert.deepEqual(fixed, ['a', 'b'], 'changing the returned array changes nothing messagesOf holds');
  assert.deepEqual(room.suggestions('s1'), ['a', 'b'], 'changing the returned array changes nothing in the room');
  assert.notEqual(room.suggestions('s1'), room.suggestions('s1'));
});

test('DF28 item 2: room.suggestions is [] for a session with no persona', () => {
  const { room } = newRoom({ messagesOf: () => ['a'] });
  assert.deepEqual(room.suggestions('never-joined'), []);
});

test('DF28 item 2: a room with no messagesOf is not recorded and suggests nothing', () => {
  const { room } = newRoom();
  assert.equal(room.recorded, false);
  room.join('s1');
  assert.deepEqual(room.suggestions('s1'), []);
  const { room: explicit } = newRoom({ messagesOf: null });
  assert.equal(explicit.recorded, false, 'messagesOf is null by default, and null is not recorded');
  explicit.join('s1');
  assert.deepEqual(explicit.suggestions('s1'), []);
});

// ---- DF28 item 4: room.unanswered --------------------------------------------------------------------------------------------

test('DF28 item 4: room.mjs exports UNANSWERED and RECORDED_ONLY with the texts of the spec', async () => {
  const mod = await import('../demo/host/room.mjs');
  assert.equal(mod.UNANSWERED, UNANSWERED_TEXT);
  assert.equal(mod.RECORDED_ONLY, RECORDED_ONLY_TEXT);
});

test('DF28 item 4: in a room that is not recorded, room.unanswered puts the notice in the guest\'s history and on that guest\'s page alone', () => {
  const { c, pool, room, replies } = newRoom();
  room.join('s1');
  room.join('s2');
  const heard = { s1: [], s2: [] };
  room.subscribe('s1', (e) => heard.s1.push(e));
  room.subscribe('s2', (e) => heard.s2.push(e));
  assert.equal(typeof room.unanswered, 'function', 'the room has unanswered');
  const at = c.now();
  assert.equal(room.unanswered(pool.claim('s1').phone), true);
  assert.deepEqual(room.history('s1'), [{ kind: 'notice', text: UNANSWERED_TEXT, at }]);
  assert.deepEqual(heard.s1, [{ kind: 'notice', text: UNANSWERED_TEXT, at }]);
  assert.deepEqual(heard.s2, [], 'another guest hears nothing');
  assert.deepEqual(room.history('s2'), []);
  assert.deepEqual(replies, [], 'no reply was delivered, so onReply is not called');
});

test('DF28 item 4: in a recorded room, the notice says the room answers only its recorded messages', () => {
  const { c, pool, room, replies } = newRoom({ messagesOf: () => ['a'] });
  room.join('s1');
  const heard = [];
  room.subscribe('s1', (e) => heard.push(e));
  const at = c.now();
  assert.equal(room.unanswered(pool.claim('s1').phone), true);
  const text = `${UNANSWERED_TEXT} ${RECORDED_ONLY_TEXT}`;
  assert.equal(text, 'The concierge did not answer this message. This room answers only its recorded messages.');
  assert.deepEqual(room.history('s1'), [{ kind: 'notice', text, at }]);
  assert.deepEqual(heard, [{ kind: 'notice', text, at }]);
  assert.deepEqual(replies, []);
});

test('DF28 item 4: the notice follows the replies already in the history', () => {
  const { pool, room } = newRoom();
  room.join('s1');
  const phone = pool.claim('s1').phone;
  room.deliver(phone, 'A reply.');
  room.unanswered(phone);
  assert.deepEqual(room.history('s1').map((e) => [e.kind, e.text]), [['reply', 'A reply.'], ['notice', UNANSWERED_TEXT]]);
});

test('DF28 item 4: room.unanswered is false and emits nothing for a phone of no guest', () => {
  const { room, replies } = newRoom();
  room.join('s1');
  const heard = [];
  room.subscribe('s1', (e) => heard.push(e));
  assert.equal(room.unanswered('16505551234'), false);
  assert.deepEqual(heard, []);
  assert.deepEqual(room.history('s1'), []);
  assert.deepEqual(replies, []);
});

test('DF28 item 4: after kill, room.unanswered is false and emits no notice', () => {
  const { pool, room, replies } = newRoom({ messagesOf: () => ['a'] });
  room.join('s1');
  const phone = pool.claim('s1').phone;
  const heard = [];
  room.subscribe('s1', (e) => heard.push(e));
  room.kill('presenter');
  assert.equal(room.unanswered(phone), false);
  assert.deepEqual(heard.filter((e) => e.kind === 'notice'), [], 'the kill emits halted, and no notice follows');
  assert.deepEqual(room.history('s1'), []);
  assert.deepEqual(replies, []);
});

// ---- DF28 item 2: GET /api/me ------------------------------------------------------------------------------------------------

async function withServer(roomOptions, fn) {
  const ctx = newRoom(roomOptions);
  const server = await startRoomServer({ room: ctx.room, staff: createStaffFeed({ now: ctx.c.now }), presenterToken: secret() });
  try { return await fn({ ...ctx, base: `http://127.0.0.1:${server.port}` }); } finally { await server.close(); }
}
const cookieOf = (res) => (res.headers.get('set-cookie') ?? '').split(';')[0];
const me = async (base, cookie) => (await fetch(`${base}/api/me`, { headers: { cookie } })).json();

test('DF28 item 2: /api/me in a recorded room says recorded and gives each guest that guest\'s suggestions', async () => {
  const spy = spyMessagesOf();
  await withServer({ messagesOf: spy.fn }, async ({ base }) => {
    const c1 = cookieOf(await fetch(`${base}/`));
    const c2 = cookieOf(await fetch(`${base}/`));
    const a = await me(base, c1);
    const b = await me(base, c2);
    assert.equal(a.persona.id, 'guest-01');
    assert.equal(a.recorded, true);
    assert.deepEqual(a.suggestions, MESSAGES[1]);
    assert.equal(b.persona.id, 'guest-02');
    assert.equal(b.recorded, true);
    assert.deepEqual(b.suggestions, MESSAGES[2]);
  });
});

test('DF28 item 2: /api/me in a room that is not recorded says recorded false and gives no suggestions', async () => {
  await withServer({}, async ({ base }) => {
    const c1 = cookieOf(await fetch(`${base}/`));
    const a = await me(base, c1);
    assert.equal(a.persona.id, 'guest-01');
    assert.equal(a.recorded, false);
    assert.deepEqual(a.suggestions, []);
  });
});

// ---- DF28 items 2 and 4: the page --------------------------------------------------------------------------------------------

test('DF28 items 2 and 4: the page holds an empty #recorded note and an empty #suggestions between the log and the form, and styles li.notice muted and italic', () => {
  const html = roomPage();
  const log = html.indexOf('<ul id="log"');
  const note = html.indexOf('<p id="recorded" class="note"></p>');
  const suggestions = html.indexOf('<div id="suggestions"></div>');
  const form = html.indexOf('<form id="f"');
  assert.ok(note > 0, 'the page holds <p id="recorded" class="note"></p>');
  assert.ok(suggestions > 0, 'the page holds <div id="suggestions"></div>');
  assert.ok(log < note && note < form, '#recorded is between the log and the form');
  assert.ok(log < suggestions && suggestions < form, '#suggestions is between the log and the form');
  const rule = /#log li\.notice\s*\{([^}]*)\}/.exec(html);
  assert.ok(rule, 'the style has a rule for #log li.notice');
  assert.match(rule[1], /color:\s*var\(--muted\)/, 'the muted colour');
  assert.match(rule[1], /font-style:\s*italic/, 'italic type');
});

// A fake document wide enough for any plain way of writing item 2's script: listeners or on-properties, appendChild or append,
// direct listeners on each button or one delegated listener on #suggestions.
function makeHarness(meBody) {
  const state = { elements: {}, created: [], eventSources: [], fetchCalls: [], submitHandler: null };
  function makeElement(tag) {
    const listeners = {};
    const el = {
      tagName: String(tag).toUpperCase(),
      textContent: '',
      value: '',
      disabled: false,
      className: '',
      type: '',
      children: [],
      parentNode: null,
      focused: 0,
      onclick: null,
      dataset: {},
      classList: {
        add(...names) { const have = el.className.split(/\s+/).filter(Boolean); for (const n of names) if (!have.includes(n)) have.push(n); el.className = have.join(' '); },
        remove(...names) { el.className = el.className.split(/\s+/).filter((c) => c && !names.includes(c)).join(' '); },
        contains(name) { return el.className.split(/\s+/).includes(name); },
      },
      appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
      append(...kids) { for (const k of kids) { if (typeof k === 'string') el.textContent += k; else el.appendChild(k); } },
      replaceChildren(...kids) { el.children = []; el.append(...kids); },
      setAttribute(name, value) { if (name === 'class') el.className = String(value); else el[name] = String(value); },
      getAttribute(name) { return name === 'class' ? el.className : (el[name] ?? null); },
      // Enough of a selector for a delegated listener: a tag name, classes as .name, or both (button.suggestion).
      matches(selector) {
        const [tag, ...classes] = selector.split('.');
        return (tag === '' || el.tagName === tag.toUpperCase()) && classes.every((c) => el.classList.contains(c));
      },
      closest(selector) { for (let node = el; node; node = node.parentNode) if (node.matches?.(selector)) return node; return null; },
      scrollIntoView() {},
      focus() { el.focused += 1; },
      addEventListener(type, fn) {
        (listeners[type] ??= []).push(fn);
        if (type === 'submit') state.submitHandler = fn;
      },
      _listeners: (type) => listeners[type] ?? [],
    };
    return el;
  }
  for (const id of ['f', 'b', 't', 'status', 'log', 'who', 'recorded', 'suggestions']) state.elements[id] = makeElement(id === 'log' ? 'ul' : id === 'recorded' ? 'p' : id === 'suggestions' ? 'div' : id === 't' ? 'input' : id === 'b' ? 'button' : id === 'f' ? 'form' : 'span');
  const document = {
    getElementById(id) { return (state.elements[id] ??= makeElement('div')); },
    createElement(tag) { const el = makeElement(tag); state.created.push(el); return el; },
  };
  const fetch = async (url, options = {}) => {
    state.fetchCalls.push({ url, options });
    if (url === '/api/me') return { ok: true, status: 200, json: async () => meBody };
    return new Promise(() => {}); // DF28: a click sends nothing, so no other request is answered here
  };
  class EventSource {
    constructor(url) { this.url = url; this.onmessage = null; this.listeners = []; state.eventSources.push(this); }
    addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
  }
  const sandbox = { document, fetch, EventSource, setTimeout, clearTimeout, AbortController, URLSearchParams, console, JSON, Math, Promise };
  return { state, sandbox };
}

async function runPage(meBody) {
  const { state, sandbox } = makeHarness(meBody);
  runInContext(roomPageScript(), createContext(sandbox));
  await ticks();
  // The harness's own check: the answer of /api/me reached the script, so a page that shows nothing has read it.
  assert.match(state.elements.who.textContent, /guest-01/, 'harness: the script read /api/me');
  return state;
}

// A click, as a browser gives it: the button's own listeners and onclick, then the listeners of its ancestors (delegation).
function click(el) {
  const event = { type: 'click', target: el, preventDefault() {}, stopPropagation() {} };
  for (let node = el; node; node = node.parentNode) {
    const e = { ...event, currentTarget: node };
    for (const fn of node._listeners('click')) fn(e);
    if (node === el && typeof node.onclick === 'function') node.onclick(e);
  }
}

function deliver(state, ev) {
  const data = JSON.stringify(ev);
  for (const es of state.eventSources) {
    if (typeof es.onmessage === 'function') es.onmessage({ data });
    for (const fn of es.listeners) fn({ data });
  }
}

const PERSONA = { id: 'guest-01', phone: '15555550101', display: '+1 555 555 0101', orders: ['o-1'] };

test('DF28 item 2: a recorded page with suggestions says to pick one, and shows one button a text, in order', async () => {
  const texts = ['Hi, where is my order 1002? It was due on Monday.', 'The lamp arrived broken. Please refund 40 euros.', 'Please refund part of the order.'];
  const state = await runPage({ persona: PERSONA, killed: false, recorded: true, suggestions: texts });
  assert.equal(state.elements.recorded.textContent, NOTE_SOME);
  const buttons = state.elements.suggestions.children;
  assert.equal(buttons.length, texts.length, 'one button a text');
  assert.deepEqual(buttons.map((b) => b.textContent), texts, 'in the order of suggestions');
  for (const b of buttons) {
    assert.equal(b.tagName, 'BUTTON');
    assert.equal(b.type, 'button', 'type button, so that it does not submit the form');
    assert.equal(b.className, 'suggestion');
  }
});

test('DF28 item 2: a recorded page with no suggestions says this guest has none, and shows no button', async () => {
  const state = await runPage({ persona: PERSONA, killed: false, recorded: true, suggestions: [] });
  assert.equal(state.elements.recorded.textContent, NOTE_NONE);
  assert.equal(state.elements.suggestions.children.length, 0);
});

test('DF28 item 2: a click on a suggestion puts its text in the box and focuses it, and sends nothing', async () => {
  const texts = ['first text', 'second text'];
  const state = await runPage({ persona: PERSONA, killed: false, recorded: true, suggestions: texts });
  const input = state.elements.t;
  input.value = 'something typed before';
  const buttons = state.elements.suggestions.children;
  assert.equal(buttons.length, 2, 'two buttons');
  const before = state.fetchCalls.length;
  click(buttons[1]);
  await ticks();
  assert.equal(input.value, 'second text');
  assert.ok(input.focused >= 1, 'the input is focused');
  assert.equal(state.fetchCalls.length, before, 'no fetch');
  assert.ok(!state.fetchCalls.some((c) => c.url === '/api/say'), 'nothing is sent to /api/say');
  click(buttons[0]);
  await ticks();
  assert.equal(input.value, 'first text');
  assert.equal(state.fetchCalls.length, before, 'still no fetch');
});

test('DF28 item 2: a page that is not recorded shows no note and no button, with recorded false or absent', async () => {
  for (const body of [{ persona: PERSONA, killed: false, recorded: false, suggestions: [] }, { persona: PERSONA, killed: false }]) {
    const state = await runPage(body);
    assert.equal(state.elements.recorded.textContent, '', JSON.stringify(body));
    assert.equal(state.elements.suggestions.children.length, 0, JSON.stringify(body));
  }
});

test('DF28 item 4: a notice event is a li.notice of the log with its text', async () => {
  const state = await runPage({ persona: PERSONA, killed: false, recorded: true, suggestions: [] });
  const text = `${UNANSWERED_TEXT} ${RECORDED_ONLY_TEXT}`;
  deliver(state, { kind: 'notice', text, at: 1_790_000_000_000 });
  await ticks();
  const items = state.elements.log.children;
  assert.equal(items.length, 1, 'one line in the log');
  assert.equal(items[0].tagName, 'LI');
  assert.equal(items[0].className, 'notice');
  assert.equal(items[0].textContent, text);
});

// ---- DF28 item 3: the reasons of the terminal --------------------------------------------------------------------------------

const ROUTES = { routes: [{ kind: 'route.triage.call', decision: 'classify', tiers: ['small', 'large'] }], secrets: [] };

test('DF28 item 3: the four lines of item 1 say every tier failed for the route, and no recorded answer for each call', () => {
  assert.equal(describeFailure({ kind: 'decision.classify', attempts: 1, last_error: 'permanent: route-exhausted', payload: {} }, ROUTES), 'decision failed: classify, tier none, every tier failed');
  assert.equal(describeFailure({ kind: 'route.triage.call', attempts: 1, last_error: 'no recorded answer for this message', payload: { tier: 0 } }, ROUTES), 'decision failed: classify, tier small, no recorded answer');
  assert.equal(describeFailure({ kind: 'route.triage.call', attempts: 1, last_error: 'no recorded answer for this message', payload: { tier: 1 } }, ROUTES), 'decision failed: classify, tier large, no recorded answer');
  assert.equal(describeFailure({ kind: 'decision.reply', attempts: 1, last_error: 'no recorded answer for this message', payload: {} }, ROUTES), 'decision failed: reply, tier none, no recorded answer');
});

test('DF28 item 3: each error of the recorded providers is the fixed reason no recorded answer, without the message id', () => {
  const cases = [
    ['decision.classify', 'no recorded answer for this message'],
    ['decision.classify', 'no recorded classify answer for refund-small'],
    ['decision.amount', 'no recorded amount for vague-amount'],
    ['decision.reply', 'no recorded Unsure reply for unsure'],
    ['decision.answer', 'no recorded answer for refund-twice'],
  ];
  for (const [kind, last_error] of cases) {
    const decision = kind.slice('decision.'.length);
    assert.equal(describeFailure({ kind, attempts: 1, last_error, payload: {} }, ROUTES), `decision failed: ${decision}, tier none, no recorded answer`, last_error);
  }
});

test('DF28 item 3: an uncited answer is the reason cited no order', () => {
  const row = { kind: 'decision.answer', attempts: 1, last_error: 'permanent: uncited: the answer cites nothing, and a citation is required (PS17.6)', payload: {} };
  assert.equal(describeFailure(row, ROUTES), 'decision failed: answer, tier none, cited no order');
});

test('DF28 item 3: the two entries sit right after route-exhausted and before the others', () => {
  // Right after route-exhausted: a route's decision still says every tier failed, whatever else its error holds.
  assert.equal(describeFailure({ kind: 'decision.classify', attempts: 1, last_error: 'permanent: route-exhausted (uncited: x)', payload: {} }, ROUTES), 'decision failed: classify, tier none, every tier failed');
  // Before the later entries: an error that begins with no recorded, or holds uncited:, is one of the two whatever follows.
  assert.equal(describeFailure({ kind: 'decision.reply', attempts: 1, last_error: 'no recorded answer for this message (HTTP 404)', payload: {} }, ROUTES), 'decision failed: reply, tier none, no recorded answer');
  assert.equal(describeFailure({ kind: 'decision.answer', attempts: 1, last_error: 'permanent: uncited: timed out after 800ms', payload: {} }, ROUTES), 'decision failed: answer, tier none, cited no order');
});

test('DF28 item 3: the route-exhausted line is unchanged, and any other error still says not recognised', () => {
  assert.equal(describeFailure({ kind: 'decision.classify', attempts: 1, last_error: 'permanent: route-exhausted', payload: {} }, ROUTES), 'decision failed: classify, tier none, every tier failed');
  assert.equal(describeFailure({ kind: 'decision.reply', attempts: 1, last_error: 'something else went wrong', payload: {} }, ROUTES), 'decision failed: reply, tier none, not recognised');
  // The entry is for an error that begins with no recorded; one that only holds the words is another error.
  assert.equal(describeFailure({ kind: 'decision.reply', attempts: 1, last_error: 'the store said: no recorded answer', payload: {} }, ROUTES), 'decision failed: reply, tier none, not recognised');
});

// ---- DF28 item 4: watchUnanswered -------------------------------------------------------------------------------------------

function outbox() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE pr_outbox (intent_id TEXT, instance_id TEXT, kind TEXT, status TEXT)');
  const insert = db.prepare('INSERT INTO pr_outbox (intent_id, instance_id, kind, status) VALUES (?, ?, ?, ?)');
  return { db, add: (intent, instance, kind, status) => insert.run(intent, instance, kind, status) };
}

// The watcher is made before any row is written, and a few turns are let pass, so that the tests hold whether or not it polls
// once on its own when made (DF28 does not say).
async function watcher(db, deskList) {
  const { watchUnanswered } = await import('../demo/host/unanswered.mjs');
  const reported = [];
  const w = watchUnanswered({ db, desks: async () => deskList.map((d) => ({ ...d })), onUnanswered: (phone) => reported.push(phone), everyMs: 1e9 });
  assert.equal(typeof w.poll, 'function');
  assert.equal(typeof w.stop, 'function');
  await ticks();
  return { w, reported };
}
const sorted = (xs) => [...xs].sort();

test('DF28 item 4: watchUnanswered reports each dead answer, reply and ack of a desk once, with the desk\'s phone', async () => {
  const { db, add } = outbox();
  const desks = [{ instance: 'desk-1', phone: '15555550101' }, { instance: 'desk-2', phone: '15555550102' }];
  const { w, reported } = await watcher(db, desks);
  try {
    add('i-answer', 'desk-1', 'decision.answer', 'dead');
    add('i-reply', 'desk-1', 'decision.reply', 'dead');
    add('i-ack', 'desk-2', 'decision.ack', 'dead');
    await w.poll();
    assert.deepEqual(sorted(reported), sorted(['15555550101', '15555550101', '15555550102']));
  } finally { w.stop(); }
});

test('DF28 item 4: a done row, a dead classify, a dead amount and a dead row of another instance are not reported', async () => {
  const { db, add } = outbox();
  const { w, reported } = await watcher(db, [{ instance: 'desk-1', phone: '15555550101' }]);
  try {
    add('i-done', 'desk-1', 'decision.reply', 'done');
    add('i-classify', 'desk-1', 'decision.classify', 'dead');
    add('i-amount', 'desk-1', 'decision.amount', 'dead');
    add('i-other', 'someone-else', 'decision.reply', 'dead');
    await w.poll();
    assert.deepEqual(reported, []);
  } finally { w.stop(); }
});

test('DF28 item 4: a second poll reports nothing new, and a row added later is reported on the next poll', async () => {
  const { db, add } = outbox();
  const { w, reported } = await watcher(db, [{ instance: 'desk-1', phone: '15555550101' }]);
  try {
    add('i-1', 'desk-1', 'decision.reply', 'dead');
    await w.poll();
    assert.deepEqual(reported, ['15555550101']);
    await w.poll();
    assert.deepEqual(reported, ['15555550101'], 'the same intent is not reported again');
    add('i-2', 'desk-1', 'decision.answer', 'dead');
    await w.poll();
    assert.deepEqual(reported, ['15555550101', '15555550101'], 'the later row is reported once');
  } finally { w.stop(); }
});

test('DF28 item 4: an intent seen when it matched no desk is not reported when its instance becomes a desk', async () => {
  const { db, add } = outbox();
  const desks = [{ instance: 'desk-1', phone: '15555550101' }];
  const { w, reported } = await watcher(db, desks);
  try {
    add('i-early', 'desk-2', 'decision.reply', 'dead');
    await w.poll();
    assert.deepEqual(reported, []);
    desks.push({ instance: 'desk-2', phone: '15555550102' });
    await w.poll();
    assert.deepEqual(reported, [], 'an intent already seen is never reported again');
  } finally { w.stop(); }
});

test('DF28 item 4: a row whose status turns dead after a poll that saw nothing of it is reported on the next poll', async () => {
  const { db, add } = outbox();
  const { w, reported } = await watcher(db, [{ instance: 'desk-1', phone: '15555550101' }]);
  try {
    add('i-pending', 'desk-1', 'decision.reply', 'pending');
    await w.poll();
    assert.deepEqual(reported, [], 'a row that is not dead is not reported');
    db.prepare('UPDATE pr_outbox SET status = ? WHERE intent_id = ?').run('dead', 'i-pending');
    await w.poll();
    assert.deepEqual(reported, ['15555550101']);
  } finally { w.stop(); }
});

test('DF28 item 4: the timer polls every everyMs until stop', async () => {
  const { watchUnanswered } = await import('../demo/host/unanswered.mjs');
  const { db, add } = outbox();
  const reported = [];
  const w = watchUnanswered({ db, desks: async () => [{ instance: 'desk-1', phone: '15555550101' }], onUnanswered: (phone) => reported.push(phone), everyMs: 20 });
  let stopped = false;
  try {
    add('i-1', 'desk-1', 'decision.reply', 'dead');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(reported, ['15555550101'], 'reported by the timer, with no call of poll');
    w.stop();
    stopped = true;
    await new Promise((r) => setTimeout(r, 60)); // a pass already started when stop was called may end
    const count = reported.length;
    add('i-2', 'desk-1', 'decision.answer', 'dead');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(reported.length, count, 'nothing is reported after stop');
  } finally { if (!stopped) w.stop(); }
});
