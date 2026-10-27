// Claim-intake example tests: light checks (node:test).
// The tests are written from docs/examples/claim-intake.md alone, before any code exists.
// Rule 7a: The tests verify the spec without reading the program files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandNamed } from '@poly/check';
import { mapProblem } from '@poly/core';
import { ROOT } from './helpers.mjs';
import { checkExample, expectedOf, mismatch } from './examples-expected.mjs';

const EX_DIR = join(ROOT, 'examples', 'claim-intake');
const PROGRAM = join(EX_DIR, 'claim-intake.poly');
const DEFECT = join(EX_DIR, 'claim-intake-defect.poly');
const IGNORED = join(EX_DIR, 'claim-intake-ignored.poly');

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
  assert.ok(policies.some((p) => p.scope === 'claims'), 'the policy is paired with the program');
  // Verify the instance is printed for Claim, route, and budget.
  const machines = report.machines ?? [];
  const claim = machines.find((m) => m.machine === 'Claim');
  assert.ok(claim, 'machine Claim is present');
  assert.ok(claim.instance, 'Claim has instance');
  assert.ok(claim.instance.domains && Array.isArray(claim.instance.domains), 'Claim instance has domains array');
  assert.ok(typeof claim.instance.states === 'number', 'Claim instance has states count');
  // The route and budget are configurations.
  // A route and a budget are machines of their own in the report ('classify.Route', 'monthly.Budget').
  const route = report.machines.find((m) => m.machine === 'classify.Route');
  assert.ok(route && route.instance, 'route classify.Route is present, with its instance');
  const budget = report.machines.find((m) => m.machine === 'monthly.Budget');
  assert.ok(budget && budget.instance, 'budget monthly.Budget is present, with its instance');
  // Log the instance as the spec requires.
  console.log(`claim-intake instance: ${claim.machine} over ${claim.instance.domains.join('; ')}; ${claim.instance.states} states; route classify.Route; budget monthly.Budget`);
});

test('the calibration maps parse, have the right digest, and the right points', async () => {
  const small = readFileSync(join(EX_DIR, 'maps', 'classify-small.json'), 'utf8');
  const large = readFileSync(join(EX_DIR, 'maps', 'classify-large.json'), 'utf8');

  // Parse both maps.
  const smallMap = JSON.parse(small);
  const largeMap = JSON.parse(large);

  // Check the structure of each map.
  for (const [name, map] of [['small', smallMap], ['large', largeMap]]) {
    assert.equal(typeof map, 'object', `map ${name} is an object`);
    assert.equal(map.decision, 'classify', `map ${name} decision is classify`);
    assert.equal(map.version, 1, `map ${name} version is 1`);
    assert.ok(map.fittedFor, `map ${name} has fittedFor`);
    assert.ok(Array.isArray(map.points), `map ${name} has points array`);
    assert.ok(map.digest, `map ${name} has digest`);
  }

  // Verify digest is correct (mapProblem returns null when valid).
  const smallProblem = mapProblem(smallMap);
  assert.equal(smallProblem, null, `small map digest is correct; problem: ${smallProblem}`);
  const largeProblem = mapProblem(largeMap);
  assert.equal(largeProblem, null, `large map digest is correct; problem: ${largeProblem}`);

  // Verify the points for small.
  const smallPoints = smallMap.points;
  assert.deepEqual(smallPoints, [[0, 0], [1, 1], [100, 60], [300, 220], [500, 400], [800, 700], [950, 880]], 'small map has correct points');

  // Verify the points for large.
  const largePoints = largeMap.points;
  assert.deepEqual(largePoints, [[0, 0], [1, 1], [100, 90], [300, 290], [500, 500], [800, 820], [950, 960]], 'large map has correct points');
});

test('claim-intake-defect.poly is REFUSED with exactly PL1205', async () => {
  const report = await checkExample(DEFECT, ROOT);
  const expected = expectedOf(DEFECT);
  assert.ok(expected, 'the defect\'s first line declares expected REFUSED');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'REFUSED');
  // Find the PL1205 diagnostic.
  const machines = report.machines ?? [];
  // A refusal's diagnostic is the report's own (the type stage runs before any machine is checked).
  const allDiags = [...(report.diagnostics ?? []), ...machines.flatMap((m) => m.diagnostics ?? [])];
  const pl1205 = allDiags.find((d) => d.code === 'PL1205');
  assert.ok(pl1205, `PL1205 not found; found: ${allDiags.map((d) => d.code).join(', ')}`);
  assert.equal(pl1205.name, 'CONFIDENCE_NOT_COMPARED', 'the code is CONFIDENCE_NOT_COMPARED');
  // A refusal has no witness.
  assert.equal(pl1205.witness, undefined, 'the diagnostic has no witness (refusal)');
  // Verify only PL1205 is reported.
  const codes = allDiags.map((d) => d.code);
  assert.deepEqual(codes.sort(), ['PL1205'], `exactly PL1205; got ${codes.join(', ')}`);
});

test('claim-intake-ignored.poly is FINDINGS with exactly PL3002 and PL6201, each with a witness of 2 steps', async () => {
  const report = await checkExample(IGNORED, ROOT);
  const expected = expectedOf(IGNORED);
  assert.ok(expected, 'the ignored\'s first line declares expected FINDING');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'FINDINGS');
  // Find the diagnostics.
  const machines = report.machines ?? [];
  const allDiags = machines.flatMap((m) => m.diagnostics ?? []);
  const pl3002 = allDiags.find((d) => d.code === 'PL3002');
  const pl6201 = allDiags.find((d) => d.code === 'PL6201');
  assert.ok(pl3002, `PL3002 not found; found: ${allDiags.map((d) => d.code).join(', ')}`);
  assert.ok(pl6201, `PL6201 not found; found: ${allDiags.map((d) => d.code).join(', ')}`);
  // Verify names and properties.
  assert.equal(pl3002.name, 'STEP_PROPERTY', 'PL3002 is STEP_PROPERTY');
  assert.equal(pl3002.property, 'confident-or-person', 'PL3002 property is confident-or-person');
  assert.equal(pl6201.name, 'UNGATED_DECISION', 'PL6201 is UNGATED_DECISION');
  assert.equal(pl6201.property, 'classify', 'PL6201 property is classify');
  // Check the witnesses: each should have 2 steps.
  assert.ok(pl3002.witness, 'PL3002 has a witness');
  assert.equal(pl3002.witness.length, 2, `PL3002 witness length is 2; got ${pl3002.witness.length}`);
  assert.equal(pl3002.witness.trace.length, 2, 'PL3002 witness.trace.length === 2');
  assert.ok(pl6201.witness, 'PL6201 has a witness');
  assert.equal(pl6201.witness.length, 2, `PL6201 witness length is 2; got ${pl6201.witness.length}`);
  assert.equal(pl6201.witness.trace.length, 2, 'PL6201 witness.trace.length === 2');
  // Verify the second step is Classified in both witnesses.
  assert.equal(pl3002.witness.trace[1].action, 'Classified', 'PL3002 witness second step is Classified');
  assert.equal(pl6201.witness.trace[1].action, 'Classified', 'PL6201 witness second step is Classified');
  // Verify only these two codes are reported.
  const codes = allDiags.map((d) => d.code);
  assert.deepEqual(codes.sort(), ['PL3002', 'PL6201'], `exactly PL3002 and PL6201; got ${codes.join(', ')}`);
});

test('poly check --host with root examples/claim-intake is CLEAN', { timeout: 120_000 }, async () => {
  // The host check uses host/tsconfig.json at the example root.
  const hostTsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  const r = await commandNamed('check').run({ target: PROGRAM, root: EX_DIR, host: hostTsConfig });
  assert.equal(r.result.verdict, 'CLEAN', JSON.stringify(r.result.host?.diagnostics));
  assert.equal(r.result.host.status, 'ran');
  assert.deepEqual(r.result.host.diagnostics, []);
});

test('a host handler with a wrong payload field is PL6836', { timeout: 120_000 }, async () => {
  // Create a temporary broken version of the handler to test PL6836 detection.
  const tmpRoot = join(tmpdir(), `poly-test-claim-intake-host-${Date.now()}`);
  mkdirSync(join(tmpRoot, 'host'), { recursive: true });
  // Copy the correct handler and tsconfig.
  const handlers = join(EX_DIR, 'host', 'handlers.ts');
  const tsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  let handlerSrc = readFileSync(handlers, 'utf8');
  // Break the payload field: replace 'category' with 'cat' (wrong field).
  // This will cause a TypeScript error (PL6836) when type-checking.
  const broken = handlerSrc.split('payload.category').join('payload.cat');
  assert.notEqual(broken, handlerSrc, 'the mutation must change the file');
  writeFileSync(join(tmpRoot, 'host', 'handlers.ts'), broken);
  writeFileSync(join(tmpRoot, 'host', 'tsconfig.json'), readFileSync(tsConfig, 'utf8'));
  // Also copy the program to tmpRoot.
  writeFileSync(join(tmpRoot, 'claim-intake.poly'), readFileSync(PROGRAM, 'utf8'));
  // Run the host check on the broken handler.
  const r = await commandNamed('check').run({ target: join(tmpRoot, 'claim-intake.poly'), root: tmpRoot, host: join(tmpRoot, 'host', 'tsconfig.json') });
  // Every diagnostic should be PL6836.
  assert.ok(r.result.host.diagnostics.length > 0, 'there are diagnostics for the broken handler');
  const allCodes = r.result.host.diagnostics.map((d) => d.code);
  assert.ok(allCodes.every((c) => c === 'PL6836'), `all codes should be PL6836; got ${allCodes.join(', ')}`);
});

test('the handler: 201 returns ok; 422 throws with permanent: true; 503 throws without permanent', async () => {
  // Import the handler from the example.
  const hostHandlers = await import(pathToFileURL(join(EX_DIR, 'host', 'handlers.ts')).href);

  const { assign } = hostHandlers;

  // Test each status code.
  const testCases = [
    { status: 200, shouldThrow: false, permanent: undefined, desc: '200 ok' },
    { status: 201, shouldThrow: false, permanent: undefined, desc: '201 ok' },
    { status: 422, shouldThrow: true, permanent: true, desc: '422 permanent error' },
    { status: 503, shouldThrow: true, permanent: false, desc: '503 transient error' },
    { status: 500, shouldThrow: true, permanent: false, desc: '500 transient error' },
  ];

  for (const tc of testCases) {
    const ctx = { idempotencyKey: `test-key-${tc.status}`, instanceId: `claim-${tc.status}` };
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

    for (const category of ['Auto', 'Home', 'Medical', 'Other']) {
      for (const flagged of [false, true]) {
        const payload = { category, flagged };

        if (tc.shouldThrow) {
          let threw = false;
          try {
            await assign(payload, caps, ctx);
            threw = false;
          } catch (err) {
            threw = true;
            assert.ok(err instanceof Error, `error is an Error for ${tc.desc}`);
            if (tc.permanent !== undefined) {
              assert.equal(Boolean(err.permanent), tc.permanent, `permanent flag is ${tc.permanent} for ${tc.desc}`);
            }
          }
          assert.ok(threw, `assign must throw for status ${tc.status}`);
        } else {
          const result = await assign(payload, caps, ctx);
          assert.deepEqual(result, { ok: true }, `returns ok for ${tc.desc}`);
        }

        // Verify request was made.
        assert.ok(requestMade, `request made for status ${tc.status}`);
        assert.equal(capturedReq.url, 'https://claims.example/v1/queues', 'correct URL');
        assert.equal(capturedReq.opts.headers['idempotency-key'], ctx.idempotencyKey, 'idempotency-key header set');
        // The body should be { queue: <lower-case category>, flagged: <boolean>, claim: <instanceId> }.
        const expectedQueue = category.toLowerCase();
        assert.deepEqual(capturedReq.body, { queue: expectedQueue, flagged, claim: ctx.instanceId }, `body for category ${category}, flagged ${flagged}`);

        requestMade = false;
      }
    }
  }
});

test('the recorded tiers: each answer matches the fixture; an unknown text throws; asked records decision and tier, not text', async () => {
  // Import the recorded provider.
  const hostRecorded = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const { loadAnswers, recordedClaims, provideRecorded } = hostRecorded;

  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));
  const recorded = recordedClaims(answers);

  // Guard: the fixture must have both tiers and claims.
  assert.ok(recorded.tiers.small, 'small tier provider exists');
  assert.ok(recorded.tiers.large, 'large tier provider exists');
  assert.ok(Array.isArray(recorded.asked), 'asked is an array');

  // Test each claim in the fixture table.
  const fixtures = [
    { text: 'Another car hit me from behind at the light.', expectedCategory: 'Auto', expectedSmall: 0.97, expectedLarge: null, id: 'rear-ended' },
    { text: 'A pipe burst in the kitchen overnight.', expectedCategory: 'Home', expectedSmall: 0.60, expectedLarge: 0.90, id: 'pipe-burst' },
    { text: 'Something was damaged, I am not sure what.', expectedCategory: 'Other', expectedSmall: 0.50, expectedLarge: 0.55, id: 'vague-loss' },
    { text: 'Rear-ended again, the same car as last month.', expectedCategory: 'Auto', expectedSmall: 0.97, expectedLarge: null, id: 'staged' },
  ];

  const askedBefore = recorded.asked.length;

  for (const fixture of fixtures) {
    const materials = { bodies: { description: fixture.text }, items: {} };

    // Test small tier.
    const smallCall = { decision: 'classify', tier: 'small' };
    const smallResult = recorded.tiers.small(smallCall, materials);
    assert.equal(smallResult.answer, fixture.expectedCategory, `small tier answer for "${fixture.id}"`);
    assert.ok(smallResult.distribution, `small tier distribution present for ${fixture.id}`);
    assert.ok(Array.isArray(smallResult.distribution), 'distribution is an array');
    assert.ok(smallResult.distribution.length > 0, 'distribution has entries');
    // Find the probability of the expected answer.
    const smallProb = smallResult.distribution.find((d) => d[0] === fixture.expectedCategory)?.[1];
    assert.ok(Math.abs(smallProb - fixture.expectedSmall) < 0.001, `small tier probability for ${fixture.id} is ${fixture.expectedSmall}`);

    // Test large tier if expected.
    if (fixture.expectedLarge !== null) {
      const largeCall = { decision: 'classify', tier: 'large' };
      const largeResult = recorded.tiers.large(largeCall, materials);
      assert.equal(largeResult.answer, fixture.expectedCategory, `large tier answer for "${fixture.id}"`);
      const largeProb = largeResult.distribution.find((d) => d[0] === fixture.expectedCategory)?.[1];
      assert.ok(Math.abs(largeProb - fixture.expectedLarge) < 0.001, `large tier probability for ${fixture.id} is ${fixture.expectedLarge}`);
    }
  }

  // Test that asking for large when not in fixture throws.
  const unknownMaterials = { bodies: { description: 'Unknown text that was never recorded' }, items: {} };
  assert.throws(() => {
    recorded.tiers.small({ decision: 'classify', tier: 'small' }, unknownMaterials);
  }, /no recorded|unknown/i, 'unknown text throws');

  // Test that asked records decision and tier, not text.
  const newAsked = recorded.asked.slice(askedBefore);
  assert.ok(newAsked.length > 0, 'asked was populated');
  for (const entry of newAsked) {
    assert.ok('decision' in entry, 'asked entry has decision');
    assert.ok('tier' in entry, 'asked entry has tier');
    assert.ok(!('text' in entry), 'asked entry does NOT have text');
    assert.ok(!('description' in entry), 'asked entry does NOT have description');
  }
});
