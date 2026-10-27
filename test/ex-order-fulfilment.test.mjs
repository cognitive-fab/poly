// Order-fulfilment example tests: light checks (node:test).
// The tests are written from docs/examples/order-fulfilment.md alone, before any code exists.
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

const EX_DIR = join(ROOT, 'examples', 'order-fulfilment');
const PROGRAM = join(EX_DIR, 'order-fulfilment.poly');
const DEFECT = join(EX_DIR, 'order-fulfilment-defect.poly');

// ── light checks ──

test('the program, checked with its policy, is CLEAN with its instances printed', async () => {
  const report = await checkExample(PROGRAM, ROOT);
  const expected = expectedOf(PROGRAM);
  assert.ok(expected, 'the program\'s first line declares its expected verdict');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'CLEAN');
  // Verify that the policy is paired with the program (per spec).
  const policies = report.policies ?? [];
  assert.ok(policies.some((p) => p.scope === 'fulfilment'), 'the policy is paired with the program');
  // Verify the instances are printed with domains, states, etc.
  const machines = report.machines ?? [];
  assert.equal(machines.length, 2, 'two machines Stock and Order');
  const stockMachine = machines.find((m) => m.machine === 'Stock');
  const orderMachine = machines.find((m) => m.machine === 'Order');
  assert.ok(stockMachine, 'Stock machine is present');
  assert.ok(orderMachine, 'Order machine is present');
  assert.ok(stockMachine.instance, 'Stock instance is present');
  assert.ok(orderMachine.instance, 'Order instance is present');
  // Log the instances as the spec requires.
  console.log(`order-fulfilment instance: Stock over ${stockMachine.instance.domains?.join('; ')}; ${stockMachine.instance.states} states`);
  console.log(`order-fulfilment instance: Order over ${orderMachine.instance.domains?.join('; ')}; ${orderMachine.instance.states} states`);
  // Verify configuration states (spec says 126 global states).
  const configurations = report.configurations ?? [];
  assert.ok(configurations.length > 0, 'configuration is reported');
  const twoOrders = configurations.find((c) => c.configuration === 'two-orders');
  assert.ok(twoOrders, 'two-orders configuration is checked');
  console.log(`order-fulfilment configuration: two-orders ${twoOrders.instance.states} global states`);
  assert.equal(twoOrders.instance.states, 126, 'the configuration has 126 global states');
});

test('the defect is FINDINGS with exactly PL3001, the invariant named, and a witness of 4 steps ending in ShipFailed', async () => {
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
  assert.equal(pl3001.property, 'cancelled-holds-nothing', 'the property is cancelled-holds-nothing');
  // Check the witness: 4 steps (Place, Reserved, Charged, ShipFailed).
  assert.ok(pl3001.witness, 'the diagnostic has a witness');
  assert.equal(pl3001.witness.length, 4, `witness length is 4; got ${pl3001.witness.length}`);
  assert.equal(pl3001.witness.trace.length, 4, 'witness.trace.length === 4');
  // Verify the last step is ShipFailed.
  const actions = pl3001.witness.trace.map((s) => s.action);
  assert.equal(actions[0], 'Place', 'the first step is Place');
  assert.equal(actions[1], 'Reserved', 'the second step is Reserved');
  assert.equal(actions[2], 'Charged', 'the third step is Charged');
  assert.equal(actions[3], 'ShipFailed', 'the last step is ShipFailed');
});

test('poly check --host with root examples/order-fulfilment is CLEAN', { timeout: 120_000 }, async () => {
  // The host check uses host/tsconfig.json at the example root.
  const hostTsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  const r = await commandNamed('check').run({ target: PROGRAM, root: EX_DIR, host: hostTsConfig });
  assert.equal(r.result.verdict, 'CLEAN', JSON.stringify(r.result.host?.diagnostics));
  assert.equal(r.result.host.status, 'ran');
  assert.deepEqual(r.result.host.diagnostics, []);
});

test('a host handler with a wrong payload field is PL6836', { timeout: 120_000 }, async () => {
  // Create a temporary broken version of the handler to test PL6836 detection.
  const tmpRoot = join(tmpdir(), `poly-test-order-host-${Date.now()}`);
  mkdirSync(join(tmpRoot, 'host'), { recursive: true });
  // Copy the correct handler and tsconfig.
  const handlers = join(EX_DIR, 'host', 'handlers.ts');
  const tsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  let handlerSrc = readFileSync(handlers, 'utf8');
  // Break a payload field: replace 'instanceId' access with 'id' (wrong field).
  // This will cause a TypeScript error (PL6836) when type-checking.
  const broken = handlerSrc.split('ctx.instanceId').join('ctx.id');
  assert.notEqual(broken, handlerSrc, 'the mutation must change the file');
  writeFileSync(join(tmpRoot, 'host', 'handlers.ts'), broken);
  writeFileSync(join(tmpRoot, 'host', 'tsconfig.json'), readFileSync(tsConfig, 'utf8'));
  // Also copy the program to tmpRoot.
  writeFileSync(join(tmpRoot, 'order-fulfilment.poly'), readFileSync(PROGRAM, 'utf8'));
  // Run the host check on the broken handler.
  const r = await commandNamed('check').run({ target: join(tmpRoot, 'order-fulfilment.poly'), root: tmpRoot, host: join(tmpRoot, 'host', 'tsconfig.json') });
  // Every diagnostic should be PL6836.
  assert.ok(r.result.host.diagnostics.length > 0, 'there are diagnostics for the broken handler');
  const allCodes = r.result.host.diagnostics.map((d) => d.code);
  assert.ok(allCodes.every((c) => c === 'PL6836'), `all codes should be PL6836; got ${allCodes.join(', ')}`);
});

test('the charge handler: 201 returns ok; 402 throws with permanent: true; 503 throws without permanent', async () => {
  // Import the handlers from the example.
  const hostHandlers = await import(pathToFileURL(join(EX_DIR, 'host', 'handlers.ts')).href);

  const { charge } = hostHandlers;

  // Test each status code.
  const testCases = [
    { status: 200, shouldThrow: false, permanent: undefined, desc: '200 ok' },
    { status: 201, shouldThrow: false, permanent: undefined, desc: '201 ok' },
    { status: 402, shouldThrow: true, permanent: true, desc: '402 permanent error' },
    { status: 503, shouldThrow: true, permanent: false, desc: '503 transient error' },
    { status: 500, shouldThrow: true, permanent: false, desc: '500 transient error' },
  ];

  for (const tc of testCases) {
    const ctx = { idempotencyKey: `test-key-${tc.status}`, instanceId: `order-${tc.status}` };
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
        await charge(payload, caps, ctx);
        threw = false;
      } catch (err) {
        threw = true;
        assert.ok(err instanceof Error, `error is an Error for ${tc.desc}`);
        if (tc.permanent !== undefined) {
          assert.equal(Boolean(err.permanent), tc.permanent, `permanent flag is ${tc.permanent} for ${tc.desc}`);
        }
      }
      assert.ok(threw, `charge must throw for status ${tc.status}`);
    } else {
      const result = await charge(payload, caps, ctx);
      assert.deepEqual(result, { ok: true }, `returns ok for ${tc.desc}`);
    }

    // Verify request was made.
    assert.ok(requestMade, `request made for status ${tc.status}`);
    assert.equal(capturedReq.url, 'https://payments.example/v1/charges', 'correct URL');
    assert.equal(capturedReq.opts.headers['idempotency-key'], ctx.idempotencyKey, 'idempotency-key header set');
    // The body carries the instanceId (order id).
    assert.deepEqual(capturedReq.body, { order: ctx.instanceId }, `body carries order ${ctx.instanceId}`);

    requestMade = false;
  }
});

test('the ship handler: 201 returns ok; 503 throws without permanent', async () => {
  // Import the handlers from the example.
  const hostHandlers = await import(pathToFileURL(join(EX_DIR, 'host', 'handlers.ts')).href);

  const { ship } = hostHandlers;

  const testCases = [
    { status: 200, shouldThrow: false, permanent: undefined, desc: '200 ok' },
    { status: 201, shouldThrow: false, permanent: undefined, desc: '201 ok' },
    { status: 503, shouldThrow: true, permanent: false, desc: '503 transient error' },
  ];

  for (const tc of testCases) {
    const ctx = { idempotencyKey: `test-ship-${tc.status}`, instanceId: `order-ship-${tc.status}` };
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
        await ship(payload, caps, ctx);
        threw = false;
      } catch (err) {
        threw = true;
        assert.ok(err instanceof Error, `error is an Error for ${tc.desc}`);
      }
      assert.ok(threw, `ship must throw for status ${tc.status}`);
    } else {
      const result = await ship(payload, caps, ctx);
      assert.deepEqual(result, { ok: true }, `returns ok for ${tc.desc}`);
    }

    assert.ok(requestMade, `request made for status ${tc.status}`);
    assert.equal(capturedReq.url, 'https://carrier.example/v1/shipments', 'correct URL');
    assert.equal(capturedReq.opts.headers['idempotency-key'], ctx.idempotencyKey, 'idempotency-key header set');
    assert.deepEqual(capturedReq.body, { order: ctx.instanceId }, `body carries order ${ctx.instanceId}`);

    requestMade = false;
  }
});

test('the refund handler: 201 returns ok; 503 throws without permanent', async () => {
  // Import the handlers from the example.
  const hostHandlers = await import(pathToFileURL(join(EX_DIR, 'host', 'handlers.ts')).href);

  const { refund } = hostHandlers;

  const testCases = [
    { status: 200, shouldThrow: false, permanent: undefined, desc: '200 ok' },
    { status: 201, shouldThrow: false, permanent: undefined, desc: '201 ok' },
    { status: 503, shouldThrow: true, permanent: false, desc: '503 transient error' },
  ];

  for (const tc of testCases) {
    const ctx = { idempotencyKey: `test-refund-${tc.status}`, instanceId: `order-refund-${tc.status}` };
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
        await refund(payload, caps, ctx);
        threw = false;
      } catch (err) {
        threw = true;
        assert.ok(err instanceof Error, `error is an Error for ${tc.desc}`);
      }
      assert.ok(threw, `refund must throw for status ${tc.status}`);
    } else {
      const result = await refund(payload, caps, ctx);
      assert.deepEqual(result, { ok: true }, `returns ok for ${tc.desc}`);
    }

    assert.ok(requestMade, `request made for status ${tc.status}`);
    assert.equal(capturedReq.url, 'https://payments.example/v1/refunds', 'correct URL');
    assert.equal(capturedReq.opts.headers['idempotency-key'], ctx.idempotencyKey, 'idempotency-key header set');
    assert.deepEqual(capturedReq.body, { order: ctx.instanceId }, `body carries order ${ctx.instanceId}`);

    requestMade = false;
  }
});

test('recordedServices: answers by URL and by call count; defaults to 201; records requests', async () => {
  // Import recordedServices from the example.
  const hostRecorded = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const { recordedServices } = hostRecorded;

  // Test script mapping URLs to statuses.
  const script = {
    'https://payments.example/v1/charges': [201, 402, 503],
    'https://carrier.example/v1/shipments': 201,
    // payments refund defaults to 201 (not in script)
  };

  const { sent, transports } = recordedServices(script);
  assert.ok(Array.isArray(sent), 'sent is an array');
  assert.ok(transports, 'transports returned');
  assert.ok(transports.egress, 'transports.egress is present');

  // Simulate requests and verify responses.
  const chargeReq1 = { method: 'POST', url: 'https://payments.example/v1/charges', body: { order: '1' }, headers: {} };
  const resp1 = await transports.egress(chargeReq1);
  assert.equal(resp1.status, 201, 'first charge gets 201');
  assert.ok(sent.some((s) => s.url === chargeReq1.url), 'first charge request recorded');

  const chargeReq2 = { method: 'POST', url: 'https://payments.example/v1/charges', body: { order: '2' }, headers: {} };
  const resp2 = await transports.egress(chargeReq2);
  assert.equal(resp2.status, 402, 'second charge gets 402');

  const chargeReq3 = { method: 'POST', url: 'https://payments.example/v1/charges', body: { order: '3' }, headers: {} };
  const resp3 = await transports.egress(chargeReq3);
  assert.equal(resp3.status, 503, 'third charge gets 503');

  const chargeReq4 = { method: 'POST', url: 'https://payments.example/v1/charges', body: { order: '4' }, headers: {} };
  const resp4 = await transports.egress(chargeReq4);
  assert.equal(resp4.status, 503, 'fourth charge gets 503 (last repeated)');

  const shipReq = { method: 'POST', url: 'https://carrier.example/v1/shipments', body: { order: '1' }, headers: {} };
  const respShip = await transports.egress(shipReq);
  assert.equal(respShip.status, 201, 'ship gets 201');

  const refundReq = { method: 'POST', url: 'https://payments.example/v1/refunds', body: { order: '1' }, headers: {} };
  const respRefund = await transports.egress(refundReq);
  assert.equal(respRefund.status, 201, 'refund defaults to 201');

  // Verify all requests were recorded.
  assert.ok(sent.length >= 6, `at least 6 requests recorded; got ${sent.length}`);
  const chargeCount = sent.filter((s) => s.url === 'https://payments.example/v1/charges').length;
  assert.equal(chargeCount, 4, '4 charge requests recorded');
});
