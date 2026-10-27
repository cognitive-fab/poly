// Incident-oncall end-to-end test over recorded traffic.
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
const admitted = () => (cachedAdmission ??= admitExample('incident-oncall'));

const EX_DIR = join(ROOT, 'examples', 'incident-oncall');

test('incident-oncall: admission checks the program and policy; the example admits', { timeout: 60_000 }, async () => {
  const a = await admitted();
  assert.ok(a.dir);
  assert.ok(a.report);
  assert.equal(a.report.verdict, 'CLEAN', JSON.stringify(a.report.diagnostics));
});

test('incident-oncall: main path - db-down pages once, Ack ends Acked, advance 10 minutes no escalation, Resolve ends Resolved', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedIncidents, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    // Set up the decision provider.
    const provider = recordedIncidents(answers);
    provideRecorded(rt, provider);

    // Set up the handlers.
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('pager.page', handlers.page);
    rt.handle('pager.escalate', handlers.escalate);

    // Create an instance.
    await rt.create('oncall.Incident', { id: 'inc-1' });
    const id = 'inc-1';

    // Report with db-down.
    const reportId = await rt.putContent('Primary database is down, all writes are failing.');
    await rt.dispatch(id, 'Report', { summary: reportId });
    await settle(rt);


    // The recorded decision answers High at 0.95, so the incident pages and is Paged.
    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Paged', 'status should be Paged after page succeeds');
    assert.equal(egress.sent.length, 1, 'one page POST sent');
    assert.equal(egress.sent[0].url, 'https://pager.example/v1/pages');

    // Ack the page.
    await rt.dispatch(id, 'Ack', {});
    await settle(rt);

    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Acked', 'status should be Acked');

    // Advance 10 minutes - no escalation should be sent.
    clock.advance(10 * 60 * 1000);
    await settle(rt);

    // Still one POST (the page), no escalation.
    assert.equal(egress.sent.length, 1, 'no escalation after 10 minutes with Ack');
    assert.equal((await rt.getState(id)).state.status, 'Acked', 'still Acked after the clock moved');

    // Resolve.
    await rt.dispatch(id, 'Resolve', {});
    await settle(rt);

    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Resolved', 'status should be Resolved');
  } finally {
    await rt.close();
  }
});

test('incident-oncall: timeout - db-down, no ack, advance 5 minutes, one escalation POST, Escalated', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedIncidents, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    const provider = recordedIncidents(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('pager.page', handlers.page);
    rt.handle('pager.escalate', handlers.escalate);

    await rt.create('oncall.Incident', { id: 'inc-2' });
    const id = 'inc-2';

    const reportId = await rt.putContent('Primary database is down, all writes are failing.');
    await rt.dispatch(id, 'Report', { summary: reportId });
    await settle(rt);

    await settle(rt);

    // Should be Paged.
    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Paged');
    assert.equal(egress.sent.length, 1, 'one page POST sent');

    // Advance 5 minutes (the ack timer fires).
    clock.advance(5 * 60 * 1000);
    await settle(rt);

    // Should have escalated (Timeout fired).
    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Escalated', 'Timeout should trigger Escalated');
    assert.equal(egress.sent.length, 2, 'one page and one escalation POST');
    assert.equal(egress.sent[1].url, 'https://pager.example/v1/escalations', 'second POST is escalation');
  } finally {
    await rt.close();
  }
});

test('incident-oncall: refusal - footer-typo ends Logged with no POST, Ack rejected, third Snooze rejected', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedIncidents, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    const provider = recordedIncidents(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('pager.page', handlers.page);
    rt.handle('pager.escalate', handlers.escalate);

    await rt.create('oncall.Incident', { id: 'inc-3' });
    const id = 'inc-3';

    // Low severity (footer-typo).
    const reportId = await rt.putContent('There is a typo in the status page footer.');
    await rt.dispatch(id, 'Report', { summary: reportId });
    await settle(rt);

    await settle(rt);

    // Low severity should go to Logged, no POST.
    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Logged', 'Low severity ends in Logged');
    assert.equal(egress.sent.length, 0, 'no POST for Low severity');

    // Try to Ack - should be rejected not-waiting.
    const ackResult = await rt.dispatch(id, 'Ack', {});
    await settle(rt);
    assert.equal(ackResult.stepKind, 'rejected', 'Ack should be rejected');
    // Logged is terminal: the runtime refuses every action of a terminal instance with the reason `terminal`.
    assert.equal(ackResult.rejectReason, 'terminal', 'reason is terminal');

    // A fresh incident that pages, to test the snooze bound (a Logged incident is terminal).
    await rt.create('oncall.Incident', { id: 'inc-3b' });
    const snoozing = 'inc-3b';
    await rt.dispatch(snoozing, 'Report', { summary: await rt.putContent('Primary database is down, all writes are failing.') });
    await settle(rt);
    state = (await rt.getState(snoozing)).state;
    assert.equal(state.status, 'Paged');
    assert.equal(state.snoozes, 0, 'snoozes counter is 0');

    // Two snoozes are accepted, each woken by its timer; the third is refused.
    for (let i = 0; i < 2; i++) {
      const snoozeRes = await rt.dispatch(snoozing, 'Snooze', {});
      await settle(rt);
      assert.equal(snoozeRes.stepKind, 'accepted', `snooze ${i + 1} should succeed`);
      state = (await rt.getState(snoozing)).state;
      assert.equal(state.snoozes, i + 1, `snoozes counter is ${i + 1}`);
      assert.equal(state.status, 'Snoozed', `status is Snoozed after snooze ${i + 1}`);

      // Wake back up.
      clock.advance(15 * 60 * 1000);
      await settle(rt);
      state = (await rt.getState(snoozing)).state;
      assert.equal(state.status, 'Paged', `back to Paged after wake ${i + 1}`);
    }

    // Third snooze should be rejected (bound is 2).
    const snoozeRes = await rt.dispatch(snoozing, 'Snooze', {});
    await settle(rt);
    assert.equal(snoozeRes.stepKind, 'rejected', 'third snooze should be rejected');
    assert.equal(snoozeRes.rejectReason, 'cannot-snooze', 'reason is cannot-snooze');
  } finally {
    await rt.close();
  }
});

test('incident-oncall: escalation to person - odd-latency ends Review with no POST; Classify(High) pages', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedIncidents, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    const provider = recordedIncidents(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('pager.page', handlers.page);
    rt.handle('pager.escalate', handlers.escalate);

    await rt.create('oncall.Incident', { id: 'inc-4' });
    const id = 'inc-4';

    // odd-latency: High answer but low confidence (0.55).
    const reportId = await rt.putContent('Latency looks odd in one region, maybe.');
    await rt.dispatch(id, 'Report', { summary: reportId });
    await settle(rt);

    // Triaged with High but confidence < 0.8 (using margin semantics).
    await settle(rt);

    // Low confidence goes to Review.
    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Review', 'low confidence High goes to Review');
    assert.equal(egress.sent.length, 0, 'no POST before person classification');

    // Person classifies as High.
    await rt.dispatch(id, 'Classify', { sev: 'High' });
    await settle(rt);

    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Paged', 'Classify(High) goes to Paged');
    assert.equal(egress.sent.length, 1, 'one POST after classification');
    assert.equal(egress.sent[0].url, 'https://pager.example/v1/pages');
  } finally {
    await rt.close();
  }
});

test('incident-oncall: snooze - cancels escalation, 15 min later Wake returns to Paged, 5 min after that escalation sent', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedIncidents, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    const provider = recordedIncidents(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('pager.page', handlers.page);
    rt.handle('pager.escalate', handlers.escalate);

    await rt.create('oncall.Incident', { id: 'inc-5' });
    const id = 'inc-5';

    const reportId = await rt.putContent('Primary database is down, all writes are failing.');
    await rt.dispatch(id, 'Report', { summary: reportId });
    await settle(rt);

    await settle(rt);

    assert.equal(egress.sent.length, 1, 'one page POST sent');

    // Immediately snooze.
    await rt.dispatch(id, 'Snooze', {});
    await settle(rt);

    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Snoozed', 'status is Snoozed');
    assert.equal(state.snoozes, 1, 'snoozes counter is 1');

    // Advance 5 minutes - no escalation (wake timer is 15 min).
    clock.advance(5 * 60 * 1000);
    await settle(rt);

    assert.equal(egress.sent.length, 1, 'no escalation after 5 minutes (wake timer at 15 min)');

    // Advance 10 more minutes (total 15 min) to trigger Wake.
    clock.advance(10 * 60 * 1000);
    await settle(rt);

    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Paged', 'Wake returns to Paged');
    assert.equal(egress.sent.length, 1, 'still no escalation (ack timer now at 5 min)');

    // Advance 5 more minutes to trigger the ack timer (Timeout).
    clock.advance(5 * 60 * 1000);
    await settle(rt);

    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Escalated', 'Timeout fires, goes to Escalated');
    assert.equal(egress.sent.length, 2, 'one page and one escalation POST');
    assert.equal(egress.sent[1].url, 'https://pager.example/v1/escalations');
  } finally {
    await rt.close();
  }
});

test('incident-oncall: refused page (409) ends Escalating, then Escalated after escalation POST', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedIncidents, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  // Return 409 for the page effect, 200 for escalation.
  let callCount = 0;
  const egress = recordingEgress((req) => {
    callCount++;
    if (callCount === 1 && req.url.includes('pages')) {
      return { status: 409, headers: {}, body: { error: 'conflict' } };
    }
    return { status: 200, headers: {}, body: { ok: true } };
  });
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    const provider = recordedIncidents(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('pager.page', handlers.page);
    rt.handle('pager.escalate', handlers.escalate);

    await rt.create('oncall.Incident', { id: 'inc-6' });
    const id = 'inc-6';

    const reportId = await rt.putContent('Primary database is down, all writes are failing.');
    await rt.dispatch(id, 'Report', { summary: reportId });
    await settle(rt);

    await settle(rt);

    // The page is refused for good (409), PageFailed escalates, and the escalation is sent: one settle runs both.
    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Escalated', 'escalation POST succeeds, goes to Escalated');
    assert.equal(egress.sent.length, 2, 'one page and one escalation');
    assert.equal(egress.sent[1].url, 'https://pager.example/v1/escalations');
  } finally {
    await rt.close();
  }
});

test('incident-oncall: journal replays with no divergence', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedIncidents, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    const provider = recordedIncidents(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('pager.page', handlers.page);
    rt.handle('pager.escalate', handlers.escalate);

    await rt.create('oncall.Incident', { id: 'inc-replay' });
    const id = 'inc-replay';

    // Run a simple scenario: Report, Triaged, Ack, Resolve.
    const reportId = await rt.putContent('Primary database is down, all writes are failing.');
    await rt.dispatch(id, 'Report', { summary: reportId });
    await settle(rt);

    await settle(rt);

    await rt.dispatch(id, 'Ack', {});
    await settle(rt);

    await rt.dispatch(id, 'Resolve', {});
    await settle(rt);

    // Replay the runtime.
    const replays = await replayRuntime(rt);
    for (const r of replays) {
      assert.deepEqual([r.diagnostics, r.notRun ?? null, r.gateNotRun], [[], null, 0], `divergence in ${r.machine}: ${JSON.stringify(r.diagnostics)}`);
    }

    // Check that oncall.Incident is among the replayed machines.
    const kinds = new Set(replays.map((x) => x.machine));
    assert.ok(kinds.has('oncall.Incident'), `oncall.Incident should be in replayed machines; got ${[...kinds].join(', ')}`);

    // Replay sessions (decisions and policies).
    const sessions = await replaySessions(rt);
    assert.ok(sessions.length > 0, 'there are gate sessions to replay (policy gates the page effect)');
    for (const s of sessions) {
      assert.deepEqual([s.diagnostics.length, s.notRun.length], [0, 0], `session divergence: ${JSON.stringify(s.diagnostics)}`);
    }

    console.log(`replay: ${replays.length} runs, ${replays.reduce((n, x) => n + x.rows, 0)} rows; ${sessions.length} gate sessions; divergences: ${replays.reduce((n, x) => n + x.diagnostics.length, 0) + sessions.reduce((n, s) => n + s.diagnostics.length, 0)}`);
  } finally {
    await rt.close();
  }
});

// Written by the implementer after the code existed, for a review finding (the writer's spec had no such case): an
// acknowledgement can arrive before the page's answer. The late PageSent is taken, changes nothing, and is not a rejected
// step, so the machine does not wait on a completion that a handler refused (PS6.4, S463).
test('incident-oncall: an Ack before the page is answered leaves the late PageSent accepted, and the incident Acked', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedIncidents, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));
  const a = await admitted();
  let pages = 0;
  const egress = recordingEgress((req) => ({ status: req.url.endsWith('/pages') && ++pages === 1 ? 503 : 201, headers: {}, body: {} }));
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    provideRecorded(rt, recordedIncidents(answers));
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('pager.page', handlers.page);
    rt.handle('pager.escalate', handlers.escalate);
    await rt.create('oncall.Incident', { id: 'inc-late' });
    await rt.dispatch('inc-late', 'Report', { summary: await rt.putContent('Primary database is down, all writes are failing.') });
    await settle(rt);
    assert.equal((await rt.getState('inc-late')).state.status, 'Paging', 'the first page attempt was answered 503, so the page is still out');
    const ack = await rt.dispatch('inc-late', 'Ack', {});
    assert.equal(ack.stepKind, 'accepted');
    clock.advance(1000);
    await settle(rt);
    const journal = await rt.getJournal('inc-late');
    const late = journal.find((j) => j.action === 'PageSent');
    assert.ok(late, 'the retried page was answered and PageSent was dispatched');
    assert.deepEqual(journal.filter((j) => j.action === 'PageSent').map((j) => j.stepKind ?? j.verdict ?? 'accepted'), ['accepted']);
    const state = (await rt.getState('inc-late')).state;
    assert.deepEqual([state.status, state.answered], ['Acked', true]);
    assert.equal(egress.sent.filter((s) => s.url.endsWith('/pages')).length, 2, 'two attempts, one page');
  } finally {
    await rt.close();
  }
});
