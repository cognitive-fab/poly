// Incident-oncall example tests: light checks (node:test).
// The tests are written from docs/examples/incident-oncall.md alone, before any code exists.
// Rule 7a: The tests verify the spec without reading the program files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandNamed } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { checkExample, expectedOf, mismatch } from './examples-expected.mjs';

const EX_DIR = join(ROOT, 'examples', 'incident-oncall');
const PROGRAM = join(EX_DIR, 'incident-oncall.poly');
const DEFECT = join(EX_DIR, 'incident-oncall-defect.poly');

// ── light checks ──

test('the program, checked with its policy, is CLEAN with its instance printed and liveness stage ran', async () => {
  const report = await checkExample(PROGRAM, ROOT);
  const expected = expectedOf(PROGRAM);
  assert.ok(expected, 'the program\'s first line declares its expected verdict');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'CLEAN');
  // Verify that the policy is paired with the program (per spec).
  const policies = report.policies ?? [];
  assert.ok(policies.some((p) => p.scope === 'oncall'), 'the policy is paired with the program');
  // Verify the instance is printed with domains, states, etc.
  const machines = report.machines ?? [];
  assert.equal(machines.length, 1, 'one machine Incident');
  assert.equal(machines[0].machine, 'Incident');
  const inst = machines[0].instance;
  assert.ok(inst, 'instance is present');
  assert.ok(inst.domains && Array.isArray(inst.domains), 'instance has domains array');
  assert.ok(typeof inst.states === 'number', 'instance has states count');
  // Verify the liveness stage ran and passed.
  const stages = machines[0].stages ?? [];
  const livenessStage = stages.find((s) => s.stage === 'liveness');
  assert.ok(livenessStage, 'liveness stage is present');
  assert.deepEqual([livenessStage.status, livenessStage.verdict], ['ran', 'CLEAN'], 'the liveness stage ran and is CLEAN');
  // Log the instance as the spec requires.
  console.log(`incident-oncall instance: ${machines[0].machine} over ${inst.domains.join('; ')}; ${inst.states} states`);
});

test('the defect is FINDINGS with exactly PL3301, the property named page-is-answered, and a witness of 7 steps', async () => {
  const report = await checkExample(DEFECT, ROOT);
  const expected = expectedOf(DEFECT);
  assert.ok(expected, 'the defect\'s first line declares expected FINDING PL3301');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'FINDINGS');
  // Find the PL3301 diagnostic.
  const machines = report.machines ?? [];
  const allDiags = machines.flatMap((m) => m.diagnostics ?? []);
  const pl3301 = allDiags.find((d) => d.code === 'PL3301');
  assert.ok(pl3301, `PL3301 not found; found: ${allDiags.map((d) => d.code).join(', ')}`);
  assert.equal(pl3301.name, 'LIVENESS_LASSO', 'the finding is a liveness lasso');
  assert.ok(pl3301.property, 'the property is named');
  assert.equal(pl3301.property, 'page-is-answered', 'the property is page-is-answered');
  // Check the witness: 7 steps (prefix of 3 plus cycle of 4).
  assert.ok(pl3301.witness, 'the diagnostic has a witness');
  assert.equal(pl3301.witness.length, 7, `witness length is 7; got ${pl3301.witness.length}`);
  assert.equal(pl3301.witness.trace.length, 7, 'witness.trace.length === 7');
  // Verify the first three steps of the prefix: Report, Triaged(High, ...), PageSent.
  const actions = pl3301.witness.trace.map((s) => s.action);
  assert.equal(actions[0], 'Report', 'first step is Report');
  assert.equal(actions[1], 'Triaged', 'second step is Triaged');
  assert.equal(actions[2], 'PageSent', 'third step is PageSent');
  // The last two steps should be Snooze and Wake in some order (as the cycle repeats).
  const lastTwo = actions.slice(5);
  assert.ok((lastTwo[0] === 'Snooze' && lastTwo[1] === 'Wake') || (lastTwo[0] === 'Wake' && lastTwo[1] === 'Snooze'), 'last two steps are Snooze and Wake in some order');
});

test('poly check --host with root examples/incident-oncall is CLEAN', { timeout: 120_000 }, async () => {
  // The host check uses host/tsconfig.json at the example root.
  const hostTsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  const r = await commandNamed('check').run({ target: PROGRAM, root: EX_DIR, host: hostTsConfig });
  assert.equal(r.result.verdict, 'CLEAN', JSON.stringify(r.result.host?.diagnostics));
  assert.equal(r.result.host.status, 'ran');
  assert.deepEqual(r.result.host.diagnostics, []);
});

test('a host handler with a wrong payload field is PL6836', { timeout: 120_000 }, async () => {
  // Create a temporary broken version of the handler to test PL6836 detection.
  const tmpRoot = join(tmpdir(), `poly-test-incident-host-${Date.now()}`);
  mkdirSync(join(tmpRoot, 'host'), { recursive: true });
  // Copy the correct handler and tsconfig.
  const handlers = join(EX_DIR, 'host', 'handlers.ts');
  const tsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  let handlerSrc = readFileSync(handlers, 'utf8');
  // Break the payload field: replace 'incident' with 'incidentId' (wrong field).
  // This will cause a TypeScript error (PL6836) when type-checking.
  const broken = handlerSrc.split('ctx.instanceId').join('ctx.incidentId');
  assert.notEqual(broken, handlerSrc, 'the mutation must change the file');
  writeFileSync(join(tmpRoot, 'host', 'handlers.ts'), broken);
  writeFileSync(join(tmpRoot, 'host', 'tsconfig.json'), readFileSync(tsConfig, 'utf8'));
  // Also copy the program to tmpRoot.
  writeFileSync(join(tmpRoot, 'incident-oncall.poly'), readFileSync(PROGRAM, 'utf8'));
  // Run the host check on the broken handler.
  const r = await commandNamed('check').run({ target: join(tmpRoot, 'incident-oncall.poly'), root: tmpRoot, host: join(tmpRoot, 'host', 'tsconfig.json') });
  // Every diagnostic should be PL6836.
  assert.ok(r.result.host.diagnostics.length > 0, 'there are diagnostics for the broken handler');
  const allCodes = r.result.host.diagnostics.map((d) => d.code);
  assert.ok(allCodes.every((c) => c === 'PL6836'), `all codes should be PL6836; got ${allCodes.join(', ')}`);
});

test('the handler page: 201 returns ok; 409 throws with permanent: true; 503 throws without permanent', async () => {
  // Import the handler from the example.
  const hostHandlers = await import(pathToFileURL(join(EX_DIR, 'host', 'handlers.ts')).href);

  const { page } = hostHandlers;

  // Test each status code.
  const testCases = [
    { status: 200, shouldThrow: false, permanent: undefined, desc: '200 ok' },
    { status: 201, shouldThrow: false, permanent: undefined, desc: '201 ok' },
    { status: 409, shouldThrow: true, permanent: true, desc: '409 permanent error' },
    { status: 503, shouldThrow: true, permanent: false, desc: '503 transient error' },
    { status: 500, shouldThrow: true, permanent: false, desc: '500 transient error' },
  ];

  for (const tc of testCases) {
    const ctx = { idempotencyKey: `test-key-${tc.status}`, instanceId: `incident-${tc.status}` };
    let requestMade = false;
    let capturedReq = null;

    // Create fake caps with a mutable post function.
    const caps = {
      egress: {
        post: async (url, body, opts) => {
          requestMade = true;
          capturedReq = { url, body, opts };
          return { status: tc.status, headers: {}, body: {} };
        },
      },
    };

    const payload = {};

    if (tc.shouldThrow) {
      let threw = false;
      try {
        await page(payload, caps, ctx);
        threw = false;
      } catch (err) {
        threw = true;
        assert.ok(err instanceof Error, `error is an Error for ${tc.desc}`);
        if (tc.permanent !== undefined) {
          assert.equal(Boolean(err.permanent), tc.permanent, `permanent flag is ${tc.permanent} for ${tc.desc}`);
        }
      }
      assert.ok(threw, `page must throw for status ${tc.status}`);
    } else {
      const result = await page(payload, caps, ctx);
      assert.deepEqual(result, { ok: true }, `returns ok for ${tc.desc}`);
    }

    // Verify request was made.
    assert.ok(requestMade, `request made for status ${tc.status}`);
    assert.equal(capturedReq.url, 'https://pager.example/v1/pages', 'correct URL');
    assert.equal(capturedReq.opts.headers['idempotency-key'], ctx.idempotencyKey, 'idempotency-key header set');
    // The body carries the incident id.
    assert.deepEqual(capturedReq.body, { incident: ctx.instanceId }, `body carries the instance id`);
  }
});

test('the handler escalate: 201 returns ok; 409 throws with permanent: true; 503 throws without permanent', async () => {
  // Import the handler from the example.
  const hostHandlers = await import(pathToFileURL(join(EX_DIR, 'host', 'handlers.ts')).href);

  const { escalate } = hostHandlers;

  // Test each status code.
  const testCases = [
    { status: 200, shouldThrow: false, permanent: undefined, desc: '200 ok' },
    { status: 201, shouldThrow: false, permanent: undefined, desc: '201 ok' },
    { status: 409, shouldThrow: true, permanent: true, desc: '409 permanent error' },
    { status: 503, shouldThrow: true, permanent: false, desc: '503 transient error' },
  ];

  for (const tc of testCases) {
    const ctx = { idempotencyKey: `test-key-${tc.status}`, instanceId: `incident-${tc.status}` };
    let requestMade = false;
    let capturedReq = null;

    const caps = {
      egress: {
        post: async (url, body, opts) => {
          requestMade = true;
          capturedReq = { url, body, opts };
          return { status: tc.status, headers: {}, body: {} };
        },
      },
    };

    const payload = {};

    if (tc.shouldThrow) {
      let threw = false;
      try {
        await escalate(payload, caps, ctx);
        threw = false;
      } catch (err) {
        threw = true;
        assert.ok(err instanceof Error, `error is an Error for ${tc.desc}`);
        if (tc.permanent !== undefined) {
          assert.equal(Boolean(err.permanent), tc.permanent, `permanent flag is ${tc.permanent} for ${tc.desc}`);
        }
      }
      assert.ok(threw, `escalate must throw for status ${tc.status}`);
    } else {
      const result = await escalate(payload, caps, ctx);
      assert.deepEqual(result, { ok: true }, `returns ok for ${tc.desc}`);
    }

    assert.ok(requestMade, `request made for status ${tc.status}`);
    assert.equal(capturedReq.url, 'https://pager.example/v1/escalations', 'correct URL');
    assert.equal(capturedReq.opts.headers['idempotency-key'], ctx.idempotencyKey, 'idempotency-key header set');
    assert.deepEqual(capturedReq.body, { incident: ctx.instanceId }, `body carries the instance id`);
  }
});

test('the recorded provider: each incident gives its answer; an unknown text throws', async () => {
  // Import the recorded provider.
  const hostRecorded = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const { loadAnswers, recordedIncidents, provideRecorded } = hostRecorded;

  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));
  const recorded = recordedIncidents(answers);

  // Test each incident in the fixture table.
  const fixtures = [
    { text: 'Primary database is down, all writes are failing.', expectedSeverity: 'High', id: 'db-down' },
    { text: 'There is a typo in the status page footer.', expectedSeverity: 'Low', id: 'footer-typo' },
    { text: 'Latency looks odd in one region, maybe.', expectedSeverity: 'High', id: 'odd-latency' },
  ];

  for (const fixture of fixtures) {
    const materials = { bodies: { report: fixture.text }, items: {} };
    const call = { decision: 'triage', payload: {} };
    const result = recorded.decisions.triage.provider(call, materials);

    assert.equal(result.answer, fixture.expectedSeverity, `triage answer for "${fixture.text}"`);
    assert.ok(result.distribution, `distribution present for ${fixture.id}`);
    assert.ok(Array.isArray(result.distribution), 'distribution is an array');
    assert.ok(result.distribution.length > 0, 'distribution has entries');
  }

  // Test unknown text throws.
  const unknownCall = { decision: 'triage', payload: {} };
  const unknownMaterials = { bodies: { report: 'Unknown incident text that was never recorded' }, items: {} };
  assert.throws(() => {
    recorded.decisions.triage.provider(unknownCall, unknownMaterials);
  }, /no recorded|unknown/i, 'unknown text throws');

  // Test that asked records decision and report id, not text.
  assert.ok(Array.isArray(recorded.asked), 'asked is an array');
  for (const entry of recorded.asked) {
    assert.ok('decision' in entry, 'asked entry has decision');
    assert.ok('report' in entry, 'asked entry has report id');
    assert.ok(!('text' in entry), 'asked entry does NOT have text');
  }
});
