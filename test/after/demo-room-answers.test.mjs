// DF11.5, DAC16: the room delivers replies to the page. Stub mode and recorded mode assemble the demo,
// subscribe to reply events, and assert that the right guest gets the right text.
// Heavy: admission takes minutes. Share one assembly per mode with a memoized promise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'concierge', 'answers.json'), 'utf8'));

let stubDemo = null;
let recordedDemo = null;

const getStubDemo = async () => {
  if (!stubDemo) {
    const { assembleDemo } = await import('../../demo/host/assemble.mjs');
    const workdir = mkdtempSync(join(tmpdir(), 'demo-room-answers-stub-'));
    let t = 1_790_000_000_000;
    const clock = { now: () => t, advance: (ms) => { t += ms; } };
    stubDemo = {
      promise: assembleDemo({
        mode: 'stub-model',
        workdir,
        capUsd: 1,
        now: clock.now,
        limits: { minGapMs: 1000, maxMessages: 100 },
      }).then((d) => Object.assign(d, { clock })),
      workdir,
    };
  }
  return stubDemo.promise;
};

const getRecordedDemo = async () => {
  if (!recordedDemo) {
    const { recordedOrdersOf } = await import('../../demo/host/recorded-orders.mjs');
    const { assembleDemo } = await import('../../demo/host/assemble.mjs');
    const workdir = mkdtempSync(join(tmpdir(), 'demo-room-answers-recorded-'));
    let t = 1_790_000_000_000;
    const clock = { now: () => t, advance: (ms) => { t += ms; } };
    const ordersOf = recordedOrdersOf(FIXTURE);
    recordedDemo = {
      promise: assembleDemo({
        mode: 'recorded',
        workdir,
        now: clock.now,
        ordersOf,
        size: 4,
        limits: { minGapMs: 1000, maxMessages: 100 }, // the test sends more than one message a guest in a few simulated seconds
      }).then((d) => Object.assign(d, { clock })),
      workdir,
    };
  }
  return recordedDemo.promise;
};

// Cleanup after all tests.
test.after(async () => {
  if (stubDemo) {
    const demo = await stubDemo.promise;
    await demo.close();
    rmSync(stubDemo.workdir, { recursive: true, force: true });
  }
  if (recordedDemo) {
    const demo = await recordedDemo.promise;
    await demo.close();
    rmSync(recordedDemo.workdir, { recursive: true, force: true });
  }
});

// ---- DF11.5 stub mode: guest gets reply event with their order id --------

test('DF11.5: stub mode, guest 1 says "where is my order?" and gets a reply event', { timeout: 1_800_000 }, async () => {
  const demo = await getStubDemo();
  const { room } = demo;
  const g1 = room.join('s1');
  const heard = [];
  room.subscribe('s1', (e) => heard.push(e));
  const order1 = g1.orders[0];
  assert.ok(order1, 'guest 1 should have at least one order');
  demo.clock.advance(1100);
  const result = await room.say('s1', 'where is my order?');
  assert.deepEqual(result, { ok: true }, 'message should be accepted');
  await demo.settle();
  demo.clock.advance(1100);
  // DF11.5: guest 1 gets a reply event whose text names their order.
  const replyEvent = heard.find((e) => e.kind === 'reply');
  assert.ok(replyEvent, `guest 1 should receive a reply event (heard: ${heard.map((e) => e.kind).join(', ')})`);
  assert.ok(replyEvent.text.includes(order1.id), `reply should name guest's order ${order1.id} (got: ${replyEvent.text})`);
});

// ---- DF11.5 recorded mode: fixture messages and their recorded answers --------

test('DF11.5: recorded mode, guest 1 says fixture status message and gets the recorded answer', { timeout: 1_800_000 }, async () => {
  const demo = await getRecordedDemo();
  const { room } = demo;
  const g1 = room.join('s1');
  const heard = [];
  room.subscribe('s1', (e) => heard.push(e));
  const statusText = FIXTURE.messages.find((m) => m.id === 'status').text;
  demo.clock.advance(1100);
  const result = await room.say('s1', statusText);
  assert.deepEqual(result, { ok: true }, 'message should be accepted');
  await demo.settle();
  demo.clock.advance(1100);
  // DF11.5: guest 1 gets the fixture's recorded answer for status.
  const replyEvent = heard.find((e) => e.kind === 'reply');
  const expectedText = FIXTURE.messages.find((m) => m.id === 'status').answer.text;
  assert.ok(replyEvent, `guest 1 should receive a reply event (heard: ${heard.map((e) => e.kind).join(', ')})`);
  assert.equal(replyEvent.text, expectedText, `reply text should match fixture (expected: ${expectedText}, got: ${replyEvent.text})`);
});

test('DF11.5: recorded mode, guest 2 says refund-outside and gets the Unsure reply', { timeout: 1_800_000 }, async () => {
  const demo = await getRecordedDemo();
  const { room } = demo;
  const g2 = room.join('s2');
  const heard = [];
  room.subscribe('s2', (e) => heard.push(e));
  const refundOutsideText = FIXTURE.messages.find((m) => m.id === 'refund-outside').text;
  demo.clock.advance(1100);
  const result = await room.say('s2', refundOutsideText);
  assert.deepEqual(result, { ok: true }, 'message should be accepted');
  await demo.settle();
  demo.clock.advance(1100);
  // DF11.5: guest 2 gets the fixture's recorded Unsure reply.
  const replyEvent = heard.find((e) => e.kind === 'reply');
  const expectedText = FIXTURE.messages.find((m) => m.id === 'refund-outside').replies.Unsure;
  assert.ok(replyEvent, `guest 2 should receive a reply event (heard: ${heard.map((e) => e.kind).join(', ')})`);
  assert.equal(replyEvent.text, expectedText, `reply should be the Unsure reply (expected: ${expectedText}, got: ${replyEvent.text})`);
});

test('DF11.5: recorded mode, unmapped message gets no reply (the program sends nothing on decision failure)', { timeout: 1_800_000 }, async () => {
  const demo = await getRecordedDemo();
  const { room } = demo;
  const g1 = room.join('s1');
  const heard = [];
  room.subscribe('s1', (e) => heard.push(e));
  demo.clock.advance(1100);
  const result = await room.say('s1', 'where is my order?');
  assert.deepEqual(result, { ok: true }, 'message should be accepted');
  await demo.settle();
  demo.clock.advance(1100);
  // DF11.3a, DF11.5: a message not in the fixture has no recorded answer. The program's decision fails
  // and sends nothing (Desk goes back to idle with no reply). Guest 1 gets no reply event.
  const replyEvents = heard.filter((e) => e.kind === 'reply');
  assert.equal(replyEvents.length, 0, `unmapped message should produce no reply (heard ${replyEvents.length} replies)`);
});

// Cleanup for heavy real-time tests.
let stubDemoRealClock = null;
let recordedDemoRealClock = null;

const getStubDemoRealClock = async () => {
  if (!stubDemoRealClock) {
    const { assembleDemo } = await import('../../demo/host/assemble.mjs');
    const workdir = mkdtempSync(join(tmpdir(), 'demo-room-answers-stub-real-'));
    stubDemoRealClock = {
      promise: assembleDemo({
        mode: 'stub-model',
        workdir,
        capUsd: 1,
        startWorkers: true,
        limits: { minGapMs: 1000, maxMessages: 100 },
      }),
      workdir,
    };
  }
  return stubDemoRealClock.promise;
};

const getRecordedDemoRealClock = async () => {
  if (!recordedDemoRealClock) {
    const { recordedOrdersOf } = await import('../../demo/host/recorded-orders.mjs');
    const { assembleDemo } = await import('../../demo/host/assemble.mjs');
    const workdir = mkdtempSync(join(tmpdir(), 'demo-room-answers-recorded-real-'));
    const ordersOf = recordedOrdersOf(FIXTURE);
    recordedDemoRealClock = {
      promise: assembleDemo({
        mode: 'recorded',
        workdir,
        ordersOf,
        size: 4,
        startWorkers: true,
        limits: { minGapMs: 1000, maxMessages: 100 },
      }),
      workdir,
    };
  }
  return recordedDemoRealClock.promise;
};

test.after(async () => {
  if (stubDemoRealClock) {
    const demo = await stubDemoRealClock.promise;
    await demo.close();
    rmSync(stubDemoRealClock.workdir, { recursive: true, force: true });
  }
  if (recordedDemoRealClock) {
    const demo = await recordedDemoRealClock.promise;
    await demo.close();
    rmSync(recordedDemoRealClock.workdir, { recursive: true, force: true });
  }
});

// Poll for a reply event with optional filter, up to 20 seconds of real time.
const pollReply = async (heard, filter = null) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const events = filter ? heard.filter(filter) : heard.filter((e) => e.kind === 'reply');
    if (events.length > 0) return events[events.length - 1];
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return undefined;
};

// ---- DF11.5a: stub mode with real clock, no settle. --------

test('DF11.5a: stub mode, guest gets reply naming order within 20 seconds real time', { timeout: 1_800_000 }, async () => {
  const demo = await getStubDemoRealClock();
  const { room } = demo;
  const g1 = room.join('s1');
  const heard = [];
  room.subscribe('s1', (e) => heard.push(e));
  const order1 = g1.orders[0];
  assert.ok(order1 && order1.id, 'guest 1 should have at least one order with an id');
  const result = await room.say('s1', 'where is my order?');
  assert.deepEqual(result, { ok: true }, 'message should be accepted');
  const replyEvent = await pollReply(heard);
  assert.ok(replyEvent, `no reply naming order arrived within 20 s of real time; heard: ${JSON.stringify(heard.map((e) => ({ kind: e.kind, text: e.text?.slice?.(0, 50) })))}`);
  assert.ok(replyEvent.text.includes(order1.id), `reply text should name guest's order ${order1.id}, got: ${replyEvent.text}`);
  const countBefore = heard.filter((e) => e.kind === 'reply').length;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const sayResult = await room.say('s1', 'hello there');
  assert.deepEqual(sayResult, { ok: true }, 'second message should be accepted');
  const secondReply = await pollReply(heard, (e) => e.kind === 'reply' && heard.indexOf(e) > heard.indexOf(replyEvent));
  assert.ok(secondReply, 'second message should receive a reply within 20 seconds');
  const ackText = 'Thank you, we have your message and will answer it shortly.';
  assert.notEqual(secondReply.text, ackText, `second reply should not be the acknowledgement "${ackText}", got: ${secondReply.text}`);
});

// ---- DF11.5a: recorded mode with real clock, ordersOf, and no settle. --------

test('DF11.5a: recorded mode, guest 1 gets fixture answer within 20 seconds real time', { timeout: 1_800_000 }, async () => {
  const demo = await getRecordedDemoRealClock();
  const { room } = demo;
  const g1 = room.join('s1');
  const heard = [];
  room.subscribe('s1', (e) => heard.push(e));
  const statusText = FIXTURE.messages.find((m) => m.id === 'status').text;
  const expectedAnswerText = FIXTURE.messages.find((m) => m.id === 'status').answer.text;
  const result = await room.say('s1', statusText);
  assert.deepEqual(result, { ok: true }, 'message should be accepted');
  const replyEvent = await pollReply(heard);
  assert.ok(replyEvent, `no reply arrived within 20 s of real time for fixture status message; heard: ${JSON.stringify(heard.map((e) => ({ kind: e.kind, text: e.text?.slice?.(0, 50) })))}`);
  assert.equal(replyEvent.text, expectedAnswerText, `reply should match fixture answer text "${expectedAnswerText}", got: ${replyEvent.text}`);
});
