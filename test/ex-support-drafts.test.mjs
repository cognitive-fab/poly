// support-drafts example tests: light checks (node:test).
// The tests are written from docs/examples/support-drafts.md alone, before any code exists.
// Rule 7a: The tests verify the spec without reading the program files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandNamed } from '@poly/check';
import { parse } from '@poly/lang';
import { decide, initialSigma, policyFacts, proposalTable } from '@poly/ref';
import { ROOT } from './helpers.mjs';
import { checkExample, expectedOf, mismatch } from './examples-expected.mjs';

const EX_DIR = join(ROOT, 'examples', 'support-drafts');
const PROGRAM = join(EX_DIR, 'support-drafts.poly');
const DEFECT = join(EX_DIR, 'support-drafts-defect.poly');
const POLICY = join(EX_DIR, 'support-drafts.policy.poly');
const DEFECT_POLICY = join(EX_DIR, 'support-drafts-defect.policy.poly');

// ── light checks ──

test('the program, checked with its policy, is CLEAN with its instance printed', async () => {
  const report = await checkExample(PROGRAM, ROOT);
  const expected = expectedOf(PROGRAM);
  assert.ok(expected, 'the program\'s first line declares its expected verdict');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'CLEAN');
  // Verify that the policy is paired with the program (per spec).
  const policies = report.policies ?? [];
  assert.ok(policies.some((p) => p.scope === 'drafts'), 'the policy is paired with the program');
  // Verify the instance is printed with domains, states, etc.
  const machines = report.machines ?? [];
  assert.equal(machines.length, 1, 'one machine Ticket');
  assert.equal(machines[0].machine, 'Ticket');
  const inst = machines[0].instance;
  assert.ok(inst, 'instance is present');
  assert.ok(inst.domains && Array.isArray(inst.domains), 'instance has domains array');
  assert.equal(typeof inst.states, 'number', 'instance has states count');
  assert.equal(inst.states, 1705, 'instance has 1705 states as per spec');
  // Log the instance as the spec requires.
  console.log(`support-drafts instance: ${machines[0].machine} over ${inst.domains.join('; ')}; ${inst.states} states`);
});

test('the defect with its policy is FINDINGS with exactly PL6503 and PL7001, each with a witness of 1 step', { timeout: 120_000 }, async () => {
  const report = await checkExample(DEFECT, ROOT);
  const expected = expectedOf(DEFECT);
  assert.ok(expected, 'the defect\'s first line declares expected FINDING PL6503 PL7001');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'FINDINGS');
  // Find the PL6503 and PL7001 diagnostics.
  const machines = report.machines ?? [];
  // The policy's findings (PL6503, PL7001) are in the report's own diagnostics; a machine's are in its report.
  const allDiags = [...(report.diagnostics ?? []), ...machines.flatMap((m) => m.diagnostics ?? [])];
  const pl6503 = allDiags.find((d) => d.code === 'PL6503');
  const pl7001 = allDiags.find((d) => d.code === 'PL7001');
  assert.ok(pl6503, `PL6503 not found; found: ${allDiags.map((d) => d.code).join(', ')}`);
  assert.ok(pl7001, `PL7001 not found; found: ${allDiags.map((d) => d.code).join(', ')}`);
  // Both should have a witness of 1 step.
  assert.ok(pl6503.witness, 'PL6503 has a witness');
  assert.equal(pl6503.witness.length, 1, `PL6503 witness length is 1; got ${pl6503.witness.length}`);
  assert.ok(pl7001.witness, 'PL7001 has a witness');
  assert.equal(pl7001.witness.length, 1, `PL7001 witness length is 1; got ${pl7001.witness.length}`);
});

test('the defect program with the program\'s own policy is CLEAN', { timeout: 120_000 }, async () => {
  // Create a temporary copy of the defect program with the program's policy.
  const tmpRoot = join(tmpdir(), `poly-test-support-defect-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
  // Copy the defect program and the program's policy (not the defect's policy).
  const defectSrc = readFileSync(DEFECT, 'utf8');
  const policySrc = readFileSync(POLICY, 'utf8');
  writeFileSync(join(tmpRoot, 'support-drafts-defect.poly'), defectSrc);
  writeFileSync(join(tmpRoot, 'support-drafts.policy.poly'), policySrc);
  // Run the check.
  const report = await checkExample(join(tmpRoot, 'support-drafts-defect.poly'), tmpRoot);
  assert.equal(report.verdict, 'CLEAN', JSON.stringify(report.diagnostics));
  console.log('the defect program checked with the program\'s policy is CLEAN (gate denies at runtime, check does not see the flow)');
});

test('the program\'s policy through poly-ref\'s decision table: decision.summary with owner taint is denied, with customer or public allowed', async () => {
  const programSrc = readFileSync(PROGRAM, 'utf8');
  const policySrc = readFileSync(POLICY, 'utf8');
  const program = parse(programSrc).module;
  const policyModule = parse(policySrc).module;
  assert.ok(program && policyModule);
  const scope = { scope: 'drafts', policies: policyModule.decls.filter((d) => d.kind === 'Policy') };
  const { rows } = proposalTable(scope, policyFacts([program]));
  const summary = rows.filter((x) => x.effect?.kind === 'decision.summary');
  const at = (cls) => summary.filter((x) => (x.effect?.taint?.class ?? null) === cls);
  assert.ok(at('owner').length && at('customer').length, `the table proposes decision.summary with owner and customer: ${JSON.stringify(summary.map((x) => x.effect?.taint ?? null))}`);
  // decision.summary with owner taint is denied.
  for (const row of at('owner')) {
    const d = decide(scope, initialSigma(scope), row);
    assert.equal(d.decision, 'deny', JSON.stringify(d));
    assert.ok(d.reasons.some((x) => x.includes('external-model-audience')), JSON.stringify(d.reasons));
  }
  // decision.summary with customer or public taint is allowed.
  for (const row of [...at('customer'), ...at('public')]) assert.equal(decide(scope, initialSigma(scope), row).decision, 'allow');
  // decision.summary with no taint is unknown to the rule, and denied.
  for (const row of at(null)) assert.equal(decide(scope, initialSigma(scope), row).decision, 'deny');
});

test('the program\'s policy through poly-ref\'s decision table: decision.write and decision.brief with owner taint are allowed', async () => {
  const programSrc = readFileSync(PROGRAM, 'utf8');
  const policySrc = readFileSync(POLICY, 'utf8');
  const program = parse(programSrc).module;
  const policyModule = parse(policySrc).module;
  assert.ok(program && policyModule);
  const scope = { scope: 'drafts', policies: policyModule.decls.filter((d) => d.kind === 'Policy') };
  const { rows } = proposalTable(scope, policyFacts([program]));
  const write = rows.filter((x) => x.effect?.kind === 'decision.write');
  const brief = rows.filter((x) => x.effect?.kind === 'decision.brief');
  const atOwner = (decisions) => decisions.filter((x) => (x.effect?.taint?.class ?? null) === 'owner');
  // decision.write with owner taint is allowed.
  for (const row of atOwner(write)) assert.equal(decide(scope, initialSigma(scope), row).decision, 'allow');
  // decision.brief with owner taint is allowed.
  for (const row of atOwner(brief)) assert.equal(decide(scope, initialSigma(scope), row).decision, 'allow');
});

test('the program\'s policy through poly-ref\'s decision table: helpdesk.createDraft is escalated', async () => {
  const programSrc = readFileSync(PROGRAM, 'utf8');
  const policySrc = readFileSync(POLICY, 'utf8');
  const program = parse(programSrc).module;
  const policyModule = parse(policySrc).module;
  assert.ok(program && policyModule);
  const scope = { scope: 'drafts', policies: policyModule.decls.filter((d) => d.kind === 'Policy') };
  const { rows } = proposalTable(scope, policyFacts([program]));
  const createDraft = rows.filter((x) => x.effect?.kind === 'helpdesk.createDraft');
  assert.ok(createDraft.length > 0, 'the table proposes helpdesk.createDraft');
  for (const row of createDraft) {
    const d = decide(scope, initialSigma(scope), row);
    assert.equal(d.decision, 'escalate', JSON.stringify(d));
    assert.ok(d.reasons.some((x) => x.includes('owner-approves-drafts')), JSON.stringify(d.reasons));
  }
});

test('poly check --host with root examples/support-drafts is CLEAN', { timeout: 120_000 }, async () => {
  // The host check uses host/tsconfig.json at the example root.
  const hostTsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  const r = await commandNamed('check').run({ target: PROGRAM, root: EX_DIR, host: hostTsConfig });
  assert.equal(r.result.verdict, 'CLEAN', JSON.stringify(r.result.host?.diagnostics));
  assert.equal(r.result.host.status, 'ran');
  assert.deepEqual(r.result.host.diagnostics, []);
});

test('a host handler with a wrong payload field is PL6836', { timeout: 120_000 }, async () => {
  // Create a temporary broken version of the handler to test PL6836 detection.
  const tmpRoot = join(tmpdir(), `poly-test-support-host-${Date.now()}`);
  mkdirSync(join(tmpRoot, 'host'), { recursive: true });
  // Copy the correct handler and tsconfig.
  const handlers = join(EX_DIR, 'host', 'handlers.ts');
  const tsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  let handlerSrc = readFileSync(handlers, 'utf8');
  // Break the payload field: replace 'body' with 'bod' (wrong field).
  // This will cause a TypeScript error (PL6836) when type-checking.
  const broken = handlerSrc.split('payload.body').join('payload.bod');
  assert.notEqual(broken, handlerSrc, 'the mutation must change the file');
  writeFileSync(join(tmpRoot, 'host', 'handlers.ts'), broken);
  writeFileSync(join(tmpRoot, 'host', 'tsconfig.json'), readFileSync(tsConfig, 'utf8'));
  // Also copy the program to tmpRoot.
  writeFileSync(join(tmpRoot, 'support-drafts.poly'), readFileSync(PROGRAM, 'utf8'));
  // Copy the policy.
  writeFileSync(join(tmpRoot, 'support-drafts.policy.poly'), readFileSync(POLICY, 'utf8'));
  // Run the host check on the broken handler.
  const r = await commandNamed('check').run({ target: join(tmpRoot, 'support-drafts.poly'), root: tmpRoot, host: join(tmpRoot, 'host', 'tsconfig.json') });
  // Every diagnostic should be PL6836.
  assert.ok(r.result.host.diagnostics.length > 0, 'there are diagnostics for the broken handler');
  const allCodes = r.result.host.diagnostics.map((d) => d.code);
  assert.ok(allCodes.every((c) => c === 'PL6836'), `all codes should be PL6836; got ${allCodes.join(', ')}`);
});

test('the handler: 200 and 201 return ok; 422 throws with permanent: true; 503 throws without permanent', async () => {
  // Import the handler from the example.
  const hostHandlers = await import(pathToFileURL(join(EX_DIR, 'host', 'handlers.ts')).href);
  const { createDraft } = hostHandlers;

  // Test each status code.
  const testCases = [
    { status: 200, shouldThrow: false, permanent: undefined, desc: '200 ok' },
    { status: 201, shouldThrow: false, permanent: undefined, desc: '201 ok' },
    { status: 422, shouldThrow: true, permanent: true, desc: '422 permanent error' },
    { status: 503, shouldThrow: true, permanent: false, desc: '503 ambiguous (not permanent)' },
    { status: 500, shouldThrow: true, permanent: false, desc: '500 ambiguous (not permanent)' },
  ];

  for (const tc of testCases) {
    const ctx = { idempotencyKey: `test-key-${tc.status}` };
    let requestMade = false;
    let capturedReq = null;

    // Create fake caps with a mutable post and content function.
    const caps = {
      egress: {
        post: async (url, body, opts) => {
          requestMade = true;
          capturedReq = { url, body, opts };
          return { status: tc.status, headers: {}, body: {} };
        },
      },
      content: {
        read: async (id) => `draft text for ${id}`,
      },
    };

    const payload = { body: 'content-id-123' };

    if (tc.shouldThrow) {
      let threw = true;
      try {
        await createDraft(payload, caps, ctx);
        threw = false;
      } catch (err) {
        assert.ok(err instanceof Error, `error is an Error for ${tc.desc}`);
        if (tc.permanent !== undefined) {
          assert.equal(Boolean(err.permanent), tc.permanent, `permanent flag is ${tc.permanent} for ${tc.desc}`);
        }
      }
      assert.ok(threw, `createDraft must throw for status ${tc.status}`);
    } else {
      const result = await createDraft(payload, caps, ctx);
      assert.deepEqual(result, { ok: true }, `returns ok for ${tc.desc}`);
    }

    // Verify request was made.
    assert.ok(requestMade, `request made for status ${tc.status}`);
    assert.equal(capturedReq.url, 'https://helpdesk.example/v1/drafts', 'correct URL');
    assert.equal(capturedReq.opts.headers['idempotency-key'], ctx.idempotencyKey, 'idempotency-key header set');
    // The body is the draft text.
    assert.deepEqual(capturedReq.body, { body: `draft text for content-id-123` }, `body contains draft text`);
  }
});

test('the recorded provider: each decision answers from the items it is given; an unknown item throws', async () => {
  // Import the recorded provider.
  const hostRecorded = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const { loadAnswers, recordedDrafts, provideRecorded } = hostRecorded;

  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));
  const recorded = recordedDrafts(answers);

  // Test that summary, write, and brief answer from items they are given.
  const fixture = answers.customers['owner-1'];
  assert.ok(fixture, 'owner-1 is in the fixture');
  // owner-1 has 2 tickets and 1 note.
  const ticketIds = answers.tickets.filter((t) => t.owner === 'owner-1').map((t) => t.id);
  const noteIds = answers.notes.filter((n) => n.owner === 'owner-1').map((n) => n.id);
  assert.equal(ticketIds.length, 2, 'owner-1 has 2 tickets');
  assert.equal(noteIds.length, 1, 'owner-1 has 1 note');

  // summary and write should answer from ticket items only.
  const ticketItems = ticketIds.map((id) => ({ id }));
  const summaryCall = { decision: 'summary', payload: {} };
  const summaryMaterials = { items: ticketItems };
  const summaryResult = recorded.decisions.summary.provider(summaryCall, summaryMaterials);
  assert.ok(summaryResult.answer, 'summary provider answers');
  assert.ok(!('body' in summaryResult), 'summary provider does not record a body');

  const writeCall = { decision: 'write', payload: {} };
  const writeMaterials = { items: ticketItems };
  const writeResult = recorded.decisions.write.provider(writeCall, writeMaterials);
  assert.ok(writeResult.answer, 'write provider answers');
  assert.ok(!('body' in writeResult), 'write provider does not record a body');
  assert.deepEqual(writeResult.cites, ticketIds, 'write cites the 2 ticket items it was given');

  // brief should answer from note items only.
  const noteItems = noteIds.map((id) => ({ id }));
  const briefCall = { decision: 'brief', payload: {} };
  const briefMaterials = { items: noteItems };
  const briefResult = recorded.decisions.brief.provider(briefCall, briefMaterials);
  assert.ok(briefResult.answer, 'brief provider answers');
  assert.ok(!('body' in briefResult), 'brief provider does not record a body');

  // Test that an unknown item throws.
  const unknownCall = { decision: 'summary', payload: {} };
  const unknownMaterials = { items: [{ id: 'unknown-ticket-id-that-was-never-recorded' }] };
  assert.throws(() => {
    recorded.decisions.summary.provider(unknownCall, unknownMaterials);
  }, /no recorded|unknown/i, 'unknown item throws');

  // Test that asked records decision and item ids, not bodies.
  assert.ok(Array.isArray(recorded.asked), 'asked is an array');
  for (const entry of recorded.asked) {
    assert.ok('decision' in entry, 'asked entry has decision');
    assert.ok('items' in entry, 'asked entry has items');
    assert.ok(!('body' in entry), 'asked entry does NOT have body');
  }
});
