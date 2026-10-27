// Appointment-booker example tests: light checks (node:test).
// The tests are written from docs/examples/appointment-booker.md alone, before any code exists.
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

const EX_DIR = join(ROOT, 'examples', 'appointment-booker');
const PROGRAM = join(EX_DIR, 'appointment-booker.poly');
const DEFECT = join(EX_DIR, 'appointment-booker-defect.poly');

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
  assert.ok(policies.some((p) => p.scope === 'booker'), 'the policy is paired with the program');
  // Verify the instance is printed with domains, states, etc.
  const machines = report.machines ?? [];
  assert.equal(machines.length, 1, 'one machine Calendar');
  assert.equal(machines[0].machine, 'Calendar');
  const inst = machines[0].instance;
  assert.ok(inst, 'instance is present');
  assert.ok(inst.domains && Array.isArray(inst.domains), 'instance has domains array');
  assert.ok(typeof inst.states === 'number', 'instance has states count');
  // Log the instance as the spec requires.
  console.log(`appointment-booker instance: ${machines[0].machine} over ${inst.domains.join('; ')}; ${inst.states} states`);
});

test('the defect is FINDINGS with exactly PL3002, the property named, and a witness of 6 steps', async () => {
  const report = await checkExample(DEFECT, ROOT);
  const expected = expectedOf(DEFECT);
  assert.ok(expected, 'the defect\'s first line declares expected FINDING PL3002');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'FINDINGS');
  // Find the PL3002 diagnostic.
  const machines = report.machines ?? [];
  const allDiags = machines.flatMap((m) => m.diagnostics ?? []);
  const pl3002 = allDiags.find((d) => d.code === 'PL3002');
  assert.ok(pl3002, `PL3002 not found; found: ${allDiags.map((d) => d.code).join(', ')}`);
  assert.equal(pl3002.name, 'STEP_PROPERTY', 'the finding is a step property');
  assert.ok(pl3002.property, 'the property is named');
  assert.equal(pl3002.property, 'free-slot-only', 'the property is free-slot-only');
  // Check the witness: 6 steps means witness.length === 6 (the spec lists: Ask, Parsed, Written, Reset, Ask, Parsed).
  assert.ok(pl3002.witness, 'the diagnostic has a witness');
  assert.equal(pl3002.witness.length, 6, `witness length is 6; got ${pl3002.witness.length}`);
  assert.equal(pl3002.witness.trace.length, 6, 'witness.trace.length === 6');
  // Verify the expected sequence: Ask, Parsed, Written, Reset, Ask, Parsed.
  const actions = pl3002.witness.trace.map((s) => s.action);
  assert.deepEqual(actions, ['Ask', 'Parsed', 'Written', 'Reset', 'Ask', 'Parsed']);
  // The last step is Parsed on the same slot (0, 0) with confidences 0.8.
  const lastStep = pl3002.witness.trace[5];
  assert.equal(lastStep.action, 'Parsed');
  assert.deepEqual(lastStep.data, { day: 0, hour: 0, dconf: 800, hconf: 800 });
});

test('poly check --host with root examples/appointment-booker is CLEAN', { timeout: 120_000 }, async () => {
  // The host check uses host/tsconfig.json at the example root.
  const hostTsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  const r = await commandNamed('check').run({ target: PROGRAM, root: EX_DIR, host: hostTsConfig });
  assert.equal(r.result.verdict, 'CLEAN', JSON.stringify(r.result.host?.diagnostics));
  assert.equal(r.result.host.status, 'ran');
  assert.deepEqual(r.result.host.diagnostics, []);
});

test('a host handler with a wrong payload field is PL6836', { timeout: 120_000 }, async () => {
  // Create a temporary broken version of the handler to test PL6836 detection.
  const tmpRoot = join(tmpdir(), `poly-test-appt-host-${Date.now()}`);
  mkdirSync(join(tmpRoot, 'host'), { recursive: true });
  // Copy the correct handler and tsconfig.
  const handlers = join(EX_DIR, 'host', 'handlers.ts');
  const tsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  let handlerSrc = readFileSync(handlers, 'utf8');
  // Break the payload field: replace 'slot' with 'slots' (wrong field).
  // This will cause a TypeScript error (PL6836) when type-checking.
  const broken = handlerSrc.split('payload.slot').join('payload.slots');
  assert.notEqual(broken, handlerSrc, 'the mutation must change the file');
  writeFileSync(join(tmpRoot, 'host', 'handlers.ts'), broken);
  writeFileSync(join(tmpRoot, 'host', 'tsconfig.json'), readFileSync(tsConfig, 'utf8'));
  // Also copy the program to tmpRoot.
  writeFileSync(join(tmpRoot, 'appointment-booker.poly'), readFileSync(PROGRAM, 'utf8'));
  // Run the host check on the broken handler.
  const r = await commandNamed('check').run({ target: join(tmpRoot, 'appointment-booker.poly'), root: tmpRoot, host: join(tmpRoot, 'host', 'tsconfig.json') });
  // Every diagnostic should be PL6836.
  assert.ok(r.result.host.diagnostics.length > 0, 'there are diagnostics for the broken handler');
  const allCodes = r.result.host.diagnostics.map((d) => d.code);
  assert.ok(allCodes.every((c) => c === 'PL6836'), `all codes should be PL6836; got ${allCodes.join(', ')}`);
});

test('the handler: 201 returns ok; 409 throws with permanent: true; 503 throws without permanent', async () => {
  // Import the handler and recorded provider from the example.
  const hostRecorded = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const hostHandlers = await import(pathToFileURL(join(EX_DIR, 'host', 'handlers.ts')).href);

  const { write } = hostHandlers;

  // Test each status code.
  const testCases = [
    { status: 200, shouldThrow: false, permanent: undefined, desc: '200 ok' },
    { status: 201, shouldThrow: false, permanent: undefined, desc: '201 ok' },
    { status: 409, shouldThrow: true, permanent: true, desc: '409 permanent error' },
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

    // Test for slots 0, 1, 2, 3 to verify day/hour extraction.
    for (const slot of [0, 1, 2, 3]) {
      const payload = { slot };

      if (tc.shouldThrow) {
        let threw = true;
        try {
          await write(payload, caps, ctx);
          threw = false;
        } catch (err) {
          assert.ok(err instanceof Error, `error is an Error for ${tc.desc}`);
          if (tc.permanent !== undefined) {
            assert.equal(Boolean(err.permanent), tc.permanent, `permanent flag is ${tc.permanent} for ${tc.desc}`);
          }
        }
        assert.ok(threw, `pay or write must throw for status ${tc.status}`);
      } else {
        const result = await write(payload, caps, ctx);
        assert.deepEqual(result, { ok: true }, `returns ok for ${tc.desc}`);
      }

      // Verify request was made.
      assert.ok(requestMade, `request made for status ${tc.status}`);
      assert.equal(capturedReq.url, 'https://calendar.example/v1/events', 'correct URL');
      assert.equal(capturedReq.opts.headers['idempotency-key'], ctx.idempotencyKey, 'idempotency-key header set');
      // Verify body is { day, hour } for the slot.
      const day = Math.floor(slot / 2);
      const hour = slot % 2;
      assert.deepEqual(capturedReq.body, { day, hour }, `body for slot ${slot} is {day: ${day}, hour: ${hour}}`);

      requestMade = false;
    }
  }
});

test('the recorded provider: each request of the table gives its answer; an unknown text throws; asked records ids not text', async () => {
  // Import the recorded provider.
  const hostRecorded = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const { loadAnswers, recordedBooker } = hostRecorded;

  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));
  const provider = recordedBooker(answers);

  // Test each request in the fixture table.
  const fixtures = [
    { text: 'Can I get Tuesday at nine?', expectedDay: 0, expectedHour: 0, id: 'tue-nine' },
    { text: 'Tuesday at nine please, for my sister.', expectedDay: 0, expectedHour: 0, id: 'tue-nine-again' },
    { text: 'Wednesday at ten works.', expectedDay: 1, expectedHour: 1, id: 'wed-ten' },
    { text: 'Sometime next week?', expectedDay: 1, expectedHour: 0, id: 'vague' },
  ];

  for (const fixture of fixtures) {
    const materials = { bodies: { text: fixture.text }, items: {} };
    const call = { decision: 'parse', payload: {} };
    const result = provider.decisions.parse.provider(call, materials);

    assert.equal(result.answer.day, fixture.expectedDay, `parse answer for "${fixture.text}"`);
    assert.equal(result.answer.hour, fixture.expectedHour, `parse answer for "${fixture.text}"`);
    assert.ok(result.distribution, `distribution present for ${fixture.id}`);
  }

  // Test unknown text throws.
  const unknownCall = { decision: 'parse', payload: {} };
  const unknownMaterials = { bodies: { text: 'Unknown text that was never recorded' }, items: {} };
  assert.throws(() => {
    provider.decisions.parse.provider(unknownCall, unknownMaterials);
  }, /no recorded|unknown/i, 'unknown text throws');

  // Test that asked records ids, not text.
  assert.ok(Array.isArray(provider.asked), 'asked is an array');
  for (const entry of provider.asked) {
    assert.ok('decision' in entry, 'asked entry has decision');
    assert.ok('request' in entry, 'asked entry has request id');
    assert.ok(!('text' in entry), 'asked entry does NOT have text');
  }
});
