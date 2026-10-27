// Claim-intake end-to-end test over recorded traffic.
// Tests the machine through its handlers and recorded tiers with no network or model calls.
// Rule 7a: Written from spec alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayRuntime, replaySessions } from '@poly/check';
import { ROOT } from '../helpers.mjs';
import { loadExample, recordingEgress, settle, admitExample } from '../ex-kit.mjs';
import { approvalFor } from '../runtime-helpers.mjs';

let cachedAdmission;
/** One admission for the whole file: each test loads its own runtime from the same certified build. */
const admitted = () => (cachedAdmission ??= admitExample('claim-intake'));

const EX_DIR = join(ROOT, 'examples', 'claim-intake');

test('claim-intake: admission checks the program and policy; the example admits', { timeout: 60_000 }, async () => {
  const a = await admitted();
  assert.ok(a.dir);
  assert.ok(a.report);
  assert.equal(a.report.verdict, 'CLEAN', JSON.stringify(a.report.diagnostics));
});

test('claim-intake: main path - rear-ended is classified by the small tier alone, Assigned with one POST carrying the queue auto', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedClaims, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    // Set up the decision provider.
    const provider = recordedClaims(answers);
    provideRecorded(rt, provider);

    // Set up the assign handler.
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('claims.assign', handlers.assign);

    // Create an instance.
    await rt.create('claims.Claim', { id: 'claim-rear-ended' });
    const id = 'claim-rear-ended';

    // File the claim with the rear-ended text.
    const contentId = await rt.putContent('Another car hit me from behind at the light.');
    await rt.dispatch(id, 'File', { description: contentId, fraud: false }, { credentials: { principal: 'claimant' } });
    await settle(rt);

    // Check the state: Classifying then Assigned (only small tier asked).
    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Assigned', `expected Assigned; got ${state.status}`);
    assert.equal(state.flagged, false, 'not flagged');
    assert.equal(state.sure, true, 'sure because small confidence is 0.97 >= 0.8');

    // Check the provider was asked only the small tier.
    const classifyAsks = provider.asked.filter((a) => a.decision === 'classify');
    assert.ok(classifyAsks.length > 0, `classify was asked; got ${classifyAsks.length} times`);
    const tiers = classifyAsks.map((a) => a.tier);
    assert.deepEqual(tiers, ['small'], `only small tier asked; got tiers ${tiers.join(', ')}`);

    // Check one POST was sent.
    assert.equal(egress.sent.length, 1, 'one POST sent');
    const req = egress.sent[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, 'https://claims.example/v1/queues');
    assert.ok(req.headers['idempotency-key'], 'idempotency-key header is set');
    // Body should be { queue: 'auto', flagged: false, claim: <id> }.
    assert.deepEqual(req.body, { queue: 'auto', flagged: false, claim: id });
  } finally {
    await rt.close();
  }
});

test('claim-intake: calibration and escalation - pipe-burst is unsure on small (0.60), escalates to large (0.90), then Assigned', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedClaims, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const provider = recordedClaims(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('claims.assign', handlers.assign);

    await rt.create('claims.Claim', { id: 'claim-pipe-burst' });
    const id = 'claim-pipe-burst';

    // File the claim with the pipe-burst text.
    const contentId = await rt.putContent('A pipe burst in the kitchen overnight.');
    await rt.dispatch(id, 'File', { description: contentId, fraud: false }, { credentials: { principal: 'claimant' } });
    await settle(rt);

    // Check the state: should have gone from Classifying through Review and back to Assigning and then Assigned.
    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Assigned', `expected Assigned; got ${state.status}`);
    assert.equal(state.sure, true, 'sure because large confidence is 0.90 >= 0.8');

    // Check the provider was asked both small and large tiers.
    const classifyAsks = provider.asked.filter((a) => a.decision === 'classify');
    const tiers = classifyAsks.map((a) => a.tier);
    assert.deepEqual(tiers, ['small', 'large'], `both tiers asked; got tiers ${tiers.join(', ')}`);

    // The journal's decision events record the calibrated confidence beside the raw one, and the map that made it (strengthened by
    // the implementer after the code existed: the writer's version only checked that a number was there). 
    const decisions = (await rt.chain(id)).filter((e) => e.kind === 'decision').map((e) => e.body);
    // A route records one decision event, for the tier that answered; the small tier's call is in `asked` and in the route's own run.
    assert.deepEqual(decisions.map((d) => [d.route, d.tier, d.tierIndex, d.raw]), [['classify', 'large', 1, 0.9]]);
    const [large] = decisions;
    assert.ok(large.conf >= 800, `the large tier's calibrated confidence ${large.conf} is at least 0.8`);
    assert.notEqual(large.conf, large.raw * 1000, 'the calibrated confidence is not the raw one');
    assert.equal(large.calibration.fittedFor, 'opus-2026-08');

    // Check one POST was sent.
    assert.equal(egress.sent.length, 1, 'one POST sent');
    const req = egress.sent[0];
    assert.deepEqual(req.body, { queue: 'home', flagged: false, claim: id });
  } finally {
    await rt.close();
  }
});

test('claim-intake: escalation to a person on low confidence - vague-loss is unsure on both tiers, ends Review, Decide assigns it', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedClaims, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const provider = recordedClaims(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('claims.assign', handlers.assign);

    await rt.create('claims.Claim', { id: 'claim-vague-loss' });
    const id = 'claim-vague-loss';

    // File the claim.
    const contentId = await rt.putContent('Something was damaged, I am not sure what.');
    await rt.dispatch(id, 'File', { description: contentId, fraud: false }, { credentials: { principal: 'claimant' } });
    await settle(rt);

    // Check the state: should be Review (both tiers are unsure).
    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Review', `expected Review; got ${state.status}`);
    assert.equal(state.sure, false, 'not sure because both tiers are unsure');

    // Check no POST was sent yet.
    assert.equal(egress.sent.length, 0, 'no POST sent before decision');

    // A person decides.
    await rt.dispatch(id, 'Decide', { category: 'Other' }, { credentials: { principal: 'adjuster' } });
    await settle(rt);

    // Check the state: should now be Assigned.
    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Assigned', `expected Assigned; got ${state.status}`);

    // Check one POST was sent.
    assert.equal(egress.sent.length, 1, 'one POST sent after decision');
    const req = egress.sent[0];
    assert.deepEqual(req.body, { queue: 'other', flagged: false, claim: id });
  } finally {
    await rt.close();
  }
});

test('claim-intake: escalation on a fraud flag - staged is classified but its assignment is escalated by the gate, then approval releases it', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedClaims, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const provider = recordedClaims(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('claims.assign', handlers.assign);

    await rt.create('claims.Claim', { id: 'claim-staged' });
    const id = 'claim-staged';

    // File the claim with fraud: true.
    const contentId = await rt.putContent('Rear-ended again, the same car as last month.');
    await rt.dispatch(id, 'File', { description: contentId, fraud: true }, { credentials: { principal: 'claimant' } });
    await settle(rt);

    // Check the state: should be Assigning (classified), but nothing should be assigned yet.
    let state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Assigning', `expected Assigning; got ${state.status}`);
    assert.equal(state.flagged, true, 'flagged is true');

    // No POST should have been sent (escalated by the gate).
    assert.equal(egress.sent.length, 0, 'no POST sent before approval');

    // Find the escalated intent in pr_outbox.
    const rows = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'claims.assign'").all(id);
    assert.ok(rows.length > 0, 'escalation recorded in outbox');
    const intentId = rows[0].intent_id;

    // Get approval for the intent and apply it.
    await rt.approve(await approvalFor(rt, intentId));
    await settle(rt);

    // Now one POST should have been sent.
    assert.equal(egress.sent.length, 1, 'one POST sent after approval');
    const req = egress.sent[0];
    assert.deepEqual(req.body, { queue: 'auto', flagged: true, claim: id });

    // Check the final state: Assigned.
    state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Assigned', `expected Assigned; got ${state.status}`);
  } finally {
    await rt.close();
  }
});

test('claim-intake: the journal replays with no divergence', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedClaims, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admitted();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports, verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const provider = recordedClaims(answers);
    provideRecorded(rt, provider);
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('claims.assign', handlers.assign);

    // Create and run a claim to completion.
    await rt.create('claims.Claim', { id: 'claim-replay' });
    const id = 'claim-replay';

    const contentId = await rt.putContent('Another car hit me from behind at the light.');
    await rt.dispatch(id, 'File', { description: contentId, fraud: false }, { credentials: { principal: 'claimant' } });
    await settle(rt);

    // Ensure the claim reached Assigned.
    const state = (await rt.getState(id)).state;
    assert.equal(state.status, 'Assigned', `expected Assigned; got ${state.status}`);

    // Replay the runtime: every run should fold through poly-ref's δ with no divergence.
    const replays = await replayRuntime(rt);
    for (const x of replays) {
      assert.deepEqual([x.run, x.diagnostics, x.notRun ?? null, x.gateNotRun], [x.run, [], null, 0], JSON.stringify(x));
    }

    // Verify that Claim machine is in the replays.
    const kinds = new Set(replays.map((x) => x.machine));
    assert.ok(kinds.has('claims.Claim'), `claims.Claim in ${[...kinds].join(', ')}`);
    assert.ok(kinds.has('claims.classify.Route'), `claims.classify.Route in ${[...kinds].join(', ')}`);

    // Replay gate sessions: they should have no divergence.
    const sessions = await replaySessions(rt);
    assert.ok(sessions.every((s) => s.diagnostics.length === 0 && s.notRun.length === 0), JSON.stringify(sessions.filter((s) => s.diagnostics.length || s.notRun.length)));

    console.log(`claim-intake replay: ${replays.length} runs with no divergence; ${sessions.length} gate sessions with no divergence`);
  } finally {
    await rt.close();
  }
});
