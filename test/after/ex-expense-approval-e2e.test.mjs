// Expense-approval end-to-end test over recorded traffic.
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
const admitted = () => (cachedAdmission ??= admitExample('expense-approval'));
import { approvalFor } from '../runtime-helpers.mjs';

const EX_DIR = join(ROOT, 'examples', 'expense-approval');

test('expense-approval: admission checks the program and policy; the example admits', { timeout: 60_000 }, async () => {
  const a = await admitted();
  assert.ok(a.dir);
  assert.ok(a.report);
  assert.equal(a.report.verdict, 'CLEAN', JSON.stringify(a.report.diagnostics));
});

test('expense-approval: main path - alice submits 3 units (taxi), categorized Travel, bob approves, one POST, Settled', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedExpenses, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    // Set up the decision provider.
    const provider = recordedExpenses(answers);
    provideRecorded(rt, provider);

    // Set up the pay handler - get it from the certified exports.
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payroll.pay', handlers.pay);

    // Create an instance.
    await rt.create('expenses.Expense', { id: 'exp-1' });
    const id = 'exp-1';

    // Alice submits 3 units (150 euros) with the taxi receipt.
    const receiptId = await rt.putContent('Taxi from the airport, 150 euros.');
    await rt.dispatch(id, 'Submit', { amount: 3, receipt: receiptId }, { credentials: { principal: 'alice' } });
    await settle(rt);

    // Check the state: Submitted with category Travel.
    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Submitted', `expected Submitted; got ${state.status}`);
    assert.equal(state.category, 'Travel', `expected Travel; got ${state.category}`);
    assert.equal(state.submitter, 'alice', `expected alice as submitter; got ${state.submitter}`);
    assert.equal(state.large, false, 'amount 3 units is not large');

    // Bob approves.
    await rt.dispatch(id, 'Approve', {}, { credentials: { principal: 'bob' } });
    await settle(rt);

    // Should be Settled with one POST.
    assert.equal(egress.sent.length, 1, 'one POST sent');
    const req = egress.sent[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, 'https://payroll.example/v1/reimbursements');
    assert.ok(req.headers['idempotency-key'], 'idempotency-key header is set');
    // Body should be { euros: 150 }.
    assert.deepEqual(req.body, { euros: 150 });

    // Check the final state.
    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Settled');
    assert.equal(state.approver, 'bob', 'bob is the approver');
  } finally {
    await rt.close();
  }
});

test('expense-approval: refusal - alice cannot approve her own claim (own-claim)', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedExpenses, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const provider = recordedExpenses(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payroll.pay', handlers.pay);

    await rt.create('expenses.Expense', { id: 'exp-2' });
    const id = 'exp-2';

    // Alice submits.
    const receiptId = await rt.putContent('Taxi from the airport, 150 euros.');
    await rt.dispatch(id, 'Submit', { amount: 3, receipt: receiptId }, { credentials: { principal: 'alice' } });
    await settle(rt);

    // Alice tries to approve her own claim - should be rejected.
    const result = await rt.dispatch(id, 'Approve', {}, { credentials: { principal: 'alice' } });
    await settle(rt);

    // Check the result is a rejection.
    assert.equal(result.stepKind, 'rejected', 'the dispatch is rejected');
    assert.equal(result.rejectReason, 'own-claim', 'the reason is own-claim');

    // No POST sent.
    assert.equal(egress.sent.length, 0, 'no POST sent for rejection');

    // State should still be Submitted.
    const state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Submitted');
  } finally {
    await rt.close();
  }
});

test('expense-approval: refusal - amount 600 is rejected outside-check-domain before the handler', { timeout: 120_000 }, async () => {
  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payroll.pay', handlers.pay);

    await rt.create('expenses.Expense', { id: 'exp-3' });
    const id = 'exp-3';

    // Try to submit with amount 600 (outside the 0..10 domain).
    const receiptId = await rt.putContent('Receipt for 600');
    const result = await rt.dispatch(id, 'Submit', { amount: 12, receipt: receiptId }, { credentials: { principal: 'alice' } });
    await settle(rt);

    // Check the result is an out-of-domain rejection.
    assert.equal(result.stepKind, 'rejected', 'the dispatch is rejected');
    assert.equal(result.rejectReason, 'outside-check-domain', 'the reason is outside-check-domain');

    // No POST sent.
    assert.equal(egress.sent.length, 0, 'no POST sent');

    // State should still be Draft.
    const state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Draft');
  } finally {
    await rt.close();
  }
});

test('expense-approval: categorization - blurry receipt leaves category Other', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedExpenses, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const provider = recordedExpenses(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payroll.pay', handlers.pay);

    await rt.create('expenses.Expense', { id: 'exp-4' });
    const id = 'exp-4';

    // Submit with blurry receipt (confidence < 0.8, so defaults to Other).
    const receiptId = await rt.putContent('Receipt photo, unreadable.');
    await rt.dispatch(id, 'Submit', { amount: 1, receipt: receiptId }, { credentials: { principal: 'alice' } });
    await settle(rt);

    // Check the state: category should be Other.
    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Submitted');
    assert.equal(state.category, 'Other', 'low-confidence receipt defaults to Other');

    // Bob approves.
    await rt.dispatch(id, 'Approve', {}, { credentials: { principal: 'bob' } });
    await settle(rt);

    // Should be Settled.
    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Settled');
    assert.equal(egress.sent.length, 1, 'one POST sent');
  } finally {
    await rt.close();
  }
});

test('expense-approval: escalation - large payment (350) is escalated; person approval releases it', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedExpenses, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const provider = recordedExpenses(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payroll.pay', handlers.pay);

    await rt.create('expenses.Expense', { id: 'exp-5' });
    const id = 'exp-5';

    // Carol submits 350 (laptop) - large payment.
    const receiptId = await rt.putContent('Laptop stand and keyboard, 350 euros.');
    await rt.dispatch(id, 'Submit', { amount: 7, receipt: receiptId }, { credentials: { principal: 'carol' } });
    await settle(rt);

    // Check the state.
    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Submitted');
    assert.equal(state.category, 'Equipment');
    assert.equal(state.large, true, 'amount 7 units is large');

    // Dave approves.
    await rt.dispatch(id, 'Approve', {}, { credentials: { principal: 'dave' } });
    await settle(rt);

    // Check state: should be Paying (waiting for escalation).
    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Paying', 'large payment waits for escalation');

    // No POST sent yet (waiting for person approval).
    assert.equal(egress.sent.length, 0, 'no POST sent before person approval');

    // Find the escalated intent.
    const rows = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'payroll.pay'").all(id);
    assert.ok(rows.length > 0, 'escalation recorded in outbox');
    const intentId = rows[0].intent_id;

    // Person approves the intent.
    await rt.approve(await approvalFor(rt, intentId));
    await settle(rt);

    // Now one POST should have been sent.
    assert.equal(egress.sent.length, 1, 'one POST sent after person approval');
    const req = egress.sent[0];
    assert.equal(req.url, 'https://payroll.example/v1/reimbursements');
    assert.deepEqual(req.body, { euros: 350 });

    // Check the final state: Settled.
    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Settled');
    assert.equal(state.approver, 'dave', 'dave is the manager approver');
  } finally {
    await rt.close();
  }
});

test('expense-approval: one attempt and held claim; Resolve action resolves held claims', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedExpenses, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();

  // Set up egress to answer 503 for the first two POSTs (held claims), then 201 for the third (successful claim).
  let postCount = 0;
  const egress = recordingEgress((req) => {
    postCount++;
    const status = (postCount <= 2) ? 503 : 201;
    return { status, headers: {}, body: status === 201 ? { ok: true } : {} };
  });

  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const provider = recordedExpenses(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payroll.pay', handlers.pay);

    // First held claim (finding 31): one attempt, 503 -> Held.
    await rt.create('expenses.Expense', { id: 'held-1' });
    const id1 = 'held-1';

    const receiptId = await rt.putContent('Taxi from the airport, 150 euros.');
    await rt.dispatch(id1, 'Submit', { amount: 3, receipt: receiptId }, { credentials: { principal: 'alice' } });
    await settle(rt);

    await rt.dispatch(id1, 'Approve', {}, { credentials: { principal: 'bob' } });
    await settle(rt);

    // Exactly one POST sent, with 503 response.
    assert.equal(egress.sent.length, 1, 'exactly one POST sent');
    const req1 = egress.sent[0];
    assert.equal(req1.method, 'POST');
    assert.equal(req1.url, 'https://payroll.example/v1/reimbursements');
    assert.deepEqual(req1.body, { euros: 150 });

    // Claim is Held.
    let state = (await rt.getState(id1)).state;
    assert.equal(state.status, 'Held', `expected Held; got ${state.status}`);

    // Resolve(paid: true) by alice is rejected own-claim (submitter cannot resolve own claim).
    const rejAlice = await rt.dispatch(id1, 'Resolve', { paid: true }, { credentials: { principal: 'alice' } });
    await settle(rt);
    assert.equal(rejAlice.stepKind, 'rejected', 'Resolve by submitter is rejected');
    assert.equal(rejAlice.rejectReason, 'own-claim', 'reason is own-claim');
    assert.equal(egress.sent.length, 1, 'no additional POST for rejected Resolve');

    // Resolve(paid: true) by bob ends Settled with no second POST.
    const resolveAlice1 = await rt.dispatch(id1, 'Resolve', { paid: true }, { credentials: { principal: 'bob' } });
    await settle(rt);
    assert.equal(resolveAlice1.stepKind, 'accepted', `Resolve accepted; got ${resolveAlice1.stepKind}`);

    state = (await rt.getState(id1)).state;
    assert.equal(state.status, 'Settled', `expected Settled after Resolve(paid: true); got ${state.status}`);
    assert.equal(egress.sent.length, 1, 'no second POST for Resolve emission');

    // Second held claim: another claim that ends Held.
    await rt.create('expenses.Expense', { id: 'held-2' });
    const id2 = 'held-2';

    const receiptId2 = await rt.putContent('Taxi from the airport, 150 euros.');
    await rt.dispatch(id2, 'Submit', { amount: 3, receipt: receiptId2 }, { credentials: { principal: 'alice' } });
    await settle(rt);

    await rt.dispatch(id2, 'Approve', {}, { credentials: { principal: 'bob' } });
    await settle(rt);

    // Second POST sent, also gets 503.
    assert.equal(egress.sent.length, 2, 'second POST for second claim');
    state = (await rt.getState(id2)).state;
    assert.equal(state.status, 'Held', `expected Held on second claim; got ${state.status}`);

    // Resolve(paid: false) by bob ends Failed with no second POST.
    const resolveFalse = await rt.dispatch(id2, 'Resolve', { paid: false }, { credentials: { principal: 'bob' } });
    await settle(rt);
    assert.equal(resolveFalse.stepKind, 'accepted', `Resolve(paid: false) accepted; got ${resolveFalse.stepKind}`);

    state = (await rt.getState(id2)).state;
    assert.equal(state.status, 'Failed', `expected Failed after Resolve(paid: false); got ${state.status}`);
    assert.equal(egress.sent.length, 2, 'no third POST for Resolve emission');

    // Resolve on a claim that is not held is rejected not-held.
    // Use a claim that is Submitted (not terminal, not Held): submitted and categorized but not approved.
    await rt.create('expenses.Expense', { id: 'submitted-1' });
    const id3 = 'submitted-1';

    const receiptId3 = await rt.putContent('Taxi from the airport, 150 euros.');
    await rt.dispatch(id3, 'Submit', { amount: 3, receipt: receiptId3 }, { credentials: { principal: 'alice' } });
    await settle(rt);

    // Claim is Submitted (categorized, not yet approved), not Held.
    state = (await rt.getState(id3)).state;
    assert.equal(state.status, 'Submitted', `expected Submitted; got ${state.status}`);

    // Resolve on Submitted claim is rejected not-held (claim is not Held).
    const rejNotHeld = await rt.dispatch(id3, 'Resolve', { paid: true }, { credentials: { principal: 'bob' } });
    await settle(rt);
    assert.equal(rejNotHeld.stepKind, 'rejected', 'Resolve on non-held claim is rejected');
    assert.equal(rejNotHeld.rejectReason, 'not-held', 'reason is not-held');
    assert.equal(egress.sent.length, 2, 'no additional POST for not-held rejection');
  } finally {
    await rt.close();
  }
});

test('expense-approval: refused payment - service answers 422, claim ends Failed after one POST', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedExpenses, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();

  // Service answers 422 (permanent error) on the payment.
  const egress = recordingEgress(() => ({ status: 422, headers: {}, body: {} }));

  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const provider = recordedExpenses(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payroll.pay', handlers.pay);

    await rt.create('expenses.Expense', { id: 'refused' });
    const id = 'refused';

    // Alice submits 3 units (taxi).
    const receiptId = await rt.putContent('Taxi from the airport, 150 euros.');
    await rt.dispatch(id, 'Submit', { amount: 3, receipt: receiptId }, { credentials: { principal: 'alice' } });
    await settle(rt);

    // Bob approves.
    await rt.dispatch(id, 'Approve', {}, { credentials: { principal: 'bob' } });
    await settle(rt);

    // One POST sent, with 422 response (permanent error, not retried).
    assert.equal(egress.sent.length, 1, 'one POST sent for 422 error');
    const req = egress.sent[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, 'https://payroll.example/v1/reimbursements');
    assert.deepEqual(req.body, { euros: 150 });

    // Claim is Failed (payroll service refused the payment).
    const state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Failed', `expected Failed after 422; got ${state.status}`);

    // No additional POSTs sent.
    assert.equal(egress.sent.length, 1, 'no retry or second POST');
  } finally {
    await rt.close();
  }
});

test('expense-approval: journal replays with no divergence', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedExpenses, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const provider = recordedExpenses(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('payroll.pay', handlers.pay);

    await rt.create('expenses.Expense', { id: 'exp-replay' });
    const id = 'exp-replay';

    // Run a simple scenario.
    const receiptId = await rt.putContent('Taxi from the airport, 150 euros.');
    await rt.dispatch(id, 'Submit', { amount: 3, receipt: receiptId }, { credentials: { principal: 'alice' } });
    await settle(rt);
    await rt.dispatch(id, 'Approve', {}, { credentials: { principal: 'bob' } });
    await settle(rt);

    // Replay the runtime.
    const replays = await replayRuntime(rt);
    for (const r of replays) {
      assert.deepEqual([r.diagnostics, r.notRun ?? null, r.gateNotRun], [[], null, 0], `divergence in ${r.machine}: ${JSON.stringify(r.diagnostics)}`);
    }

    // Check that expenses.Expense is among the replayed machines.
    const kinds = new Set(replays.map((x) => x.machine));
    assert.ok(kinds.has('expenses.Expense'), `expenses.Expense should be in replayed machines; got ${[...kinds].join(', ')}`);

    // Replay sessions (decisions and policies).
    const sessions = await replaySessions(rt);
    assert.ok(sessions.length > 0, 'there are gate sessions to replay (policy gates the pay effect)');
    for (const s of sessions) {
      assert.deepEqual([s.diagnostics.length, s.notRun.length], [0, 0], `session divergence: ${JSON.stringify(s.diagnostics)}`);
    }

    console.log(`replay: ${replays.length} runs, ${replays.reduce((n, x) => n + x.rows, 0)} rows; ${sessions.length} gate sessions; divergences: ${replays.reduce((n, x) => n + x.diagnostics.length, 0) + sessions.reduce((n, s) => n + s.diagnostics.length, 0)}`);
  } finally {
    await rt.close();
  }
});
