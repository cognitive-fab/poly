// Research-agents example tests: light checks (node:test).
// The tests are written from docs/examples/research-agents.md alone, before any code exists.
// Rule 7a: The tests verify the spec without reading the program files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { checkExample, expectedOf, mismatch } from './examples-expected.mjs';

const EX_DIR = join(ROOT, 'examples', 'research-agents');
const PROGRAM = join(EX_DIR, 'research-agents.poly');
const DEFECT = join(EX_DIR, 'research-agents-defect.poly');

// ── light checks ──

test('the program, checked with its policy, is CLEAN with instances printed', async () => {
  const report = await checkExample(PROGRAM, ROOT);
  const expected = expectedOf(PROGRAM);
  assert.ok(expected, 'the program\'s first line declares its expected verdict');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'CLEAN');
  // Verify that the policy is paired with the program (per spec).
  const policies = report.policies ?? [];
  assert.ok(policies.some((p) => p.scope === 'research'), 'the policy is paired with the program');
  // Verify the instances are printed: Planner, Worker, and configuration inquiry.
  const machines = report.machines ?? [];
  assert.deepEqual(machines.map((m) => m.machine).sort(), ['Planner', 'Worker', 'research.Budget'].sort().map((n) => n), 'the planner, the worker and the shared budget machine');
  const plannerMachine = machines.find((m) => m.machine === 'Planner');
  const workerMachine = machines.find((m) => m.machine === 'Worker');
  assert.ok(plannerMachine, 'Planner machine is present');
  assert.ok(workerMachine, 'Worker machine is present');
  assert.ok(plannerMachine.instance.states, 'Planner has states count');
  assert.ok(workerMachine.instance.states, 'Worker has states count');
  // Check the configuration.
  const configurations = report.configurations ?? [];
  assert.equal(configurations.length, 1, 'one configuration: inquiry');
  const config = configurations[0];
  assert.equal(config.configuration, 'inquiry', 'configuration is named inquiry');
  assert.ok(config.instance, 'configuration has instance');
  assert.equal(config.instance.states, 699, 'inquiry configuration has 699 global states');
  // Log the instances as the spec requires.
  console.log(`research-agents instances:`);
  console.log(`  Planner: ${plannerMachine.instance.states} states`);
  console.log(`  Worker: ${workerMachine.instance.states} states`);
  console.log(`  inquiry configuration: ${config.instance.states} global states`);
});

test('the defect is FINDINGS with exactly PL5401, the invariant answers-cite named, and a witness of 6 global steps', async () => {
  const report = await checkExample(DEFECT, ROOT);
  const expected = expectedOf(DEFECT);
  assert.ok(expected, 'the defect\'s first line declares expected FINDING PL5401');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'FINDINGS');
  // Find the PL5401 diagnostic (configuration invariant).
  const configurations = report.configurations ?? [];
  const allDiags = configurations.flatMap((c) => c.diagnostics ?? []);
  const pl5401 = allDiags.find((d) => d.code === 'PL5401');
  assert.ok(pl5401, `PL5401 not found; found: ${allDiags.map((d) => d.code).join(', ')}`);
  assert.equal(pl5401.name, 'CONFIGURATION_INVARIANT', 'the finding is a configuration invariant violation');
  assert.ok(pl5401.property, 'the property is named');
  assert.equal(pl5401.property, 'answers-cite', 'the property is answers-cite');
  // Check the witness: 6 global steps.
  assert.ok(pl5401.witness, 'the diagnostic has a witness');
  assert.equal(pl5401.witness.length, 6, `witness length is 6; got ${pl5401.witness.length}`);
  assert.equal(pl5401.witness.trace.length, 6, 'witness.trace.length === 6');
  // Verify the last step is an input Guess action.
  const lastStep = pl5401.witness.trace[5];
  assert.ok(lastStep.action, 'the last step has an action');
  assert.equal(lastStep.action, 'Guess', 'the last step is the Guess action');
});

test('poly check --host with root examples/research-agents is CLEAN', { timeout: 120_000 }, async () => {
  // The host check uses host/tsconfig.json at the example root.
  const hostTsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  const { commandNamed } = await import('@poly/check');
  const r = await commandNamed('check').run({ target: PROGRAM, root: EX_DIR, host: hostTsConfig });
  assert.equal(r.result.verdict, 'CLEAN', JSON.stringify(r.result.host?.diagnostics));
  assert.equal(r.result.host.status, 'ran');
  assert.deepEqual(r.result.host.diagnostics, []);
});

test('startInquiry: dispatches Wire(a, b) then Ask(question) using the runtime', async () => {
  const hostInquiry = await import(pathToFileURL(join(EX_DIR, 'host', 'inquiry.ts')).href);
  const { startInquiry } = hostInquiry;

  // Create a fake runtime that records dispatch calls.
  const calls = [];
  const fakeRt = {
    dispatch: async (id, action, payload) => {
      calls.push({ id, action, payload });
    },
    putContent: async (text) => `content-id-${Math.random().toString(36).slice(2)}`,
  };

  // Call startInquiry with planner and two worker ids.
  const plannerId = 'planner-1';
  const workerId1 = 'worker-1';
  const workerId2 = 'worker-2';
  const question = 'What is the capital of France?';

  await startInquiry(fakeRt, {
    planner: plannerId,
    workers: [workerId1, workerId2],
    question,
  });

  // Verify that Wire was dispatched first to each worker.
  assert.ok(calls.length >= 2, `expected at least 2 dispatches; got ${calls.length}`);
  const wireDispatches = calls.filter((c) => c.action === 'Wire');
  const askDispatches = calls.filter((c) => c.action === 'Ask');
  assert.ok(wireDispatches.length > 0, 'Wire should be dispatched at least once');
  assert.ok(askDispatches.length > 0, 'Ask should be dispatched at least once');
  // Wire calls should come before Ask calls.
  const firstWire = calls.findIndex((c) => c.action === 'Wire');
  const firstAsk = calls.findIndex((c) => c.action === 'Ask');
  assert.ok(firstWire >= 0 && firstAsk >= 0 && firstWire < firstAsk, 'Wire should be dispatched before Ask');
});

test('the recorded provider: each decision answers its fixture; an unknown item throws; asked records decision and items without body', async () => {
  const hostRecorded = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const { loadAnswers, recordedResearch, provideRecorded } = hostRecorded;

  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));
  assert.ok(answers.models, 'answers has models');
  assert.ok(answers.documents, 'answers has documents');
  assert.ok(Array.isArray(answers.documents), 'documents is an array');
  assert.ok(answers.documents.length === 3, 'fixture has 3 documents');
  assert.ok(answers.plan, 'answers has plan');
  assert.ok(answers.research, 'answers has research');

  const recorded = recordedResearch(answers);
  assert.ok(recorded.asked, 'recorded.asked is present');
  assert.ok(Array.isArray(recorded.asked), 'recorded.asked is an array');
  assert.ok(recorded.decisions, 'recorded.decisions is present');

  // Test plan decision.
  const planDec = recorded.decisions.plan;
  assert.ok(planDec, 'plan decision provider exists');
  const planMaterials = { bodies: {}, items: {} };
  const planCall = { decision: 'plan', payload: {} };
  const planResult = planDec.provider(planCall, planMaterials);
  assert.equal(planResult.answer, answers.plan.focus, 'plan answers with the fixture focus');
  assert.ok(Array.isArray(planResult.distribution), 'plan distribution is an array');

  // Test research decision with items.
  const researchDec = recorded.decisions.research;
  assert.ok(researchDec, 'research decision provider exists');
  const docIds = answers.documents.map((d) => d.id);
  const researchMaterials = { bodies: {}, items: docIds.map((id) => ({ id })) };
  const researchCall = { decision: 'research', payload: {} };
  const researchResult = researchDec.provider(researchCall, researchMaterials);
  assert.equal(researchResult.answer, answers.research.text, 'research answers with the fixture text');
  assert.ok(Array.isArray(researchResult.cites), 'research cites is an array');
  assert.deepEqual(researchResult.cites, docIds, 'research cites the document ids it was given');

  // Test that research with an unknown item throws.
  const unknownMaterials = { bodies: {}, items: [{ id: 'unknown-doc' }] };
  assert.throws(() => {
    researchDec.provider(researchCall, unknownMaterials);
  }, /unknown|not.*recorded/i, 'research throws for an unknown item');

  // Test that asked records decision and items, not text.
  for (const entry of recorded.asked) {
    assert.ok('decision' in entry, 'asked entry has decision');
    // plan records only its decision (the spec); research records the ids it was given.
    if (entry.decision === 'research') assert.ok(Array.isArray(entry.items) && entry.items.length > 0, 'a research entry has its items');
    assert.ok(!('text' in entry), 'asked entry does NOT have text');
    assert.ok(!('body' in entry), 'asked entry does NOT have body');
  }
});
