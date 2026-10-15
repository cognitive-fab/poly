// Step 9 (DF2, DF3, DF4, DF7, DAC10): the room page's host, written before it. Personas, signing, the sender mapping, the limits, the
// kill switch, the transport and the staff panel feed, on a fake runtime that records what reaches it; the real runtime is in the
// recorded run (test/after/demo-concierge-e2e.test.mjs). Nothing here leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { whatsapp } from '@poly/io';
import { createPersonaPool } from '../demo/host/personas.mjs';
import { signedWebhook } from '../demo/host/signing.mjs';
import { principalOf } from '../demo/host/verifier.mjs';
import { createLimiter } from '../demo/host/limits.mjs';
import { createRoom } from '../demo/host/room.mjs';
import { supportTransport, staffTransport } from '../demo/host/transport.mjs';
import { createStaffFeed } from '../demo/host/staff-feed.mjs';
import { startRoomServer, isLoopback } from '../demo/host/server.mjs';

const secret = () => randomBytes(32).toString('hex');
const WA = () => ({ appSecret: secret(), accessToken: secret(), phoneNumberId: '106540352242922', verifyToken: secret(), apiVersion: 'v23.0' });
const clockAt = (start = 1_790_000_000_000) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };

// ---- personas (DF3) --------------------------------------------------------------------------------------------------------

test('DF3: a session gets one synthetic persona, the same on every ask, from the reserved fiction range, with orders of its own', () => {
  const pool = createPersonaPool({ size: 3 });
  const a = pool.claim('session-a');
  assert.equal(a.id, 'guest-01');
  assert.equal(a.principal, 'cust-guest-01');
  assert.match(a.phone, /^1555555010[0-9]$/);
  assert.equal(a.display, '+1 555 555 0101');
  assert.strictEqual(pool.claim('session-a'), a, 'the same session, the same persona');
  assert.notEqual(pool.claim('session-b').id, a.id);
  assert.ok(a.orders.length >= 1 && a.orders.every((o) => o.owner === a.principal && /^o-9\d{2}\d$/.test(o.id) && /^ch_demo9\d{3}$/.test(o.charge)));
});

test('DF3: the pool is finite, a full pool refuses a new session, and a phone or principal finds its persona', () => {
  const pool = createPersonaPool({ size: 2 });
  const a = pool.claim('a');
  const b = pool.claim('b');
  assert.equal(pool.claim('c'), null);
  assert.strictEqual(pool.byPhone(b.phone), b);
  assert.strictEqual(pool.byPrincipal(a.principal), a);
  assert.equal(pool.byPhone('16505551234'), null);
});

test('DF3: no two personas share a phone, an order or a charge', () => {
  const pool = createPersonaPool({ size: 40 });
  const all = Array.from({ length: 40 }, (_, k) => pool.claim(`s${k}`));
  for (const key of ['phone']) assert.equal(new Set(all.map((p) => p[key])).size, 40);
  const orders = all.flatMap((p) => p.orders);
  assert.equal(new Set(orders.map((o) => o.id)).size, orders.length);
  assert.equal(new Set(orders.map((o) => o.charge)).size, orders.length);
});

// ---- signing and the sender mapping (DF3, DAC10) ----------------------------------------------------------------------------

test('DF3: a message is signed as the Cloud API signs, and the real whatsapp adapter verifies it and takes the sender from the signature check', () => {
  const wa = WA();
  const adapter = whatsapp(wa);
  const p = createPersonaPool({ size: 1 }).claim('s');
  const w = signedWebhook({ ...wa, persona: p, text: 'Where is my order?', id: 'wamid.ROOM.1' });
  const v = adapter.verify(w, 1_790_000_000_000);
  assert.ok(!('refused' in v), JSON.stringify(v));
  assert.equal(v.messages.length, 1);
  assert.deepEqual([v.messages[0].claims.sender, v.messages[0].body, v.messages[0].providerMessageId], [p.phone, 'Where is my order?', 'wamid.ROOM.1']);
});

test('DAC10: a forged, unsigned, re-signed or altered message is refused by the adapter and yields no message', () => {
  const wa = WA();
  const adapter = whatsapp(wa);
  const p = createPersonaPool({ size: 2 });
  const [a, b] = [p.claim('a'), p.claim('b')];
  const good = signedWebhook({ ...wa, persona: a, text: 'hello', id: 'wamid.ROOM.1' });
  const refused = (w) => 'refused' in adapter.verify(w, 1_790_000_000_000);
  assert.equal(refused(good), false, 'control: the signed message verifies');
  assert.ok(refused({ ...good, headers: {} }), 'unsigned');
  assert.ok(refused({ ...good, headers: { ...good.headers, 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` } }), 'forged signature');
  assert.ok(refused({ ...good, body: good.body.replace(a.phone, b.phone) }), 'the sender changed after signing');
  assert.ok(refused(signedWebhook({ ...wa, appSecret: secret(), persona: a, text: 'hello', id: 'wamid.ROOM.1' })), 'signed under another secret');
});

test('DF3: the sender maps to the principal cust-guest-NN, and an unknown number maps to nothing', () => {
  const pool = createPersonaPool({ size: 2 });
  const a = pool.claim('a');
  const map = principalOf(pool);
  assert.equal(map(a.phone), 'cust-guest-01');
  assert.equal(map('16505551234'), null);
  assert.equal(map(''), null);
});

// ---- the limits (DF7) -------------------------------------------------------------------------------------------------------

test('DF7: 280 characters pass, 281 do not, and an empty message is no message', () => {
  const c = clockAt();
  const l = createLimiter({ now: c.now });
  assert.deepEqual(l.check('g', 'x'.repeat(280)), { ok: true });
  assert.deepEqual(l.check('g', 'x'.repeat(281)), { ok: false, reason: 'too-long' });
  assert.deepEqual(l.check('g', '   '), { ok: false, reason: 'empty' });
});

test('DF7: one message every 5 seconds a persona, to the millisecond, and a refused message does not start the gap', () => {
  const c = clockAt();
  const l = createLimiter({ now: c.now });
  l.record('g');
  c.advance(4999);
  assert.deepEqual(l.check('g', 'again'), { ok: false, reason: 'too-fast', retryInMs: 1 });
  assert.deepEqual(l.check('other', 'hello'), { ok: true }, 'another persona is not held');
  c.advance(1);
  assert.deepEqual(l.check('g', 'again'), { ok: true });
  l.check('g', 'x'.repeat(300)); // refused, not recorded
  assert.deepEqual(l.check('g', 'again'), { ok: true }, 'a refused message started no gap');
});

test('DF7: 12 messages a persona, and the 13th is refused whatever the time', () => {
  const c = clockAt();
  const l = createLimiter({ now: c.now });
  for (let k = 0; k < 12; k++) { assert.deepEqual(l.check('g', 'hi'), { ok: true }, `message ${k + 1}`); l.record('g'); c.advance(5000); }
  c.advance(24 * 3600 * 1000);
  assert.deepEqual(l.check('g', 'hi'), { ok: false, reason: 'too-many' });
  assert.deepEqual(l.check('h', 'hi'), { ok: true });
});

// ---- the room: what reaches the runtime, the replies, the kill switch ----------------------------------------------------------

function fakeRuntime() {
  const received = [];
  return {
    received,
    async receive(channel, w) { received.push({ channel, w }); return { status: 200, contentType: 'text/plain', body: 'ok' }; },
  };
}

function newRoom(options = {}) {
  const c = clockAt();
  const wa = WA();
  const rt = options.rt ?? fakeRuntime();
  const pool = createPersonaPool({ size: 4 });
  const room = createRoom({ rt, wa, now: c.now, pool, limiter: createLimiter({ now: c.now }), settle: async () => {}, ...options.room });
  return { c, wa, rt, pool, room };
}

test('DF2, DF3: a message from a session is signed and handed to the runtime on the support channel, with the persona\'s number', async () => {
  const { wa, rt, room, pool } = newRoom();
  room.join('s1');
  const r = await room.say('s1', 'Where is order o-9011?');
  assert.deepEqual(r, { ok: true });
  assert.equal(rt.received.length, 1);
  assert.equal(rt.received[0].channel, 'support');
  const v = whatsapp(wa).verify(rt.received[0].w, 1_790_000_000_000);
  assert.deepEqual([v.messages[0].claims.sender, v.messages[0].body], [pool.claim('s1').phone, 'Where is order o-9011?']);
});

test('DF3: a session that has not joined, and a message the limits refuse, never reach the runtime', async () => {
  const { rt, room } = newRoom();
  assert.deepEqual(await room.say('stranger', 'hello'), { ok: false, reason: 'no-session' });
  room.join('s1');
  assert.deepEqual(await room.say('s1', 'x'.repeat(281)), { ok: false, reason: 'too-long' });
  assert.equal(rt.received.length, 0);
});

test('DF4: a reply goes to the room page of the persona it is for, and to no other', async () => {
  const { room, pool } = newRoom();
  room.join('s1');
  room.join('s2');
  const heard = { s1: [], s2: [] };
  room.subscribe('s1', (e) => heard.s1.push(e));
  room.subscribe('s2', (e) => heard.s2.push(e));
  room.deliver(pool.claim('s1').phone, 'Your order is on its way.');
  assert.deepEqual(heard.s1.map((e) => [e.kind, e.text]), [['reply', 'Your order is on its way.']]);
  assert.deepEqual(heard.s2, []);
  assert.deepEqual(room.history('s1').map((e) => e.text), ['Your order is on its way.']);
  room.deliver('16505551234', 'for nobody');
  assert.equal(room.history('s1').length, 1, 'a reply for no persona is dropped');
});

test('DF4: the support transport hands the Cloud API send to the room and answers as the Cloud API does; any other request has no route', async () => {
  const { room, pool } = newRoom();
  room.join('s1');
  const t = supportTransport(room);
  const to = pool.claim('s1').phone;
  const r = await t.http.request({ method: 'POST', url: 'https://graph.facebook.com/v23.0/106540352242922/messages', headers: {}, body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: 'Hello from the desk.' } }) });
  assert.equal(r.status, 200);
  assert.match(JSON.parse(r.body).messages[0].id, /^wamid\./);
  assert.deepEqual(room.history('s1').map((e) => e.text), ['Hello from the desk.']);
  await assert.rejects(t.http.request({ method: 'GET', url: 'https://example.com/', headers: {}, body: '' }), /no route/);
  await assert.rejects(t.http.request({ method: 'POST', url: 'https://api.stripe.com/v1/refunds', headers: {}, body: 'a=b' }), /no route/);
});

test('DF7: the kill switch stops the room: nothing more reaches the runtime, no reply is shown, and it cannot be undone from the page', async () => {
  let killedBy = null;
  const { rt, room, pool } = newRoom({ room: { onKill: (by) => { killedBy = by; } } });
  room.join('s1');
  assert.deepEqual(await room.say('s1', 'before'), { ok: true });
  const heard = [];
  room.subscribe('s1', (e) => heard.push(e));
  assert.equal(room.killed, false);
  room.kill('presenter');
  assert.equal(room.killed, true);
  assert.equal(killedBy, 'presenter');
  assert.deepEqual(await room.say('s1', 'after'), { ok: false, reason: 'halted' });
  assert.equal(rt.received.length, 1, 'only the message before the kill reached the runtime');
  room.deliver(pool.claim('s1').phone, 'a late reply');
  assert.deepEqual(heard.map((e) => e.kind), ['halted'], 'the page is told the room has stopped, and shows no reply');
  assert.equal(room.join('s9'), null, 'and no one joins');
  room.kill('again');
  assert.equal(killedBy, 'presenter', 'the hook runs once');
});

test('DF7: a runtime that refuses the message (a bad signature) makes the say fail without a reply', async () => {
  const rt = { async receive() { return { status: 401, contentType: 'text/plain', body: 'refused' }; } };
  const { room } = newRoom({ rt });
  room.join('s1');
  assert.deepEqual(await room.say('s1', 'hello'), { ok: false, reason: 'refused' });
});

// ---- the staff panel feed (DF2) -----------------------------------------------------------------------------------------------

test('DF2: the staff channel\'s Slack post lands on the presenter\'s feed, and nowhere else', async () => {
  const c = clockAt();
  const feed = createStaffFeed({ now: c.now });
  const heard = [];
  feed.subscribe((e) => heard.push(e.text));
  const t = staffTransport(feed);
  const r = await t.http.request({ method: 'POST', url: 'https://slack.com/api/chat.postMessage', headers: {}, body: JSON.stringify({ channel: 'C123ABC456', text: 'A refund waits (intent abc).' }) });
  assert.equal(JSON.parse(r.body).ok, true);
  assert.deepEqual(feed.entries().map((e) => e.text), ['A refund waits (intent abc).']);
  assert.deepEqual(heard, ['A refund waits (intent abc).']);
  await assert.rejects(t.http.request({ method: 'GET', url: 'https://example.com/', headers: {}, body: '' }), /no route/);
});

// ---- the server (DF2, DF7) ----------------------------------------------------------------------------------------------------

async function withServer(fn, options = {}) {
  const ctx = newRoom(options);
  const feed = createStaffFeed({ now: ctx.c.now });
  const presenterToken = secret();
  const server = await startRoomServer({ room: ctx.room, staff: feed, presenterToken });
  try { return await fn({ ...ctx, feed, presenterToken, base: `http://127.0.0.1:${server.port}` }); } finally { await server.close(); }
}

const cookieOf = (res) => (res.headers.get('set-cookie') ?? '').split(';')[0];

test('DF2: the page labels the mock-up of Stripe, says everything typed is shown on screen, and asks for no personal data', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /mock-up of Stripe/i);
    assert.match(html, /everything you type is shown on screen/i);
    assert.match(html, /no real personal data/i);
    assert.match(cookieOf(res), /^room_session=[0-9a-f]{32}$/);
    assert.match(res.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(res.headers.get('set-cookie'), /SameSite=Strict/i);
  });
});

test('DF3, DF7: a visitor gets a persona, says a message through the page, and is held by the limits', async () => {
  await withServer(async ({ base, rt, c }) => {
    const home = await fetch(`${base}/`);
    const cookie = cookieOf(home);
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    assert.equal(me.persona.id, 'guest-01');
    assert.match(me.persona.display, /^\+1 555 555 01\d\d$/);
    const say = (text) => fetch(`${base}/api/say`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    assert.deepEqual(await (await say('Where is my order?')).json(), { ok: true });
    const fast = await say('Hello?');
    assert.equal(fast.status, 429);
    assert.equal((await fast.json()).reason, 'too-fast');
    c.advance(5000);
    assert.deepEqual(await (await say('Hello?')).json(), { ok: true });
    assert.equal(rt.received.length, 2);
    assert.equal((await say('x'.repeat(281))).status, 400);
    assert.equal((await fetch(`${base}/api/say`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'no cookie' }) })).status, 401);
  });
});

test('DF2: a reply is pushed to the visitor\'s page as a server-sent event, and only to the visitor it is for', async () => {
  await withServer(async ({ base, room }) => {
    const [ca, cb] = [cookieOf(await fetch(`${base}/`)), cookieOf(await fetch(`${base}/`))];
    const open = async (cookie) => {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: ac.signal });
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const seen = [];
      (async () => { const reader = res.body.getReader(); const dec = new TextDecoder(); for (;;) { const { value, done } = await reader.read().catch(() => ({ done: true })); if (done) return; seen.push(dec.decode(value)); } })();
      return { seen, close: () => ac.abort() };
    };
    const a = await open(ca);
    const b = await open(cb);
    await new Promise((r) => setTimeout(r, 100));
    const phoneA = (await (await fetch(`${base}/api/me`, { headers: { cookie: ca } })).json()).persona.phone;
    room.deliver(phoneA, 'Only for guest one.');
    await new Promise((r) => setTimeout(r, 100));
    assert.match(a.seen.join(''), /Only for guest one\./);
    assert.ok(!b.seen.join('').includes('Only for guest one.'));
    a.close();
    b.close();
  });
});

test('DF7: the kill switch is the presenter\'s: it needs the token, stops the room for every visitor, and the page cannot undo it', async () => {
  await withServer(async ({ base, rt, room, presenterToken }) => {
    const cookie = cookieOf(await fetch(`${base}/`));
    const say = (text) => fetch(`${base}/api/say`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    assert.equal((await fetch(`${base}/presenter/kill`, { method: 'POST' })).status, 403, 'no token');
    assert.equal((await fetch(`${base}/presenter/kill`, { method: 'POST', headers: { 'x-presenter-token': 'wrong' } })).status, 403, 'wrong token');
    assert.equal(room.killed, false);
    assert.equal((await say('before')).status, 200);
    assert.equal((await fetch(`${base}/presenter/kill`, { method: 'POST', headers: { 'x-presenter-token': presenterToken } })).status, 200);
    assert.equal(room.killed, true);
    const after = await say('after');
    assert.equal(after.status, 503);
    assert.equal((await after.json()).reason, 'halted');
    assert.equal(rt.received.length, 1);
    assert.equal((await fetch(`${base}/api/kill`, { method: 'POST' })).status, 404, 'no kill route on the participants\' side');
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } }).then((r) => r.json())).killed, true);
  });
});

test('DF7: the presenter\'s staff panel needs the token and shows the feed', async () => {
  await withServer(async ({ base, feed, presenterToken }) => {
    assert.equal((await fetch(`${base}/presenter/staff`)).status, 403);
    const page = await fetch(`${base}/presenter/staff`, { headers: { 'x-presenter-token': presenterToken } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /staff/i);
    feed.post('A refund waits (intent abc).');
    const list = await (await fetch(`${base}/presenter/staff/entries`, { headers: { 'x-presenter-token': presenterToken } })).json();
    assert.deepEqual(list.entries.map((e) => e.text), ['A refund waits (intent abc).']);
    assert.equal((await fetch(`${base}/presenter/staff/entries`)).status, 403);
  });
});

test('DF7: a body over 2 KB, a bad JSON body and an unknown path are refused', async () => {
  await withServer(async ({ base }) => {
    const cookie = cookieOf(await fetch(`${base}/`));
    const post = (body) => fetch(`${base}/api/say`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body });
    assert.equal((await post(JSON.stringify({ text: 'a'.repeat(5000) }))).status, 413);
    assert.equal((await post('{not json')).status, 400);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

test('DF7: the presenter routes answer only to the loopback', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(a), true, a);
  for (const a of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', undefined, '']) assert.equal(isLoopback(a), false, String(a));
});
