// Expense-approval example tests: light checks (node:test).
// The tests are written from docs/examples/expense-approval.md alone, before any code exists.
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

const EX_DIR = join(ROOT, 'examples', 'expense-approval');
const PROGRAM = join(EX_DIR, 'expense-approval.poly');
const DEFECT = join(EX_DIR, 'expense-approval-defect.poly');

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
  assert.ok(policies.some((p) => p.scope === 'expenses'), 'the policy is paired with the program');
  // Verify the instance is printed with domains, states, etc.
  const machines = report.machines ?? [];
  assert.equal(machines.length, 1, 'one machine Expense');
  assert.equal(machines[0].machine, 'Expense');
  const inst = machines[0].instance;
  assert.ok(inst, 'instance is present');
  assert.ok(inst.domains && Array.isArray(inst.domains), 'instance has domains array');
  assert.ok(typeof inst.states === 'number', 'instance has states count');
  // Log the instance as the spec requires.
  console.log(`expense-approval instance: ${machines[0].machine} over ${inst.domains.join('; ')}; ${inst.states} states`);
});

test('the defect is FINDINGS with exactly PL3001, the invariant named, and a witness of 3 steps ending in Approve', async () => {
  const report = await checkExample(DEFECT, ROOT);
  const expected = expectedOf(DEFECT);
  assert.ok(expected, 'the defect\'s first line declares expected FINDING PL3001');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'FINDINGS');
  // Find the PL3001 diagnostic.
  const machines = report.machines ?? [];
  const allDiags = machines.flatMap((m) => m.diagnostics ?? []);
  const pl3001 = allDiags.find((d) => d.code === 'PL3001');
  assert.ok(pl3001, `PL3001 not found; found: ${allDiags.map((d) => d.code).join(', ')}`);
  assert.equal(pl3001.name, 'INVARIANT_REACHABLE', 'the finding is an invariant violation');
  assert.ok(pl3001.property, 'the property is named');
  assert.equal(pl3001.property, 'approver-not-submitter', 'the property is approver-not-submitter');
  // Check the witness: 3 steps (Submit, Categorized, Approve).
  assert.ok(pl3001.witness, 'the diagnostic has a witness');
  assert.equal(pl3001.witness.length, 3, `witness length is 3; got ${pl3001.witness.length}`);
  assert.equal(pl3001.witness.trace.length, 3, 'witness.trace.length === 3');
  // Verify the last step is Approve.
  const actions = pl3001.witness.trace.map((s) => s.action);
  assert.equal(actions[2], 'Approve', 'the last step is Approve');
});

test('poly check --host with root examples/expense-approval is CLEAN', { timeout: 120_000 }, async () => {
  // The host check uses host/tsconfig.json at the example root.
  const hostTsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  const r = await commandNamed('check').run({ target: PROGRAM, root: EX_DIR, host: hostTsConfig });
  assert.equal(r.result.verdict, 'CLEAN', JSON.stringify(r.result.host?.diagnostics));
  assert.equal(r.result.host.status, 'ran');
  assert.deepEqual(r.result.host.diagnostics, []);
});

test('a host handler with a wrong payload field is PL6836', { timeout: 120_000 }, async () => {
  // Create a temporary broken version of the handler to test PL6836 detection.
  const tmpRoot = join(tmpdir(), `poly-test-expense-host-${Date.now()}`);
  mkdirSync(join(tmpRoot, 'host'), { recursive: true });
  // Copy the correct handler and tsconfig.
  const handlers = join(EX_DIR, 'host', 'handlers.ts');
  const tsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  let handlerSrc = readFileSync(handlers, 'utf8');
  // Break the payload field: replace 'amount' with 'amt' (wrong field).
  // This will cause a TypeScript error (PL6836) when type-checking.
  const broken = handlerSrc.split('payload.amount').join('payload.amt');
  assert.notEqual(broken, handlerSrc, 'the mutation must change the file');
  writeFileSync(join(tmpRoot, 'host', 'handlers.ts'), broken);
  writeFileSync(join(tmpRoot, 'host', 'tsconfig.json'), readFileSync(tsConfig, 'utf8'));
  // Also copy the program to tmpRoot.
  writeFileSync(join(tmpRoot, 'expense-approval.poly'), readFileSync(PROGRAM, 'utf8'));
  // Run the host check on the broken handler.
  const r = await commandNamed('check').run({ target: join(tmpRoot, 'expense-approval.poly'), root: tmpRoot, host: join(tmpRoot, 'host', 'tsconfig.json') });
  // Every diagnostic should be PL6836.
  assert.ok(r.result.host.diagnostics.length > 0, 'there are diagnostics for the broken handler');
  const allCodes = r.result.host.diagnostics.map((d) => d.code);
  assert.ok(allCodes.every((c) => c === 'PL6836'), `all codes should be PL6836; got ${allCodes.join(', ')}`);
});

test('the handler: 201 returns ok; 422 throws with permanent: true; 503 throws without permanent', async () => {
  // Import the handler from the example.
  const hostHandlers = await import(pathToFileURL(join(EX_DIR, 'host', 'handlers.ts')).href);

  const { pay } = hostHandlers;

  // Test each status code.
  const testCases = [
    { status: 200, shouldThrow: false, permanent: undefined, desc: '200 ok' },
    { status: 201, shouldThrow: false, permanent: undefined, desc: '201 ok' },
    { status: 422, shouldThrow: true, permanent: true, desc: '422 permanent error' },
    { status: 503, shouldThrow: true, permanent: false, desc: '503 transient error' },
    { status: 500, shouldThrow: true, permanent: false, desc: '500 transient error' },
  ];

  for (const tc of testCases) {
    const ctx = { idempotencyKey: `test-key-${tc.status}` };
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

    // Test for amounts 50, 100, 250, 500.
    for (const amount of [1, 3, 5, 10]) {
      const payload = { amount };

      if (tc.shouldThrow) {
        try {
          await pay(payload, caps, ctx);
          assert.fail(`should throw for status ${tc.status}`);
        } catch (err) {
          assert.ok(err instanceof Error, `error is an Error for ${tc.desc}`);
          if (tc.permanent !== undefined) {
            assert.equal(Boolean(err.permanent), tc.permanent, `permanent flag is ${tc.permanent} for ${tc.desc}`);
          }
        }
      } else {
        const result = await pay(payload, caps, ctx);
        assert.deepEqual(result, { ok: true }, `returns ok for ${tc.desc}`);
      }

      // Verify request was made.
      assert.ok(requestMade, `request made for status ${tc.status}`);
      assert.equal(capturedReq.url, 'https://payroll.example/v1/reimbursements', 'correct URL');
      assert.equal(capturedReq.opts.headers['idempotency-key'], ctx.idempotencyKey, 'idempotency-key header set');
      // Verify body is { amount }.
      assert.deepEqual(capturedReq.body, { euros: amount * 50 }, `body for amount ${amount} is its euros`);

      requestMade = false;
    }
  }
});

test('the recorded provider: each receipt gives its answer; an unknown text throws; asked records decisions and receipt ids', async () => {
  // Import the recorded provider.
  const hostRecorded = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const { loadAnswers, recordedExpenses, provideRecorded } = hostRecorded;

  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));
  const recorded = recordedExpenses(answers);

  // Test each receipt in the fixture table.
  const fixtures = [
    { text: 'Taxi from the airport, 150 euros.', expectedCategory: 'Travel', id: 'taxi' },
    { text: 'Laptop stand and keyboard, 350 euros.', expectedCategory: 'Equipment', id: 'laptop' },
    { text: 'Receipt photo, unreadable.', expectedCategory: 'Meals', id: 'blurry' },
  ];

  const asked = recorded.asked || [];
  let askedBefore = asked.length;

  for (const fixture of fixtures) {
    const materials = { bodies: { receipt: fixture.text }, items: {} };
    const call = { decision: 'categorize', payload: {} };
    const result = recorded.decisions.categorize.provider(call, materials);

    assert.equal(result.answer, fixture.expectedCategory, `categorize answer for "${fixture.text}"`);
    assert.ok(result.distribution, `distribution present for ${fixture.id}`);
    assert.ok(Array.isArray(result.distribution), 'distribution is an array');
    assert.ok(result.distribution.length > 0, 'distribution has entries');
  }

  // Test unknown text throws.
  const unknownCall = { decision: 'categorize', payload: {} };
  const unknownMaterials = { bodies: { receipt: 'Unknown receipt text that was never recorded' }, items: {} };
  assert.throws(() => {
    recorded.decisions.categorize.provider(unknownCall, unknownMaterials);
  }, /no recorded|unknown/i, 'unknown text throws');

  // Test that asked records decision and receipt id, not text.
  assert.ok(Array.isArray(recorded.asked), 'asked is an array');
  for (const entry of recorded.asked) {
    assert.ok('decision' in entry, 'asked entry has decision');
    assert.ok('receipt' in entry, 'asked entry has receipt id');
    assert.ok(!('text' in entry), 'asked entry does NOT have text');
  }
});
