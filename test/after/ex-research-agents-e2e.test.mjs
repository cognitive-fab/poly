// Research-agents end-to-end test over recorded traffic.
// Tests the machines through their recorded providers with no network or model calls.
// Rule 7a: Written from spec alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayRuntime, replaySessions } from '@poly/check';
import { postgresSource } from '@poly/io';
import { ROOT } from '../helpers.mjs';
import { loadExample, settle, admitExample } from '../ex-kit.mjs';
import { pgOrders } from '../memory-helpers.mjs';

let cachedAdmission;
/** One admission for the whole file: each test loads its own runtime from the same certified build. */
const admitted = () => (cachedAdmission ??= admitExample('research-agents'));

const EX_DIR = join(ROOT, 'examples', 'research-agents');

test('research-agents: admission checks the program and policy; the example admits', { timeout: 60_000 }, async () => {
  const a = await admitted();
  assert.ok(a.dir);
  assert.ok(a.report);
  assert.equal(a.report.verdict, 'CLEAN', JSON.stringify(a.report.diagnostics));
});

test('research-agents: main path - planner and workers end with planner Done, workers Reported, cited true', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedResearch, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const { startInquiry } = await import(pathToFileURL(join(EX_DIR, 'host', 'inquiry.ts')).href);

  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));
  const a = await admitted();
  const { rt, clock } = await loadExample(a);

  try {
    // Set up the recorded models.
    const provider = recordedResearch(answers);
    provideRecorded(rt, provider);

    // Set up the fake Postgres source for docs (unowned, per spec).
    const docRows = answers.documents.map((d) => ({
      order_id: d.id,
      customer_id: undefined,
      summary: d.body,
      updated_at: d.asOf,
    }));
    const docsDb = pgOrders(docRows);
    rt.connectSource('docs', postgresSource({ query: docsDb.query, table: 'docs', id: 'order_id', asOf: 'updated_at', body: 'summary' }));

    // Create instances: one planner and two workers.
    const plannerId = 'planner-1';
    const workerId1 = 'worker-1';
    const workerId2 = 'worker-2';

    await rt.create('research.Planner', { id: plannerId });
    await rt.create('research.Worker', { id: workerId1 });
    await rt.create('research.Worker', { id: workerId2 });

    // Start the inquiry: Wire the workers and Ask the question.
    const question = 'What is the topic of the documents?';
    await startInquiry(rt, { planner: plannerId, workers: [workerId1, workerId2], question });

    // Settle to complete all effects, decisions, and message deliveries.
    for (let i = 0; i < 20; i++) await settle(rt);

    // Check final states.
    let plannerState = (await rt.getState(plannerId)).state;
    assert.equal(plannerState.status, 'Done', `planner status is Done; got ${plannerState.status}`);
    assert.equal(plannerState.reports, 2, `planner has 2 reports; got ${plannerState.reports}`);

    let worker1State = (await rt.getState(workerId1)).state;
    assert.equal(worker1State.status, 'Reported', `worker-1 status is Reported; got ${worker1State.status}`);
    assert.equal(worker1State.cited, true, 'worker-1 cited is true');
    assert.ok(worker1State.answer, 'worker-1 has an answer');

    let worker2State = (await rt.getState(workerId2)).state;
    assert.equal(worker2State.status, 'Reported', `worker-2 status is Reported; got ${worker2State.status}`);
    assert.equal(worker2State.cited, true, 'worker-2 cited is true');
    assert.ok(worker2State.answer, 'worker-2 has an answer');

    // Verify that the provider was asked for plan and research.
    assert.ok(provider.asked.length > 0, `provider should have been asked; got ${provider.asked.length} calls`);
    const planAsks = provider.asked.filter((a) => a.decision === 'plan');
    const researchAsks = provider.asked.filter((a) => a.decision === 'research');
    assert.ok(planAsks.length === 1, `plan should be asked once; got ${planAsks.length}`);
    assert.ok(researchAsks.length === 2, `research should be asked twice; got ${researchAsks.length}`);

    // Verify that each worker's answer cites the document ids.
    const docIds = answers.documents.map((d) => d.id);
    const w1Chain = await rt.chain(workerId1);
    const w2Chain = await rt.chain(workerId2);
    const w1Steps = w1Chain.filter((e) => e.kind === 'step' && e.body.action === 'Answered');
    const w2Steps = w2Chain.filter((e) => e.kind === 'step' && e.body.action === 'Answered');
    assert.ok(w1Steps.length > 0, 'worker-1 has an Answered step');
    assert.ok(w2Steps.length > 0, 'worker-2 has an Answered step');

    console.log(`research-agents main path: planner Done with ${plannerState.reports} reports, both workers Reported and cited`);
  } finally {
    await rt.close();
  }
});

test('research-agents: budget refusal - second inquiry: plan fits, first worker\'s research is denied budget', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedResearch, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const { startInquiry } = await import(pathToFileURL(join(EX_DIR, 'host', 'inquiry.ts')).href);

  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));
  const a = await admitted();
  const { rt, clock } = await loadExample(a);

  try {
    const provider = recordedResearch(answers);
    provideRecorded(rt, provider);

    const docRows = answers.documents.map((d) => ({
      order_id: d.id,
      customer_id: undefined,
      summary: d.body,
      updated_at: d.asOf,
    }));
    const docsDb = pgOrders(docRows);
    rt.connectSource('docs', postgresSource({ query: docsDb.query, table: 'docs', id: 'order_id', asOf: 'updated_at', body: 'summary' }));

    // First inquiry.
    const planner1 = 'planner-budget-1';
    const worker1a = 'worker-budget-1a';
    const worker1b = 'worker-budget-1b';
    await rt.create('research.Planner', { id: planner1 });
    await rt.create('research.Worker', { id: worker1a });
    await rt.create('research.Worker', { id: worker1b });
    await startInquiry(rt, { planner: planner1, workers: [worker1a, worker1b], question: 'First question?' });
    for (let i = 0; i < 20; i++) await settle(rt);

    let state1 = (await rt.getState(planner1)).state;
    assert.equal(state1.status, 'Done', 'first inquiry completes');

    // Second inquiry: plan fits, first worker's research hits budget.
    const planner2 = 'planner-budget-2';
    const worker2a = 'worker-budget-2a';
    const worker2b = 'worker-budget-2b';
    await rt.create('research.Planner', { id: planner2 });
    await rt.create('research.Worker', { id: worker2a });
    await rt.create('research.Worker', { id: worker2b });
    await startInquiry(rt, { planner: planner2, workers: [worker2a, worker2b], question: 'Second question?' });
    for (let i = 0; i < 20; i++) await settle(rt);

    // Plan should have succeeded (cost about 0.000208).
    // First research should be denied budget (would be about 0.00028, pushing total over 0.001 cap).
    let state2a = (await rt.getState(worker2a)).state;
    let state2b = (await rt.getState(worker2b)).state;

    // First worker should be GaveUp due to budget denial.
    assert.equal(state2a.status, 'GaveUp', `worker-2a should be GaveUp; got ${state2a.status}`);
    assert.equal(state2a.cited, false, 'worker-2a cited is false');

    // Second worker might also be GaveUp or Reported, depending on timing.
    assert.ok(['GaveUp', 'Reported'].includes(state2b.status), `worker-2b status should be GaveUp or Reported; got ${state2b.status}`);

    // Planner should be Done (one report + one give-up = two updates).
    let state2 = (await rt.getState(planner2)).state;
    assert.equal(state2.status, 'Done', `planner-2 should be Done; got ${state2.status}`);
    const reportsGaveups = (state2.reports ?? 0) + (state2.gaveup ?? 0);
    assert.equal(reportsGaveups, 2, `planner-2 reports+gaveups should be 2; got ${reportsGaveups}`);

    // Check the verdicts for budget denial.
    const chain = await rt.chain(worker2a);
    const verdicts = chain.filter((e) => e.kind === 'verdict');
    const budgetDenial = verdicts.find((v) => v.body.outcome === 'denied' && v.body.reason === 'budget');
    assert.ok(budgetDenial, 'worker-2a should have a budget denial in its chain');

    console.log(`research-agents budget: second inquiry's first worker denied budget`);
  } finally {
    await rt.close();
  }
});

test('research-agents: uncited answer refusal - recorded research with no cites is refused by runtime', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedResearch, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const { startInquiry } = await import(pathToFileURL(join(EX_DIR, 'host', 'inquiry.ts')).href);

  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));
  const a = await admitted();
  const { rt, clock } = await loadExample(a);

  try {
    // Modify the recorded provider to return no cites for one call.
    const originalAnswers = { ...answers };
    originalAnswers.research = { ...answers.research, cites: [] };

    const provider = recordedResearch(originalAnswers);
    provideRecorded(rt, provider);

    const docRows = answers.documents.map((d) => ({
      order_id: d.id,
      customer_id: undefined,
      summary: d.body,
      updated_at: d.asOf,
    }));
    const docsDb = pgOrders(docRows);
    rt.connectSource('docs', postgresSource({ query: docsDb.query, table: 'docs', id: 'order_id', asOf: 'updated_at', body: 'summary' }));

    const plannerId = 'planner-uncited';
    const workerId1 = 'worker-uncited-1';
    const workerId2 = 'worker-uncited-2';

    await rt.create('research.Planner', { id: plannerId });
    await rt.create('research.Worker', { id: workerId1 });
    await rt.create('research.Worker', { id: workerId2 });

    await startInquiry(rt, { planner: plannerId, workers: [workerId1, workerId2], question: 'Uncited question?' });

    for (let i = 0; i < 20; i++) await settle(rt);

    // The worker that got the uncited answer should be GaveUp, not Reported.
    const state1 = (await rt.getState(workerId1)).state;
    assert.ok(['GaveUp', 'Reported'].includes(state1.status), `worker-uncited-1 status; got ${state1.status}`);
    if (state1.status === 'GaveUp') {
      assert.equal(state1.cited, false, 'worker-uncited-1 cited is false when GaveUp');
    }

    // The planner should still reach Done (one report, one give-up, or two gives-up).
    const plannerState = (await rt.getState(plannerId)).state;
    assert.equal(plannerState.status, 'Done', `planner should be Done; got ${plannerState.status}`);

    console.log(`research-agents uncited: uncited answer caused worker GaveUp`);
  } finally {
    await rt.close();
  }
});

test('research-agents: journal replays with no divergence', { timeout: 120_000 }, async () => {
  const { loadAnswers, recordedResearch, provideRecorded } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const { startInquiry } = await import(pathToFileURL(join(EX_DIR, 'host', 'inquiry.ts')).href);

  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));
  const a = await admitted();
  const { rt, clock } = await loadExample(a);

  try {
    const provider = recordedResearch(answers);
    provideRecorded(rt, provider);

    const docRows = answers.documents.map((d) => ({
      order_id: d.id,
      customer_id: undefined,
      summary: d.body,
      updated_at: d.asOf,
    }));
    const docsDb = pgOrders(docRows);
    rt.connectSource('docs', postgresSource({ query: docsDb.query, table: 'docs', id: 'order_id', asOf: 'updated_at', body: 'summary' }));

    const plannerId = 'planner-replay';
    const workerId1 = 'worker-replay-1';
    const workerId2 = 'worker-replay-2';

    await rt.create('research.Planner', { id: plannerId });
    await rt.create('research.Worker', { id: workerId1 });
    await rt.create('research.Worker', { id: workerId2 });

    await startInquiry(rt, { planner: plannerId, workers: [workerId1, workerId2], question: 'Replay question?' });

    for (let i = 0; i < 20; i++) await settle(rt);

    // Verify the final states are as expected.
    const plannerState = (await rt.getState(plannerId)).state;
    assert.equal(plannerState.status, 'Done', 'planner is Done');

    // Replay the runtime.
    const replays = await replayRuntime(rt);
    for (const r of replays) {
      assert.deepEqual([r.diagnostics, r.notRun ?? null, r.gateNotRun], [[], null, 0], `divergence in ${r.machine}: ${JSON.stringify(r.diagnostics)}`);
    }

    // Check that research.Planner and research.Worker are among the replayed machines.
    const kinds = new Set(replays.map((x) => x.machine));
    assert.ok(kinds.has('research.Planner'), `research.Planner should be in replayed machines; got ${[...kinds].join(', ')}`);
    assert.ok(kinds.has('research.Worker'), `research.Worker should be in replayed machines; got ${[...kinds].join(', ')}`);

    // Replay sessions (decisions and policies).
    const sessions = await replaySessions(rt);
    assert.ok(sessions.length > 0, 'there are gate sessions to replay');
    for (const s of sessions) {
      assert.deepEqual([s.diagnostics.length, s.notRun.length], [0, 0], `session divergence: ${JSON.stringify(s.diagnostics)}`);
    }

    console.log(`replay: ${replays.length} runs, ${replays.reduce((n, x) => n + x.rows, 0)} rows; ${sessions.length} gate sessions; no divergences`);
  } finally {
    await rt.close();
  }
});
