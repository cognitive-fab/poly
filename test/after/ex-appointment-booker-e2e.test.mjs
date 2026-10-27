// Appointment-booker end-to-end test over recorded traffic.
// Tests the machine through its handlers and recorded provider with no network or model calls.
// Rule 7a: Written from spec alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayRuntime, replaySessions } from '@poly/check';
import { ROOT } from '../helpers.mjs';
import { loadExample, recordingEgress, settle } from '../ex-kit.mjs';
import { admitExample } from '../ex-kit.mjs';

let cachedAdmission;
/** One admission for the whole file: each test loads its own runtime from the same certified build. */
const admitted = () => (cachedAdmission ??= admitExample('appointment-booker'));

const EX_DIR = join(ROOT, 'examples', 'appointment-booker');

test('appointment-booker: admission checks the program and policy; the example admits', { timeout: 60_000 }, async () => {
  const a = await admitted();
  assert.ok(a.dir);
  assert.ok(a.report);
  assert.equal(a.report.verdict, 'CLEAN', JSON.stringify(a.report.diagnostics));
});

test('appointment-booker: main path - ask tue-nine, Reset to Idle', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedBooker, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    // Set up the decision provider.
    const provider = recordedBooker(answers);
    provideRecorded(rt, provider);

    // Set up the write handler - get it from the certified exports.
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('calendar.write', handlers.write);

    // Create a service machine instance.
    await rt.create('booker.Calendar', { id: 'cal-1' });
    const id = 'cal-1';

    // Main path: Ask with tue-nine text.
    const textId = await rt.putContent('Can I get Tuesday at nine?');
    await rt.dispatch(id, 'Ask', { text: textId });
    await settle(rt);

    // Should be Booked with one POST.
    assert.equal(egress.sent.length, 1, 'one POST sent');
    const req = egress.sent[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, 'https://calendar.example/v1/events');
    assert.ok(req.headers['idempotency-key'], 'idempotency-key header is set');
    const key1 = req.headers['idempotency-key'];
    // Body should be { day: 0, hour: 0 }.
    assert.deepEqual(req.body, { day: 0, hour: 0 });

    // Check the state is Booked.
    const state = (await rt.getState(id)).state;
    assert.equal(state.phase, 'Booked');
    assert.equal(state.slot, 0);
    assert.equal(state.taken[0], true, 'slot 0 is taken');

    // Reset should go back to Idle.
    await rt.dispatch(id, 'Reset', {});
    await settle(rt);

    const state2 = (await rt.getState(id)).state;
    assert.equal(state2.phase, 'Idle');
    assert.equal(state2.taken[0], true, 'slot 0 stays taken (persistent)');

    // No new requests sent.
    assert.equal(egress.sent.length, 1);
  } finally {
    await rt.close();
  }
});

test('appointment-booker: refusal - tue-nine-again ends Conflict (no second POST); vague ends Unclear', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedBooker, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    const provider = recordedBooker(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('calendar.write', handlers.write);

    await rt.create('booker.Calendar', { id: 'cal-2' });
    const id = 'cal-2';

    // Book slot (0, 0) first, so the second request for it meets a taken slot.
    const first = await rt.putContent('Can I get Tuesday at nine?');
    await rt.dispatch(id, 'Ask', { text: first });
    await settle(rt);
    assert.equal((await rt.getState(id)).state.phase, 'Booked');
    assert.equal(egress.sent.length, 1);
    await rt.dispatch(id, 'Reset', {});
    await settle(rt);

    // The same slot again.
    const text1Id = await rt.putContent('Tuesday at nine please, for my sister.');
    await rt.dispatch(id, 'Ask', { text: text1Id });
    await settle(rt);

    // Should end Conflict (slot already taken in a persistent calendar).
    const state1 = (await rt.getState(id)).state;
    assert.equal(state1.phase, 'Conflict', `should be Conflict; got ${state1.phase}`);
    // No POST because the slot is already taken.
    assert.equal(egress.sent.length, 1, 'no second POST for Conflict');

    // Reset.
    await rt.dispatch(id, 'Reset', {});
    await settle(rt);

    // Now ask vague: "Sometime next week?" - low confidence, should be Unclear.
    const text2Id = await rt.putContent('Sometime next week?');
    await rt.dispatch(id, 'Ask', { text: text2Id });
    await settle(rt);

    const state2 = (await rt.getState(id)).state;
    assert.equal(state2.phase, 'Unclear', `vague should be Unclear; got ${state2.phase}`);
    // Still no POST.
    assert.equal(egress.sent.length, 1, 'no POST for Unclear');
  } finally {
    await rt.close();
  }
});

test('appointment-booker: keyed - first 503 then 201 sends two requests with same key', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedBooker, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  // Use a queue of responses: first 503, then 201.
  const responses = [
    { status: 503, headers: {}, body: { error: 'service unavailable' } },
    { status: 201, headers: {}, body: { ok: true } },
  ];
  let responseIndex = 0;
  const egress = recordingEgress(() => responses[responseIndex++] ?? { status: 200, headers: {}, body: { ok: true } });
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    const provider = recordedBooker(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('calendar.write', handlers.write);

    await rt.create('booker.Calendar', { id: 'cal-3' });
    const id = 'cal-3';

    // Ask wed-ten, which parses to (1, 1).
    const textId = await rt.putContent('Wednesday at ten works.');
    await rt.dispatch(id, 'Ask', { text: textId });
    // Need to advance clock for retries: the effect retries with base 200ms.
    for (let i = 0; i < 15; i++) {
      await rt.advance();
      await rt.worker.tick();
      clock.advance(300);
    }

    // Should have sent 2 requests (first 503, then 201 succeeds).
    assert.equal(egress.sent.length, 2, `should have 2 requests; got ${egress.sent.length}`);
    const key1 = egress.sent[0].headers['idempotency-key'];
    const key2 = egress.sent[1].headers['idempotency-key'];
    assert.equal(key1, key2, 'both requests have the same idempotency-key');

    // Should be Booked.
    const state1 = (await rt.getState(id)).state;
    assert.equal(state1.phase, 'Booked');

    // Reset and ask again: should get a new key.
    await rt.dispatch(id, 'Reset', {});
    await settle(rt);
    egress.sent.length = 0;
    responseIndex = 0;
    responses[0] = { status: 201, headers: {}, body: { ok: true } };

    // Ask tue-nine: slot (0, 0).
    const text2Id = await rt.putContent('Can I get Tuesday at nine?');
    await rt.dispatch(id, 'Ask', { text: text2Id });
    await settle(rt);

    assert.equal(egress.sent.length, 1);
    const key3 = egress.sent[0].headers['idempotency-key'];
    assert.notEqual(key3, key1, 'new request has a different key');
  } finally {
    await rt.close();
  }
});

test('appointment-booker: failure - 409 ends Failed and frees the slot', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedBooker, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  // First instance: 409 error
  const a1 = await admitted();
  const egress1 = recordingEgress(() => ({ status: 409, headers: {}, body: { error: 'conflict' } }));
  const { rt: rt1, clock: clock1 } = await loadExample(a1, { transports: egress1.transports });
  try {
    const provider1 = recordedBooker(answers);
    provideRecorded(rt1, provider1);
    const handlers1 = rt1.handlerExports('src/handlers.ts');
    rt1.handle('calendar.write', handlers1.write);

    await rt1.create('booker.Calendar', { id: 'cal-4a' });
    const id1 = 'cal-4a';

    // Ask tue-nine: slot (0, 0).
    const text1Id = await rt1.putContent('Can I get Tuesday at nine?');
    await rt1.dispatch(id1, 'Ask', { text: text1Id });
    await settle(rt1);

    // Should be Failed (409 is permanent).
    const state1 = (await rt1.getState(id1)).state;
    assert.equal(state1.phase, 'Failed');
    assert.equal(state1.taken[0], false, 'the slot is freed after failure');
  } finally {
    await rt1.close();
  }

  // Second instance: successful booking after failure
  const a2 = await admitted();
  const egress2 = recordingEgress(() => ({ status: 201, headers: {}, body: { ok: true } }));
  const { rt: rt2, clock: clock2 } = await loadExample(a2, { transports: egress2.transports });
  try {
    const provider2 = recordedBooker(answers);
    provideRecorded(rt2, provider2);
    const handlers2 = rt2.handlerExports('src/handlers.ts');
    rt2.handle('calendar.write', handlers2.write);

    await rt2.create('booker.Calendar', { id: 'cal-4b' });
    const id2 = 'cal-4b';
    const text2Id = await rt2.putContent('Can I get Tuesday at nine?');
    await rt2.dispatch(id2, 'Ask', { text: text2Id });
    await settle(rt2);

    const state2 = (await rt2.getState(id2)).state;
    assert.equal(state2.phase, 'Booked', 'same slot books in fresh instance');
  } finally {
    await rt2.close();
  }
});

test('appointment-booker: uncertainty - three 503s end Uncertain with slot still taken; Resolve(found: true) goes Booked', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedBooker, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  // Return 503 three times (hit the retry limit).
  const responses = [
    { status: 503, headers: {}, body: {} },
    { status: 503, headers: {}, body: {} },
    { status: 503, headers: {}, body: {} },
  ];
  let responseIndex = 0;
  const egress = recordingEgress(() => responses[responseIndex++] ?? { status: 500, headers: {}, body: {} });
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    const provider = recordedBooker(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('calendar.write', handlers.write);

    await rt.create('booker.Calendar', { id: 'cal-5' });
    const id = 'cal-5';

    // Ask wed-ten: slot (1, 1).
    const textId = await rt.putContent('Wednesday at ten works.');
    await rt.dispatch(id, 'Ask', { text: textId });
    // Advance to let retries happen.
    for (let i = 0; i < 20; i++) {
      await rt.advance();
      await rt.worker.tick();
      clock.advance(300);
    }

    // Should have sent 3 requests.
    assert.equal(egress.sent.length, 3, `should have 3 requests; got ${egress.sent.length}`);
    // All with the same key.
    const key = egress.sent[0].headers['idempotency-key'];
    assert.ok(egress.sent.every((r) => r.headers['idempotency-key'] === key), 'all requests have the same key');

    // Should be Uncertain.
    const state1 = (await rt.getState(id)).state;
    assert.equal(state1.phase, 'Uncertain');
    assert.equal(state1.taken[3], true, 'the slot is still taken in Uncertain state');

    // Resolve(found: true) goes to Booked.
    await rt.dispatch(id, 'Resolve', { found: true });
    await settle(rt);

    const state2 = (await rt.getState(id)).state;
    assert.equal(state2.phase, 'Booked');
    assert.equal(state2.taken[3], true, 'the slot remains taken');
  } finally {
    await rt.close();
  }
});

test('appointment-booker: journal replays with no divergence', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedBooker, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    const provider = recordedBooker(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('calendar.write', handlers.write);

    await rt.create('booker.Calendar', { id: 'cal-replay' });
    const id = 'cal-replay';
    const textId = await rt.putContent('Can I get Tuesday at nine?');
    await rt.dispatch(id, 'Ask', { text: textId });
    await settle(rt);

    // Replay the runtime and sessions.
    const replays = await replayRuntime(rt);
    for (const r of replays) {
      assert.deepEqual([r.diagnostics, r.notRun ?? null, r.gateNotRun], [[], null, 0], `divergence in ${r.machine}: ${JSON.stringify(r.diagnostics)}`);
    }

    // Check that booker.Calendar is among the replayed machines.
    const kinds = new Set(replays.map((x) => x.machine));
    assert.ok(kinds.has('booker.Calendar'), `booker.Calendar should be in replayed machines; got ${[...kinds].join(', ')}`);

    // Replay sessions (decisions and policies).
    const sessions = await replaySessions(rt);
    assert.ok(sessions.length > 0, 'there are gate sessions to replay (policy gates the write)');
    for (const s of sessions) {
      assert.deepEqual([s.diagnostics.length, s.notRun.length], [0, 0], `session divergence: ${JSON.stringify(s.diagnostics)}`);
    }

    console.log(`replay: ${replays.length} runs, ${replays.reduce((n, x) => n + x.rows, 0)} rows; ${sessions.length} gate sessions; divergences: ${replays.reduce((n, x) => n + x.diagnostics.length, 0) + sessions.reduce((n, s) => n + s.diagnostics.length, 0)}`);
  } finally {
    await rt.close();
  }
});
