// Subscription-cancel example tests: light checks (node:test).
// The tests are written from docs/examples/subscription-cancel.md alone, before any code exists.
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

const EX_DIR = join(ROOT, 'examples', 'subscription-cancel');
const PROGRAM = join(EX_DIR, 'subscription-cancel.poly');
const DEFECT = join(EX_DIR, 'subscription-cancel-defect.poly');

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
  assert.ok(policies.some((p) => p.scope === 'subscription'), 'the policy is paired with the program');
  // Verify the instance is printed with domains, states, etc.
  const machines = report.machines ?? [];
  assert.equal(machines.length, 1, 'one machine Subscription');
  assert.equal(machines[0].machine, 'Subscription');
  const inst = machines[0].instance;
  assert.ok(inst, 'instance is present');
  assert.ok(inst.domains && Array.isArray(inst.domains), 'instance has domains array');
  assert.equal(inst.states, 7, 'instance has 7 states');
  // Verify the liveness stage ran and passed.
  const stages = machines[0].stages ?? [];
  const livenessStage = stages.find((s) => s.stage === 'liveness');
  assert.ok(livenessStage, 'liveness stage is present');
  assert.deepEqual([livenessStage.status, livenessStage.verdict], ['ran', 'CLEAN'], 'the liveness stage ran and is CLEAN');
  // Log the instance as the spec requires.
  console.log(`subscription-cancel instance: ${machines[0].machine} over ${inst.domains.join('; ')}; ${inst.states} states`);
});

test('the defect is FINDINGS with exactly PL3301 and PL4001, the properties named, and correct witness shapes', async () => {
  const report = await checkExample(DEFECT, ROOT);
  const expected = expectedOf(DEFECT);
  assert.ok(expected, 'the defect\'s first line declares expected FINDING PL3301 PL4001');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'FINDINGS');
  // Find the diagnostics.
  const machines = report.machines ?? [];
  const allDiags = machines.flatMap((m) => m.diagnostics ?? []);
  const pl3301 = allDiags.find((d) => d.code === 'PL3301');
  const pl4001 = allDiags.find((d) => d.code === 'PL4001');
  assert.ok(pl3301, `PL3301 not found; found: ${allDiags.map((d) => d.code).join(', ')}`);
  assert.ok(pl4001, `PL4001 not found; found: ${allDiags.map((d) => d.code).join(', ')}`);
  // PL3301: liveness lasso.
  assert.equal(pl3301.name, 'LIVENESS_LASSO', 'PL3301 is a liveness lasso');
  assert.ok(pl3301.property, 'PL3301 property is named');
  assert.equal(pl3301.property, 'request-ends', 'the property is request-ends');
  assert.ok(pl3301.witness, 'PL3301 has a witness');
  assert.equal(pl3301.witness.length, 5, `PL3301 witness length is 5; got ${pl3301.witness.length}`);
  assert.equal(pl3301.witness.trace.length, 5, 'PL3301 witness.trace.length === 5');
  // Verify prefix and cycle structure: Request (1 step), then OfferSent, Decline, OfferSent, Decline (4-step cycle).
  const lasso = pl3301.witness.trace.map((s) => s.action);
  assert.equal(lasso[0], 'Request', 'first step is Request (prefix)');
  assert.ok(['OfferSent', 'Decline'].includes(lasso[1]), 'second step is OfferSent or Decline');
  // PL4001: path property.
  assert.equal(pl4001.name, 'PATH_PROPERTY', 'PL4001 is a path property violation');
  assert.ok(pl4001.property, 'PL4001 property is named');
  assert.equal(pl4001.property, 'offer-at-most-once', 'the property is offer-at-most-once');
  assert.ok(pl4001.witness, 'PL4001 has a witness');
  assert.equal(pl4001.witness.length, 3, `PL4001 witness length is 3; got ${pl4001.witness.length}`);
  assert.equal(pl4001.witness.trace.length, 3, 'PL4001 witness.trace.length === 3');
  // Verify the path: Request, OfferSent, Decline, and Decline emits retention.offer again.
  const pathSteps = pl4001.witness.trace.map((s) => s.action);
  assert.equal(pathSteps[0], 'Request', 'first step is Request');
  assert.equal(pathSteps[1], 'OfferSent', 'second step is OfferSent');
  assert.equal(pathSteps[2], 'Decline', 'third step is Decline');
});

test('poly check --host with root examples/subscription-cancel is CLEAN', { timeout: 120_000 }, async () => {
  // The host check uses host/tsconfig.json at the example root.
  const hostTsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  const r = await commandNamed('check').run({ target: PROGRAM, root: EX_DIR, host: hostTsConfig });
  assert.equal(r.result.verdict, 'CLEAN', JSON.stringify(r.result.host?.diagnostics));
  assert.equal(r.result.host.status, 'ran');
  assert.deepEqual(r.result.host.diagnostics, []);
});

test('a host handler with a wrong payload field is PL6836', { timeout: 120_000 }, async () => {
  // Create a temporary broken version of the handler to test PL6836 detection.
  const tmpRoot = join(tmpdir(), `poly-test-subscription-host-${Date.now()}`);
  mkdirSync(join(tmpRoot, 'host'), { recursive: true });
  // Copy the correct handler and tsconfig.
  const handlers = join(EX_DIR, 'host', 'handlers.ts');
  const tsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  let handlerSrc = readFileSync(handlers, 'utf8');
  // Break the payload field: replace 'ctx.instanceId' with 'ctx.subscriptionId' (wrong field).
  // This will cause a TypeScript error (PL6836) when type-checking.
  const broken = handlerSrc.split('ctx.instanceId').join('ctx.subscriptionId');
  assert.notEqual(broken, handlerSrc, 'the mutation must change the file');
  writeFileSync(join(tmpRoot, 'host', 'handlers.ts'), broken);
  writeFileSync(join(tmpRoot, 'host', 'tsconfig.json'), readFileSync(tsConfig, 'utf8'));
  // Also copy the program to tmpRoot.
  writeFileSync(join(tmpRoot, 'subscription-cancel.poly'), readFileSync(PROGRAM, 'utf8'));
  // Run the host check on the broken handler.
  const r = await commandNamed('check').run({ target: join(tmpRoot, 'subscription-cancel.poly'), root: tmpRoot, host: join(tmpRoot, 'host', 'tsconfig.json') });
  // Every diagnostic should be PL6836.
  assert.ok(r.result.host.diagnostics.length > 0, 'there are diagnostics for the broken handler');
  const allCodes = r.result.host.diagnostics.map((d) => d.code);
  assert.ok(allCodes.every((c) => c === 'PL6836'), `all codes should be PL6836; got ${allCodes.join(', ')}`);
});

test('the handler offer: 201 returns ok; 422 throws with permanent: true; 503 throws without permanent', async () => {
  // Import the handler from the example.
  const hostHandlers = await import(pathToFileURL(join(EX_DIR, 'host', 'handlers.ts')).href);

  const { offer } = hostHandlers;

  // Test each status code.
  const testCases = [
    { status: 200, shouldThrow: false, permanent: undefined, desc: '200 ok' },
    { status: 201, shouldThrow: false, permanent: undefined, desc: '201 ok' },
    { status: 422, shouldThrow: true, permanent: true, desc: '422 permanent error' },
    { status: 503, shouldThrow: true, permanent: false, desc: '503 transient error' },
    { status: 500, shouldThrow: true, permanent: false, desc: '500 transient error' },
  ];

  for (const tc of testCases) {
    const ctx = { idempotencyKey: `test-key-${tc.status}`, instanceId: `sub-${tc.status}` };
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
        await offer(payload, caps, ctx);
        threw = false;
      } catch (err) {
        threw = true;
        assert.ok(err instanceof Error, `error is an Error for ${tc.desc}`);
        if (tc.permanent !== undefined) {
          assert.equal(Boolean(err.permanent), tc.permanent, `permanent flag is ${tc.permanent} for ${tc.desc}`);
        }
      }
      assert.ok(threw, `offer must throw for status ${tc.status}`);
    } else {
      const result = await offer(payload, caps, ctx);
      assert.deepEqual(result, { ok: true }, `returns ok for ${tc.desc}`);
    }

    // Verify request was made.
    assert.ok(requestMade, `request made for status ${tc.status}`);
    assert.equal(capturedReq.url, 'https://marketing.example/v1/offers', 'correct URL');
    assert.equal(capturedReq.opts.headers['idempotency-key'], ctx.idempotencyKey, 'idempotency-key header set');
    // The body carries the subscription id.
    assert.deepEqual(capturedReq.body, { subscription: ctx.instanceId }, `body carries the instance id`);
  }
});

test('the handler cancel: 201 returns ok; 422 throws with permanent: true; 503 throws without permanent', async () => {
  // Import the handler from the example.
  const hostHandlers = await import(pathToFileURL(join(EX_DIR, 'host', 'handlers.ts')).href);

  const { cancel } = hostHandlers;

  // Test each status code.
  const testCases = [
    { status: 200, shouldThrow: false, permanent: undefined, desc: '200 ok' },
    { status: 201, shouldThrow: false, permanent: undefined, desc: '201 ok' },
    { status: 422, shouldThrow: true, permanent: true, desc: '422 permanent error' },
    { status: 503, shouldThrow: true, permanent: false, desc: '503 transient error' },
    { status: 500, shouldThrow: true, permanent: false, desc: '500 transient error' },
  ];

  for (const tc of testCases) {
    const ctx = { idempotencyKey: `test-key-${tc.status}`, instanceId: `sub-${tc.status}` };
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
        await cancel(payload, caps, ctx);
        threw = false;
      } catch (err) {
        threw = true;
        assert.ok(err instanceof Error, `error is an Error for ${tc.desc}`);
        if (tc.permanent !== undefined) {
          assert.equal(Boolean(err.permanent), tc.permanent, `permanent flag is ${tc.permanent} for ${tc.desc}`);
        }
      }
      assert.ok(threw, `cancel must throw for status ${tc.status}`);
    } else {
      const result = await cancel(payload, caps, ctx);
      assert.deepEqual(result, { ok: true }, `returns ok for ${tc.desc}`);
    }

    assert.ok(requestMade, `request made for status ${tc.status}`);
    assert.equal(capturedReq.url, 'https://billing.example/v1/subscriptions/cancel', 'correct URL');
    assert.equal(capturedReq.opts.headers['idempotency-key'], ctx.idempotencyKey, 'idempotency-key header set');
    assert.deepEqual(capturedReq.body, { subscription: ctx.instanceId }, `body carries the instance id`);

    requestMade = false;
  }
});

test('recordedServices: answers by URL and by call count; defaults to 201; records requests', async () => {
  // Import recordedServices from the example.
  const hostRecorded = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const { recordedServices } = hostRecorded;

  // Test script mapping URLs to statuses.
  const script = {
    'https://marketing.example/v1/offers': [201, 422, 503],
    'https://billing.example/v1/subscriptions/cancel': 201,
    // default not in script defaults to 201
  };

  const { sent, transports } = recordedServices(script);
  assert.ok(Array.isArray(sent), 'sent is an array');
  assert.ok(transports, 'transports returned');
  assert.ok(transports.egress, 'transports.egress is present');

  // Simulate requests and verify responses.
  const offerReq1 = { method: 'POST', url: 'https://marketing.example/v1/offers', body: { subscription: '1' }, headers: {} };
  const resp1 = await transports.egress(offerReq1);
  assert.equal(resp1.status, 201, 'first offer gets 201');
  assert.ok(sent.some((s) => s.url === offerReq1.url), 'first offer request recorded');

  const offerReq2 = { method: 'POST', url: 'https://marketing.example/v1/offers', body: { subscription: '2' }, headers: {} };
  const resp2 = await transports.egress(offerReq2);
  assert.equal(resp2.status, 422, 'second offer gets 422');

  const offerReq3 = { method: 'POST', url: 'https://marketing.example/v1/offers', body: { subscription: '3' }, headers: {} };
  const resp3 = await transports.egress(offerReq3);
  assert.equal(resp3.status, 503, 'third offer gets 503');

  const offerReq4 = { method: 'POST', url: 'https://marketing.example/v1/offers', body: { subscription: '4' }, headers: {} };
  const resp4 = await transports.egress(offerReq4);
  assert.equal(resp4.status, 503, 'fourth offer gets 503 (last repeated)');

  const cancelReq = { method: 'POST', url: 'https://billing.example/v1/subscriptions/cancel', body: { subscription: '1' }, headers: {} };
  const respCancel = await transports.egress(cancelReq);
  assert.equal(respCancel.status, 201, 'cancel gets 201');

  const defaultReq = { method: 'POST', url: 'https://unknown.example/v1/default', body: { subscription: '1' }, headers: {} };
  const respDefault = await transports.egress(defaultReq);
  assert.equal(respDefault.status, 201, 'unknown URL defaults to 201');

  // Verify all requests were recorded.
  assert.ok(sent.length >= 6, `at least 6 requests recorded; got ${sent.length}`);
  const offerCount = sent.filter((s) => s.url === 'https://marketing.example/v1/offers').length;
  assert.equal(offerCount, 4, '4 offer requests recorded');
});
