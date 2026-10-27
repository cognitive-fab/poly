// support-drafts end-to-end test over recorded traffic.
// Tests the machine through its handlers and recorded provider with no network or model calls.
// Rule 7a: Written from spec alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayRuntime, replaySessions } from '@poly/check';
import { postgresSource } from '@poly/io';
import { ROOT } from '../helpers.mjs';
import { loadExample, recordingEgress, settle, admitExample } from '../ex-kit.mjs';
import { approvalFor } from '../runtime-helpers.mjs';
import { pgOrders } from '../memory-helpers.mjs';

let cachedAdmission;
/** One admission for the whole file: each test loads its own runtime from the same certified build. */
const admitted = () => (cachedAdmission ??= admitExample('support-drafts'));

const EX_DIR = join(ROOT, 'examples', 'support-drafts');

test('support-drafts: admission checks the program and policy; the example admits', { timeout: 60_000 }, async () => {
  const a = await admitted();
  assert.ok(a.dir);
  assert.ok(a.report);
  assert.equal(a.report.verdict, 'CLEAN', JSON.stringify(a.report.diagnostics));
});

test('support-drafts: main path - Open, effect retrieves tickets, decisions run, brief reads notes, Ready, Propose escalates, approval releases, one POST, Created', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedDrafts, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    // Set up the recorded models.
    const provider = recordedDrafts(answers);
    provideRecorded(rt, provider);

    // Set up the fake Postgres sources for tickets and notes with all data.
    const ticketRows = answers.tickets.map((t) => ({
      order_id: t.id,
      customer_id: t.owner,
      summary: t.body,
      updated_at: t.asOf,
    }));
    const noteRows = answers.notes.map((n) => ({
      order_id: n.id,
      customer_id: n.owner,
      summary: n.body,
      updated_at: n.asOf,
    }));
    const ticketsDb = pgOrders(ticketRows);
    const notesDb = pgOrders(noteRows);
    rt.connectSource('tickets', postgresSource({ query: ticketsDb.query, table: 'tickets', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
    rt.connectSource('notes', postgresSource({ query: notesDb.query, table: 'notes', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));

    // Set up the handler.
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('helpdesk.createDraft', handlers.createDraft);

    // Create a Ticket instance for owner-1.
    await rt.create('drafts.Ticket', { id: 'ticket-owner-1' });
    const id = 'ticket-owner-1';

    // Dispatch Open with owner-1. This emits read(who: owner-1) effect.
    // The runtime will retrieve tickets, call Read internally with the items,
    // and the decisions will run automatically.
    await rt.dispatch(id, 'Open', { who: 'owner-1' }, { credentials: { principal: 'owner-1' } });
    for (let i = 0; i < 10; i++) await settle(rt);

    // After settle, all decisions should have completed.
    // Check that the provider was asked (this means the decisions ran).
    assert.ok(provider.asked.length > 0, `decisions should have been asked; got ${provider.asked.length}`);

    // Check the state: should be Ready.
    let state = (await rt.getState(id)).state;
    // If state is still Reading, the effect might not have completed yet. That's a problem with the example setup, not the test.
    if (state.status !== 'Ready') {
      throw new Error(`Example issue: state is ${state.status}, not Ready as expected. Provider was asked ${provider.asked.length} times. This indicates the retrieve effect did not complete properly.`);
    }
    assert.equal(state.owner, 'owner-1', 'owner is owner-1');
    assert.ok(state.summed, 'summary decision completed');
    assert.ok(state.written, 'write decision completed');
    assert.ok(state.brief, 'brief completed');

    // Dispatch Propose. This emits createDraft effect.
    await rt.dispatch(id, 'Propose', {}, { credentials: { principal: 'owner-1' } });
    await settle(rt);

    // Check the state: should be Proposed.
    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Proposed', `expected Proposed; got ${state.status}`);

    // The createDraft effect is escalated; nothing should have been posted yet.
    assert.equal(egress.sent.length, 0, 'no POST sent before approval');

    // Find the escalated intent in pr_outbox.
    const rows = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'helpdesk.createDraft'").all(id);
    assert.ok(rows.length > 0, 'escalation recorded in outbox');
    const intentId = rows[0].intent_id;

    // Get approval for the intent and apply it.
    await rt.approve(await approvalFor(rt, intentId));
    await settle(rt);

    // Now one POST should have been sent.
    assert.equal(egress.sent.length, 1, 'one POST sent after approval');
    const req = egress.sent[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, 'https://helpdesk.example/v1/drafts');
    assert.ok(req.headers['idempotency-key'], 'idempotency-key header is set');
    // Body should be { body: <draft text> }.
    assert.ok(req.body.body, 'body contains the draft text');

    // Check the final state: Created.
    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Created', `expected Created; got ${state.status}`);
  } finally {
    await rt.close();
  }
});

test('support-drafts: refusal by the gate - defect with program\'s policy, external model is denied audience for notes', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedDrafts, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  // Admit the defect program with the program's own (full) policy.
  const a = await admitExample('support-drafts', { program: 'support-drafts-defect.poly', policy: 'support-drafts.policy.poly', tag: 'defect-own-policy' });

  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const provider = recordedDrafts(answers);
    provideRecorded(rt, provider);

    // Set up the fake Postgres sources with all data.
    const ticketRows = answers.tickets.map((t) => ({
      order_id: t.id,
      customer_id: t.owner,
      summary: t.body,
      updated_at: t.asOf,
    }));
    const noteRows = answers.notes.map((n) => ({
      order_id: n.id,
      customer_id: n.owner,
      summary: n.body,
      updated_at: n.asOf,
    }));
    const ticketsDb = pgOrders(ticketRows);
    const notesDb = pgOrders(noteRows);
    rt.connectSource('tickets', postgresSource({ query: ticketsDb.query, table: 'tickets', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
    rt.connectSource('notes', postgresSource({ query: notesDb.query, table: 'notes', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));

    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('helpdesk.createDraft', handlers.createDraft);

    await rt.create('drafts.Ticket', { id: 'ticket-defect' });
    const id = 'ticket-defect';

    // Open and let the flow run automatically.
    await rt.dispatch(id, 'Open', { who: 'owner-1' }, { credentials: { principal: 'owner-1' } });
    for (let i = 0; i < 10; i++) await settle(rt);

    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Ready', `expected Ready; got ${state.status}`);

    // The key assertion: the defect program issues summary twice (for tickets and for notes),
    // but the gate denies the notes from reaching the external model.
    // So provider.asked should have no summary entry with a note id.
    const summaryAsked = provider.asked.filter((a) => a.decision === 'summary');
    assert.ok(summaryAsked.length > 0, 'summary was asked');

    // Get all note ids.
    const noteIds = answers.notes.map((n) => n.id);

    // Check that no summary ask includes a note id.
    for (const ask of summaryAsked) {
      const hasNoteId = ask.items.some((id) => noteIds.includes(id));
      assert.ok(!hasNoteId, `summary should never be asked about notes; asked with items: ${ask.items.join(', ')}`);
    }

    // Added by the implementer: the gate, not the provider, refused it. The extra summary over the notes was proposed and denied.
    const denials = (await rt.chain(id)).filter((e) => e.kind === 'verdict' && e.body.effectKind === 'decision.summary' && e.body.outcome === 'denied');
    assert.equal(denials.length, 1, JSON.stringify(denials.map((e) => e.body)));
    console.log(`support-drafts: the gate denied decision.summary over the notes: ${denials[0].body.reason}`);

    // Dispatch Propose and verify escalation.
    await rt.dispatch(id, 'Propose', {}, { credentials: { principal: 'owner-1' } });
    await settle(rt);

    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Proposed', `expected Proposed; got ${state.status}`);

    // No POST before approval.
    assert.equal(egress.sent.length, 0, 'no POST sent before approval');

    // Approve and check POST.
    const rows = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'helpdesk.createDraft'").all(id);
    assert.ok(rows.length > 0, 'escalation recorded');
    const intentId = rows[0].intent_id;

    await rt.approve(await approvalFor(rt, intentId));
    await settle(rt);

    assert.equal(egress.sent.length, 1, 'one POST after approval');
    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Created', `expected Created; got ${state.status}`);
  } finally {
    await rt.close();
  }
});

test('support-drafts: isolation - owner-1 and owner-2 do not share tickets or notes', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedDrafts, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const provider = recordedDrafts(answers);
    provideRecorded(rt, provider);

    // Set up sources with both owner-1 and owner-2 data.
    const ticketRows = answers.tickets.map((t) => ({
      order_id: t.id,
      customer_id: t.owner,
      summary: t.body,
      updated_at: t.asOf,
    }));
    const noteRows = answers.notes.map((n) => ({
      order_id: n.id,
      customer_id: n.owner,
      summary: n.body,
      updated_at: n.asOf,
    }));
    const ticketsDb = pgOrders(ticketRows);
    const notesDb = pgOrders(noteRows);
    rt.connectSource('tickets', postgresSource({ query: ticketsDb.query, table: 'tickets', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
    rt.connectSource('notes', postgresSource({ query: notesDb.query, table: 'notes', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));

    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('helpdesk.createDraft', handlers.createDraft);

    // Create two Ticket instances, one for each owner.
    await rt.create('drafts.Ticket', { id: 'ticket-o1' });
    await rt.create('drafts.Ticket', { id: 'ticket-o2' });
    const id1 = 'ticket-o1';
    const id2 = 'ticket-o2';

    // Open both and let them run to Ready.
    await rt.dispatch(id1, 'Open', { who: 'owner-1' }, { credentials: { principal: 'owner-1' } });
    await rt.dispatch(id2, 'Open', { who: 'owner-2' }, { credentials: { principal: 'owner-2' } });
    for (let i = 0; i < 10; i++) await settle(rt);

    // Both should be Ready.
    let state1 = (await rt.getState(id1)).state;
    let state2 = (await rt.getState(id2)).state;
    assert.equal(state1.status, 'Ready', 'ticket-o1 is Ready');
    assert.equal(state2.status, 'Ready', 'ticket-o2 is Ready');

    // Verify that the database queries filtered by owner.
    const allQueries = [...ticketsDb.seen];
    // The notes source too: every retrieval it saw names one owner, and each owner's run asked it once for its own notes.
    const noteRetrievals = notesDb.seen.filter((q) => q.text.startsWith('SELECT "order_id" AS id'));
    assert.deepEqual(noteRetrievals.map((q) => q.params[0]).sort(), ['owner-1', 'owner-2'], 'the notes source was asked for each owner, by owner');
    const briefAsked = provider.asked.filter((a) => a.decision === 'brief');
    assert.deepEqual(briefAsked.map((a) => a.items).sort(), [['n-1001'], ['n-2001']], 'each brief was given only its own note');
    const owner1Queries = allQueries.filter((q) => q.params && q.params[0] === 'owner-1');
    const owner2Queries = allQueries.filter((q) => q.params && q.params[0] === 'owner-2');
    assert.ok(owner1Queries.length > 0, 'queries made for owner-1');
    assert.ok(owner2Queries.length > 0, 'queries made for owner-2');

    // Verify that provider.asked shows different owners got different items.
    const summaryAsked = provider.asked.filter((a) => a.decision === 'summary');
    assert.ok(summaryAsked.length >= 2, 'at least 2 summary asks (one per owner)');

    // owner-1 should have 2 tickets, owner-2 should have 1.
    const owner1TicketIds = answers.tickets.filter((t) => t.owner === 'owner-1').map((t) => t.id);
    const owner2TicketIds = answers.tickets.filter((t) => t.owner === 'owner-2').map((t) => t.id);

    // Count asks per owner by checking which ticket ids are in each ask.
    let owner1Asks = 0;
    let owner2Asks = 0;
    for (const ask of summaryAsked) {
      const hasOwner1 = ask.items.some((id) => owner1TicketIds.includes(id));
      const hasOwner2 = ask.items.some((id) => owner2TicketIds.includes(id));
      if (hasOwner1 && !hasOwner2) owner1Asks++;
      else if (hasOwner2 && !hasOwner1) owner2Asks++;
      else assert.fail(`ask should be for only one owner; got: ${ask.items.join(', ')}`);
    }
    assert.ok(owner1Asks >= 1, 'summary asked for owner-1');
    assert.ok(owner2Asks >= 1, 'summary asked for owner-2');
  } finally {
    await rt.close();
  }
});

test('support-drafts: uncertainty - a draft answered 503 ends Uncertain with one POST, Resolve(found: true) ends Created', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedDrafts, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  // Set up egress to return 503 on the createDraft effect.
  const egress = recordingEgress((req) => {
    if (req.url === 'https://helpdesk.example/v1/drafts') {
      return { status: 503, headers: {}, body: {} };
    }
    return { status: 200, headers: {}, body: { ok: true } };
  });
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const provider = recordedDrafts(answers);
    provideRecorded(rt, provider);

    const ticketRows = answers.tickets.filter((t) => t.owner === 'owner-1').map((t) => ({
      order_id: t.id,
      customer_id: t.owner,
      summary: t.body,
      updated_at: t.asOf,
    }));
    const noteRows = answers.notes.filter((n) => n.owner === 'owner-1').map((n) => ({
      order_id: n.id,
      customer_id: n.owner,
      summary: n.body,
      updated_at: n.asOf,
    }));
    const ticketsDb = pgOrders(ticketRows);
    const notesDb = pgOrders(noteRows);
    rt.connectSource('tickets', postgresSource({ query: ticketsDb.query, table: 'tickets', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
    rt.connectSource('notes', postgresSource({ query: notesDb.query, table: 'notes', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));

    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('helpdesk.createDraft', handlers.createDraft);

    await rt.create('drafts.Ticket', { id: 'ticket-uncertain' });
    const id = 'ticket-uncertain';

    // Open and let it reach Ready automatically.
    await rt.dispatch(id, 'Open', { who: 'owner-1' }, { credentials: { principal: 'owner-1' } });
    for (let i = 0; i < 10; i++) await settle(rt);

    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Ready', `expected Ready; got ${state.status}`);

    await rt.dispatch(id, 'Propose', {}, { credentials: { principal: 'owner-1' } });
    await settle(rt);

    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Proposed');

    // Find the escalated intent and approve it.
    const rows = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'helpdesk.createDraft'").all(id);
    assert.ok(rows.length > 0, 'escalation recorded');
    const intentId = rows[0].intent_id;

    await rt.approve(await approvalFor(rt, intentId));
    await settle(rt, 40);

    // One POST should have been sent, but it returned 503 (ambiguous with one attempt = exhausted).
    assert.equal(egress.sent.length, 1, 'one POST sent');
    const req = egress.sent[0];
    assert.equal(req.url, 'https://helpdesk.example/v1/drafts');

    // State should be Uncertain.
    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Uncertain', `expected Uncertain; got ${state.status}`);

    // Resolve with found: true.
    await rt.dispatch(id, 'Resolve', { found: true }, { credentials: { principal: 'owner-1' } });
    await settle(rt);

    // State should be Created.
    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Created', `expected Created after Resolve(found: true); got ${state.status}`);
  } finally {
    await rt.close();
  }
});

test('support-drafts: journal replays with no divergence', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedDrafts, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const provider = recordedDrafts(answers);
    provideRecorded(rt, provider);

    const ticketRows = answers.tickets.map((t) => ({
      order_id: t.id,
      customer_id: t.owner,
      summary: t.body,
      updated_at: t.asOf,
    }));
    const noteRows = answers.notes.map((n) => ({
      order_id: n.id,
      customer_id: n.owner,
      summary: n.body,
      updated_at: n.asOf,
    }));
    const ticketsDb = pgOrders(ticketRows);
    const notesDb = pgOrders(noteRows);
    rt.connectSource('tickets', postgresSource({ query: ticketsDb.query, table: 'tickets', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));
    rt.connectSource('notes', postgresSource({ query: notesDb.query, table: 'notes', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary' }));

    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('helpdesk.createDraft', handlers.createDraft);

    await rt.create('drafts.Ticket', { id: 'ticket-replay' });
    const id = 'ticket-replay';

    // Run a simple scenario: Open and let effects/decisions run, then Propose.
    await rt.dispatch(id, 'Open', { who: 'owner-1' }, { credentials: { principal: 'owner-1' } });
    for (let i = 0; i < 10; i++) await settle(rt);

    await rt.dispatch(id, 'Propose', {}, { credentials: { principal: 'owner-1' } });
    await settle(rt);

    // Replay the runtime.
    const replays = await replayRuntime(rt);
    for (const r of replays) {
      assert.deepEqual([r.diagnostics, r.notRun ?? null, r.gateNotRun], [[], null, 0], `divergence in ${r.machine}: ${JSON.stringify(r.diagnostics)}`);
    }

    // Check that drafts.Ticket is among the replayed machines.
    const kinds = new Set(replays.map((x) => x.machine));
    assert.ok(kinds.has('drafts.Ticket'), `drafts.Ticket should be in replayed machines; got ${[...kinds].join(', ')}`);

    // Replay sessions (decisions and policies).
    const sessions = await replaySessions(rt);
    assert.ok(sessions.length > 0, 'there are gate sessions to replay (policy gates the createDraft effect)');
    for (const s of sessions) {
      assert.deepEqual([s.diagnostics.length, s.notRun.length], [0, 0], `session divergence: ${JSON.stringify(s.diagnostics)}`);
    }

    console.log(`replay: ${replays.length} runs, ${replays.reduce((n, x) => n + x.rows, 0)} rows; ${sessions.length} gate sessions; divergences: ${replays.reduce((n, x) => n + x.diagnostics.length, 0) + sessions.reduce((n, s) => n + s.diagnostics.length, 0)}`);
  } finally {
    await rt.close();
  }
});
