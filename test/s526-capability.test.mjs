// PT33.4 (DAC4): idempotency key attached to every write through caps.egress,
// replaced if handler supplied another, second write in one attempt refused PL6406,
// get carries no key, key is the same on every attempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CapabilityRefused } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';
import { concierge, REFUNDS } from './concierge-refund-helpers.mjs';

const KEYED_FIXTURE = 'test/fixtures/s526/runtime/keyed.poly';
const PLAIN_FIXTURE = 'test/fixtures/s526/runtime/plain.poly';

/** A host egress transport that records each request and answers by URL. */
function transports(answers = {}) {
  const calls = { egress: [], secrets: [], exec: [], store: [] };
  return {
    calls,
    transports: {
      egress: async (req) => { calls.egress.push(req); return answers[req.url] ?? { status: 200, headers: {}, body: { ok: true } }; },
      secrets: async (name) => { calls.secrets.push(name); return `secret-of-${name}`; },
      exec: async (command, args) => { calls.exec.push([command, args]); return { code: 0 }; },
      store: { read: async (table, key) => { calls.store.push(['read', table, key]); return null; }, write: async (table, key, value) => { calls.store.push(['write', table, key, value]); } },
    },
  };
}

/**
 * Admits a project, failing with a clear PT33.1 message if the parse fails.
 * Returns the admitted project or calls assert.fail with a descriptive error.
 */
async function admitOrFail(name, sources) {
  try {
    const a = await admitted(name, sources);
    if (!a?.certificate) {
      assert.fail('PT33.1: the idempotent clause is not accepted yet: admitted project has no certificate');
    }
    return a;
  } catch (e) {
    assert.fail(`PT33.1: the idempotent clause is not accepted yet: ${e.message}`);
  }
}

/**
 * Shared harness: admits a project, loads it with a clock and transports, sets a handler,
 * creates an instance, and runs the dispatch. Returns the observed caps and calls, plus audit.
 */
async function run(fixture, projectName, kind, script) {
  let a;
  try {
    a = await admitOrFail(projectName, [fixture]);
  } catch (e) {
    // admitOrFail already failed; rethrow so test fails with the PT33.1 message
    throw e;
  }

  const t = transports();
  const { rt, clock } = await loaded(a, { transports: t.transports });
  try {
    let seen;
    handleWith(rt, kind, async (payload, caps, ctx) => { seen = { caps, ctx, out: await script(caps, ctx) }; return {}; });
    await rt.create('s526keyed.Job', { id: 'job-1' });
    await rt.dispatch('job-1', 'Go', {});
    await rt.worker.tick();
    const audit = await rt.audit('job-1');
    return { seen, calls: t.calls, audit, rt, clock };
  } catch (e) {
    await rt.close(); // the caller closes the runtime of a successful run
    throw e;
  }
}

/**
 * CONTROL: an effect without idempotent clause sends no Idempotency-Key header.
 * This test proves the harness works and the transport records headers correctly.
 */
test('CONTROL: PT33.4: effect without idempotent clause sends no Idempotency-Key header', async () => {
  const projectName = 's526-cap-control';
  let a;
  try {
    a = await admitted(projectName, [PLAIN_FIXTURE]);
  } catch (e) {
    // For this CONTROL, we expect the plain fixture (without idempotent) to admit today.
    // If it fails, the harness is broken.
    assert.fail(`CONTROL: plain fixture should admit today: ${e.message}`);
  }

  const t = transports();
  const { rt } = await loaded(a, { transports: t.transports });
  try {
    let seen;
    handleWith(rt, 's526.work', async (payload, caps, ctx) => {
      seen = { ctx, out: await caps.egress.post('https://api.psp.example/v1/work', { data: 'test' }) };
      return {};
    });
    await rt.create('s526plain.Job', { id: 'job-control' });
    await rt.dispatch('job-control', 'Go', {});
    await rt.worker.tick();

    // Verify the handler ran
    assert.ok(seen, 'CONTROL: handler must run');
    assert.ok(seen.ctx, 'CONTROL: handler context must be available');

    // Verify exactly one POST was made
    assert.equal(t.calls.egress.length, 1, 'CONTROL: must make exactly one POST');
    const [request] = t.calls.egress;
    assert.equal(request.method, 'POST', 'CONTROL: request must be a POST');

    // Verify no Idempotency-Key header (case-insensitive)
    const headerKeys = Object.keys(request.headers || {}).map((k) => k.toLowerCase());
    assert.ok(!headerKeys.includes('idempotency-key'), `CONTROL: no Idempotency-Key header in ${JSON.stringify(request.headers)}`);
  } finally { await rt.close(); }
});

/**
 * PT33.4 Test 1: a handler that never sets a header and calls caps.egress.post
 * sends a request whose headers include Idempotency-Key equal to ctx.idempotencyKey.
 */
test('PT33.4(1): handler that never sets header carries intent id as Idempotency-Key', async () => {
  const projectName = 's526-cap-1';
  const { seen, calls, audit, rt } = await run(KEYED_FIXTURE, projectName, 's526.work', async (caps, ctx) => {
    // Handler does NOT set Idempotency-Key
    return await caps.egress.post('https://api.psp.example/v1/work', { data: 'test' });
  });

  try {
    // Assert the handler ran and we have a context
    assert.ok(seen, 'PT33.4(1): handler must run');
    assert.ok(seen.ctx, 'PT33.4(1): handler context must exist');

    // Assert idempotencyKey exists and is a non-empty string
    assert.ok(typeof seen.ctx.idempotencyKey === 'string' && seen.ctx.idempotencyKey.length > 0,
      `PT33.4(1): ctx.idempotencyKey must be a non-empty string, got ${typeof seen.ctx.idempotencyKey}`);

    // Assert exactly one POST was made to the transport
    assert.equal(calls.egress.length, 1, `PT33.4(1): must make exactly one POST, got ${calls.egress.length}`);
    const [request] = calls.egress;

    // Assert the request has Idempotency-Key header (case-insensitive)
    const headerLower = Object.entries(request.headers || {}).reduce((acc, [k, v]) => {
      acc[k.toLowerCase()] = v;
      return acc;
    }, {});
    assert.ok('idempotency-key' in headerLower, `PT33.4(1): must have Idempotency-Key header, got ${JSON.stringify(request.headers)}`);

    // Assert the header value equals the intent id
    const headerValue = headerLower['idempotency-key'];
    assert.equal(headerValue, seen.ctx.idempotencyKey,
      `PT33.4(1): Idempotency-Key (${headerValue}) must equal ctx.idempotencyKey (${seen.ctx.idempotencyKey})`);
  } finally { await rt.close(); }
});

/**
 * PT33.4 Test 2: a handler that sets its own Idempotency-Key: forged header
 * is replaced with intent id; an audit row idempotency-header-replaced exists.
 */
test('PT33.4(2): handler-supplied Idempotency-Key is replaced with intent id, audited', async () => {
  const projectName = 's526-cap-2';
  const { seen, calls, audit, rt } = await run(KEYED_FIXTURE, projectName, 's526.work', async (caps, ctx) => {
    // Handler sets its own (forged) Idempotency-Key header
    return await caps.egress.post('https://api.psp.example/v1/work', { data: 'test' }, { headers: { 'Idempotency-Key': 'forged' } });
  });

  try {
    // Assert the handler ran
    assert.ok(seen, 'PT33.4(2): handler must run');
    assert.ok(seen.ctx, 'PT33.4(2): handler context must exist');
    assert.ok(typeof seen.ctx.idempotencyKey === 'string' && seen.ctx.idempotencyKey.length > 0,
      'PT33.4(2): ctx.idempotencyKey must be a non-empty string');

    // Assert exactly one POST was made
    assert.equal(calls.egress.length, 1, `PT33.4(2): must make exactly one POST, got ${calls.egress.length}`);
    const [request] = calls.egress;

    // Assert the header was replaced (not 'forged')
    const headerLower = Object.entries(request.headers || {}).reduce((acc, [k, v]) => {
      acc[k.toLowerCase()] = v;
      return acc;
    }, {});
    assert.ok('idempotency-key' in headerLower, 'PT33.4(2): must have Idempotency-Key header');
    const headerValue = headerLower['idempotency-key'];
    assert.notEqual(headerValue, 'forged', `PT33.4(2): handler-supplied value must be replaced, got ${headerValue}`);
    assert.equal(headerValue, seen.ctx.idempotencyKey, `PT33.4(2): header must equal intent id`);

    // Assert an audit row for the replacement exists (AMBIGUOUS: field name if audit row format changes)
    const replacementRow = audit.find((r) => r.rule === 'idempotency-header-replaced');
    assert.ok(replacementRow, `PT33.4(2): audit must record idempotency-header-replaced, got ${JSON.stringify(audit.slice(0, 3))}`);
  } finally { await rt.close(); }
});

/**
 * PT33.4 Test 3: a second caps.egress.post in the same attempt is refused
 * with a CapabilityRefused error; the transport sees only one POST.
 */
test('PT33.4(3): second post in same attempt is refused PL6406', async () => {
  const projectName = 's526-cap-3';
  const { seen, calls, audit, rt } = await run(KEYED_FIXTURE, projectName, 's526.work', async (caps, ctx) => {
    // Make first POST
    const first = await caps.egress.post('https://api.psp.example/v1/work', { data: 'first' });

    // Try to make second POST; this should be refused
    let secondError;
    try {
      await caps.egress.post('https://api.psp.example/v1/work', { data: 'second' });
    } catch (e) {
      secondError = e;
    }

    return { first, secondError };
  });

  try {
    // Assert the handler ran
    assert.ok(seen, 'PT33.4(3): handler must run');
    assert.ok(seen.out, 'PT33.4(3): handler output must exist');

    // Assert the second POST threw a CapabilityRefused error
    assert.ok(seen.out.secondError instanceof CapabilityRefused,
      `PT33.4(3): second post must throw CapabilityRefused, got ${seen.out.secondError?.constructor?.name}`);

    // PT33.4: refused PL6406 CAPABILITY_REFUSED: the error cites it and the refusal is audited (rt.audit rows carry rule PL6406)
    assert.match(seen.out.secondError.message, /PL6406 CAPABILITY_REFUSED/, 'PT33.4(3): the error names PL6406 CAPABILITY_REFUSED');
    assert.ok(audit.some((r) => r.rule === 'PL6406'), `PT33.4(3): the refusal is audited, got ${JSON.stringify(audit.slice(0, 3))}`);

    // Assert the transport saw exactly one POST (second one was refused before transport)
    assert.equal(calls.egress.length, 1, `PT33.4(3): transport must see exactly one POST, got ${calls.egress.length}`);
  } finally { await rt.close(); }
});

/**
 * PT33.4 Test 4: caps.egress.get carries no Idempotency-Key header.
 */
test('PT33.4(4): caps.egress.get carries no Idempotency-Key header', async () => {
  const projectName = 's526-cap-4';
  const { seen, calls, rt } = await run(KEYED_FIXTURE, projectName, 's526.work', async (caps, ctx) => {
    // Make a GET request first
    const getResult = await caps.egress.get('https://api.psp.example/v1/work?id=123');
    // Make a POST request second
    const postResult = await caps.egress.post('https://api.psp.example/v1/work', { data: 'test' });
    return { getResult, postResult };
  });

  try {
    // Assert two requests were made
    assert.equal(calls.egress.length, 2, `PT33.4(4): must make two requests (GET and POST), got ${calls.egress.length}`);

    const [getRequest, postRequest] = calls.egress;
    assert.equal(getRequest.method, 'GET', 'PT33.4(4): first request must be GET');
    assert.equal(postRequest.method, 'POST', 'PT33.4(4): second request must be POST');

    // Assert GET has no Idempotency-Key header
    const getHeaderLower = Object.entries(getRequest.headers || {}).reduce((acc, [k, v]) => {
      acc[k.toLowerCase()] = v;
      return acc;
    }, {});
    assert.ok(!('idempotency-key' in getHeaderLower), `PT33.4(4): GET must not have Idempotency-Key header, got ${JSON.stringify(getRequest.headers)}`);

    // Assert POST has Idempotency-Key header
    const postHeaderLower = Object.entries(postRequest.headers || {}).reduce((acc, [k, v]) => {
      acc[k.toLowerCase()] = v;
      return acc;
    }, {});
    assert.ok('idempotency-key' in postHeaderLower, `PT33.4(4): POST must have Idempotency-Key header, got ${JSON.stringify(postRequest.headers)}`);
  } finally { await rt.close(); }
});

/**
 * PT33.4 Test 5: with the first attempt's handler throwing after the post (a lost answer)
 * and the retry succeeding, both attempts' requests carry the SAME key.
 */
test('PT33.4(5): first attempt throws after post, retry succeeds, both carry same key', async () => {
  const projectName = 's526-cap-5';
  let a;
  try {
    a = await admitOrFail(projectName, [KEYED_FIXTURE]);
  } catch (e) {
    throw e;
  }

  const t = transports();
  const { rt, clock } = await loaded(a, { transports: t.transports });
  try {
    let handlerAttempts = 0;
    let firstAttemptKey;
    handleWith(rt, 's526.work', async (payload, caps, ctx) => {
      handlerAttempts++;
      const result = await caps.egress.post('https://api.psp.example/v1/work', { attempt: handlerAttempts });

      if (handlerAttempts === 1) {
        // Save the key from first attempt
        firstAttemptKey = ctx.idempotencyKey;
        // Throw to simulate a lost answer
        throw new Error('Lost answer');
      }

      // Second attempt succeeds
      return { ok: true };
    });

    await rt.create('s526keyed.Job', { id: 'job-retry' });
    await rt.dispatch('job-retry', 'Go', {});
    await rt.worker.tick();

    // First attempt should fail and retry
    // Advance clock past the backoff (200ms base, some jitter)
    clock.advance(500);
    await rt.worker.tick();

    // Verify the handler was called twice
    assert.equal(handlerAttempts, 2, `PT33.4(5): handler should run twice, got ${handlerAttempts} times`);

    // Verify the transport saw two POSTs
    assert.equal(t.calls.egress.length, 2, `PT33.4(5): should make two POSTs, got ${t.calls.egress.length}`);

    const [firstRequest, secondRequest] = t.calls.egress;

    // Extract headers case-insensitively
    const firstHeaderLower = Object.entries(firstRequest.headers || {}).reduce((acc, [k, v]) => {
      acc[k.toLowerCase()] = v;
      return acc;
    }, {});
    const secondHeaderLower = Object.entries(secondRequest.headers || {}).reduce((acc, [k, v]) => {
      acc[k.toLowerCase()] = v;
      return acc;
    }, {});

    // Assert both have Idempotency-Key header
    assert.ok('idempotency-key' in firstHeaderLower, `PT33.4(5): first POST must have Idempotency-Key`);
    assert.ok('idempotency-key' in secondHeaderLower, `PT33.4(5): second POST must have Idempotency-Key`);

    // Assert they are the same
    const firstKey = firstHeaderLower['idempotency-key'];
    const secondKey = secondHeaderLower['idempotency-key'];
    assert.equal(firstKey, secondKey, `PT33.4(5): both attempts must use same key: ${firstKey} vs ${secondKey}`);
    assert.equal(firstKey, firstAttemptKey, `PT33.4(5): key must match ctx.idempotencyKey`);
  } finally { await rt.close(); }
});

/**
 * PT33.4 Test 6: seeded runtime fault idempotency-header-dropped.
 * With the fault, the header is not attached; without it, the header is present.
 */
test('PT33.4(6): seeded fault idempotency-header-dropped prevents header attachment', async () => {
  const projectName = 's526-cap-6';

  // Helper to run with optional fault
  async function runAttach(fault) {
    let a;
    try {
      a = await admitOrFail(projectName, [KEYED_FIXTURE]);
    } catch (e) {
      throw e;
    }

    const t = transports();
    const loadOpts = { transports: t.transports };
    if (fault) loadOpts.fault = fault;

    const { rt } = await loaded(a, loadOpts);
    try {
      let seen;
      handleWith(rt, 's526.work', async (payload, caps, ctx) => {
        seen = { ctx, out: await caps.egress.post('https://api.psp.example/v1/work', { data: 'test' }) };
        return {};
      });
      await rt.create('s526keyed.Job', { id: 'job-fault' });
      await rt.dispatch('job-fault', 'Go', {});
      await rt.worker.tick();

      // Return the header from the recorded request
      assert.equal(t.calls.egress.length, 1, 'PT33.4(6): exactly one POST reached the transport in this run (so an absent header is the fault, not a missing request)');
      const [request] = t.calls.egress;
      const headerLower = Object.entries(request.headers || {}).reduce((acc, [k, v]) => {
        acc[k.toLowerCase()] = v;
        return acc;
      }, {});
      return headerLower['idempotency-key'];
    } finally { await rt.close(); }
  }

  // Without fault, header should be present
  const headerNormal = await runAttach(undefined);
  assert.ok(headerNormal, `PT33.4(6): without fault, Idempotency-Key must be present`);

  // With fault, header should be absent
  const headerFaulted = await runAttach('idempotency-header-dropped');
  assert.ok(!headerFaulted, `PT33.4(6): with fault, Idempotency-Key must be absent, got ${headerFaulted}`);
});

/** Tests for caps.api path (credential-using effects): parallel to egress tests but via concierge helper. */

/**
 * CONTROL: an effect without idempotent clause (plain fixture) sends no Idempotency-Key through caps.api.
 * This tests the api path works and records headers correctly.
 */
test('CONTROL: PT33.4(api): effect without idempotent clause sends no Idempotency-Key through caps.api', { timeout: 300_000 }, async () => {
  const c = await concierge('s526-api-control', { source: 'test/fixtures/s526/runtime/concierge-plain.poly' });
  try {
    let seen;
    handleWith(c.rt, 'payments.refund', async (payload, { api }) => {
      seen = { out: await api.post(REFUNDS, `amount=${payload.amount}`) };
      return { status: seen.out.status };
    });
    await c.grant('merchant-1');
    const app = await c.ticket('alice');
    await c.refund(app, 'merchant-1', 40);
    await c.rt.advance();

    assert.ok(seen, 'CONTROL: handler must run');
    const refundsRequests = c.sent.filter((q) => q.url === REFUNDS);
    assert.equal(refundsRequests.length, 1, `CONTROL: must make exactly one REFUNDS request, got ${refundsRequests.length}`);
    const [request] = refundsRequests;

    assert.ok(request.method === 'POST', 'CONTROL: request must be a POST');
    assert.ok(request.headers?.authorization, 'CONTROL: request must have authorization header');

    const headerKeys = Object.keys(request.headers || {}).map((k) => k.toLowerCase());
    assert.ok(!headerKeys.includes('idempotency-key'), `CONTROL: no Idempotency-Key header in ${JSON.stringify(request.headers)}`);
  } finally { await c.rt.close(); }
});

/**
 * PT33.4(api) Test 1: a handler that calls api.post through a keyed effect
 * sends a request whose headers include Idempotency-Key equal to the intent id.
 * Fails today because the idempotent clause is not accepted yet.
 */
test('PT33.4(api-1): handler that calls api.post carries intent id as Idempotency-Key', { timeout: 300_000 }, async () => {
  let c;
  try {
    c = await concierge('s526-api-1', { source: 'test/fixtures/s526/runtime/concierge-keyed.poly' });
  } catch (e) {
    if (/REFUSED/.test(e.message)) {
      assert.fail(`PT33.1: the idempotent clause is not accepted yet: ${e.message}`);
    }
    throw e;
  }
  try {
    let seen;
    handleWith(c.rt, 'payments.refund', async (payload, { api }, ctx) => {
      seen = { ctx, out: await api.post(REFUNDS, `amount=${payload.amount}`) };
      return { status: seen.out.status };
    });
    await c.grant('merchant-1');
    const app = await c.ticket('alice');
    await c.refund(app, 'merchant-1', 40);
    await c.rt.advance();

    assert.ok(seen, 'PT33.4(api-1): handler must run');
    assert.ok(seen.ctx, 'PT33.4(api-1): handler context must exist');
    assert.ok(typeof seen.ctx.idempotencyKey === 'string' && seen.ctx.idempotencyKey.length > 0,
      `PT33.4(api-1): ctx.idempotencyKey must be non-empty string, got ${typeof seen.ctx.idempotencyKey}`);

    const refundsRequests = c.sent.filter((q) => q.url === REFUNDS);
    assert.equal(refundsRequests.length, 1, `PT33.4(api-1): must make exactly one REFUNDS request, got ${refundsRequests.length}`);
    const [request] = refundsRequests;

    const headerLower = Object.entries(request.headers || {}).reduce((acc, [k, v]) => {
      acc[k.toLowerCase()] = v;
      return acc;
    }, {});
    assert.ok('idempotency-key' in headerLower, `PT33.4(api-1): must have Idempotency-Key header, got ${JSON.stringify(request.headers)}`);
    const headerValue = headerLower['idempotency-key'];
    assert.equal(headerValue, seen.ctx.idempotencyKey,
      `PT33.4(api-1): Idempotency-Key (${headerValue}) must equal ctx.idempotencyKey (${seen.ctx.idempotencyKey})`);
  } finally { await c.rt.close(); }
});

/**
 * PT33.4(api) Test 2: a handler that sets its own Idempotency-Key: forged header
 * is replaced with intent id; an audit row idempotency-header-replaced exists.
 */
test('PT33.4(api-2): handler-supplied Idempotency-Key is replaced with intent id, audited through api', { timeout: 300_000 }, async () => {
  let c;
  try {
    c = await concierge('s526-api-2', { source: 'test/fixtures/s526/runtime/concierge-keyed.poly' });
  } catch (e) {
    if (/REFUSED/.test(e.message)) {
      assert.fail(`PT33.1: the idempotent clause is not accepted yet: ${e.message}`);
    }
    throw e;
  }
  try {
    let seen;
    handleWith(c.rt, 'payments.refund', async (payload, { api }, ctx) => {
      seen = { ctx, out: await api.post(REFUNDS, `amount=${payload.amount}`, { headers: { 'Idempotency-Key': 'forged' } }) };
      return { status: seen.out.status };
    });
    await c.grant('merchant-1');
    const app = await c.ticket('alice');
    await c.refund(app, 'merchant-1', 40);
    await c.rt.advance();

    assert.ok(seen, 'PT33.4(api-2): handler must run');
    assert.ok(typeof seen.ctx.idempotencyKey === 'string' && seen.ctx.idempotencyKey.length > 0,
      'PT33.4(api-2): ctx.idempotencyKey must be a non-empty string');

    const refundsRequests = c.sent.filter((q) => q.url === REFUNDS);
    assert.equal(refundsRequests.length, 1, `PT33.4(api-2): must make exactly one REFUNDS request, got ${refundsRequests.length}`);
    const [request] = refundsRequests;

    const headerLower = Object.entries(request.headers || {}).reduce((acc, [k, v]) => {
      acc[k.toLowerCase()] = v;
      return acc;
    }, {});
    assert.ok('idempotency-key' in headerLower, 'PT33.4(api-2): must have Idempotency-Key header');
    const headerValue = headerLower['idempotency-key'];
    assert.notEqual(headerValue, 'forged', `PT33.4(api-2): handler-supplied value must be replaced, got ${headerValue}`);
    assert.equal(headerValue, seen.ctx.idempotencyKey, `PT33.4(api-2): header must equal intent id`);

    const audit = c.rt.store.db.prepare('SELECT action, rule, reason FROM pr_audit').all();
    const replacementRow = audit.find((r) => r.rule === 'idempotency-header-replaced');
    assert.ok(replacementRow, `PT33.4(api-2): audit must record idempotency-header-replaced, got ${JSON.stringify(audit.slice(0, 3))}`);
  } finally { await c.rt.close(); }
});

/**
 * PT33.4(api) Test 3: a second api.post in the same attempt is refused with PL6406.
 */
test('PT33.4(api-3): second api.post in same attempt is refused PL6406', { timeout: 300_000 }, async () => {
  let c;
  try {
    c = await concierge('s526-api-3', { source: 'test/fixtures/s526/runtime/concierge-keyed.poly' });
  } catch (e) {
    if (/REFUSED/.test(e.message)) {
      assert.fail(`PT33.1: the idempotent clause is not accepted yet: ${e.message}`);
    }
    throw e;
  }
  try {
    let seen;
    handleWith(c.rt, 'payments.refund', async (payload, { api }, ctx) => {
      const first = await api.post(REFUNDS, `amount=${payload.amount}`);
      let secondError;
      try {
        await api.post(REFUNDS, `amount=${payload.amount * 2}`);
      } catch (e) {
        secondError = e;
      }
      seen = { out: { first, secondError } };
      return { status: first.status };
    });
    await c.grant('merchant-1');
    const app = await c.ticket('alice');
    await c.refund(app, 'merchant-1', 40);
    await c.rt.advance();

    assert.ok(seen, 'PT33.4(api-3): handler must run');
    assert.ok(seen.out.secondError instanceof CapabilityRefused,
      `PT33.4(api-3): second post must throw CapabilityRefused, got ${seen.out.secondError?.constructor?.name}`);

    const isInMessage = /PL6406|CAPABILITY_REFUSED/.test(seen.out.secondError.message);
    const audit = c.rt.store.db.prepare('SELECT action, rule, reason FROM pr_audit').all();
    const isInAudit = audit?.some((r) => r.rule === 'PL6406');
    assert.ok(isInMessage || isInAudit, `PT33.4(api-3): second post refusal must cite PL6406`);

    const refundsRequests = c.sent.filter((q) => q.url === REFUNDS);
    assert.equal(refundsRequests.length, 1, `PT33.4(api-3): transport must see exactly one REFUNDS POST, got ${refundsRequests.length}`);
  } finally { await c.rt.close(); }
});

/**
 * PT33.4(api) Test 4: api.get carries no Idempotency-Key header.
 */
test('PT33.4(api-4): api.get carries no Idempotency-Key header', { timeout: 300_000 }, async () => {
  let c;
  try {
    c = await concierge('s526-api-4', { source: 'test/fixtures/s526/runtime/concierge-keyed.poly' });
  } catch (e) {
    if (/REFUSED/.test(e.message)) {
      assert.fail(`PT33.1: the idempotent clause is not accepted yet: ${e.message}`);
    }
    throw e;
  }
  try {
    let seen;
    handleWith(c.rt, 'payments.refund', async (payload, { api }, ctx) => {
      const getResult = await api.get(`${REFUNDS}?id=123`);
      const postResult = await api.post(REFUNDS, `amount=${payload.amount}`);
      seen = { out: { getResult, postResult } };
      return { status: postResult.status };
    });
    await c.grant('merchant-1');
    const app = await c.ticket('alice');
    await c.refund(app, 'merchant-1', 40);
    await c.rt.advance();

    const refundsRequests = c.sent.filter((q) => q.url.startsWith(REFUNDS.split('?')[0]));
    assert.equal(refundsRequests.length, 2, `PT33.4(api-4): must make two REFUNDS requests (GET and POST), got ${refundsRequests.length}`);

    const [getRequest, postRequest] = refundsRequests;
    assert.equal(getRequest.method, 'GET', 'PT33.4(api-4): first request must be GET');
    assert.equal(postRequest.method, 'POST', 'PT33.4(api-4): second request must be POST');

    const getHeaderLower = Object.entries(getRequest.headers || {}).reduce((acc, [k, v]) => {
      acc[k.toLowerCase()] = v;
      return acc;
    }, {});
    assert.ok(!('idempotency-key' in getHeaderLower), `PT33.4(api-4): GET must not have Idempotency-Key header, got ${JSON.stringify(getRequest.headers)}`);

    const postHeaderLower = Object.entries(postRequest.headers || {}).reduce((acc, [k, v]) => {
      acc[k.toLowerCase()] = v;
      return acc;
    }, {});
    assert.ok('idempotency-key' in postHeaderLower, `PT33.4(api-4): POST must have Idempotency-Key header, got ${JSON.stringify(postRequest.headers)}`);
  } finally { await c.rt.close(); }
});

/**
 * PT33.4(api) Test 5: with the first attempt's handler throwing after the api.post
 * and the retry succeeding, both attempts' requests carry the SAME key.
 */
test('PT33.4(api-5): first attempt throws after api.post, retry succeeds, both carry same key', { timeout: 300_000 }, async () => {
  let c;
  try {
    c = await concierge('s526-api-5', { source: 'test/fixtures/s526/runtime/concierge-keyed.poly' });
  } catch (e) {
    if (/REFUSED/.test(e.message)) {
      assert.fail(`PT33.1: the idempotent clause is not accepted yet: ${e.message}`);
    }
    throw e;
  }
  try {
    let handlerAttempts = 0;
    let firstAttemptKey;
    handleWith(c.rt, 'payments.refund', async (payload, { api }, ctx) => {
      handlerAttempts++;
      const result = await api.post(REFUNDS, `attempt=${handlerAttempts}`);

      if (handlerAttempts === 1) {
        firstAttemptKey = ctx.idempotencyKey;
        throw new Error('Lost answer');
      }

      return { status: result.status };
    });
    await c.grant('merchant-1');
    const app = await c.ticket('alice');
    await c.refund(app, 'merchant-1', 40);
    await c.rt.advance();

    c.clock.advance(500);
    await c.rt.advance();

    assert.equal(handlerAttempts, 2, `PT33.4(api-5): handler should run twice, got ${handlerAttempts} times`);

    const refundsRequests = c.sent.filter((q) => q.url === REFUNDS);
    assert.equal(refundsRequests.length, 2, `PT33.4(api-5): should make two REFUNDS POSTs, got ${refundsRequests.length}`);

    const [firstRequest, secondRequest] = refundsRequests;

    const firstHeaderLower = Object.entries(firstRequest.headers || {}).reduce((acc, [k, v]) => {
      acc[k.toLowerCase()] = v;
      return acc;
    }, {});
    const secondHeaderLower = Object.entries(secondRequest.headers || {}).reduce((acc, [k, v]) => {
      acc[k.toLowerCase()] = v;
      return acc;
    }, {});

    assert.ok('idempotency-key' in firstHeaderLower, `PT33.4(api-5): first POST must have Idempotency-Key`);
    assert.ok('idempotency-key' in secondHeaderLower, `PT33.4(api-5): second POST must have Idempotency-Key`);

    const firstKey = firstHeaderLower['idempotency-key'];
    const secondKey = secondHeaderLower['idempotency-key'];
    assert.equal(firstKey, secondKey, `PT33.4(api-5): both attempts must use same key: ${firstKey} vs ${secondKey}`);
    assert.equal(firstKey, firstAttemptKey, `PT33.4(api-5): key must match ctx.idempotencyKey`);
  } finally { await c.rt.close(); }
});

/**
 * PT33.4(api) Test 6: seeded runtime fault idempotency-header-dropped.
 * With the fault, the header is not attached; without it, the header is present through api.
 */
test('PT33.4(api-6): seeded fault idempotency-header-dropped prevents header attachment through api', { timeout: 300_000 }, async () => {
  async function runAttach(fault) {
    let c;
    try {
      c = await concierge(`s526-api-6-${fault ? 'fault' : 'nofault'}`, { source: 'test/fixtures/s526/runtime/concierge-keyed.poly', fault });
    } catch (e) {
      if (/REFUSED/.test(e.message)) {
        assert.fail(`PT33.1: the idempotent clause is not accepted yet: ${e.message}`);
      }
      throw e;
    }
    try {
      let seen;
      handleWith(c.rt, 'payments.refund', async (payload, { api }, ctx) => {
        seen = { ctx, out: await api.post(REFUNDS, `amount=${payload.amount}`) };
        return { status: seen.out.status };
      });
      await c.grant('merchant-1');
      const app = await c.ticket('alice');
      await c.refund(app, 'merchant-1', 40);
      await c.rt.advance();

      const refundsRequests = c.sent.filter((q) => q.url === REFUNDS);
      assert.equal(refundsRequests.length, 1, 'PT33.4(api-6): exactly one refund POST reached the provider in this run (so an absent header is the fault, not a missing request)');
      const [request] = refundsRequests;
      const headerLower = Object.entries(request.headers || {}).reduce((acc, [k, v]) => {
        acc[k.toLowerCase()] = v;
        return acc;
      }, {});
      return headerLower['idempotency-key'];
    } finally { await c.rt.close(); }
  }

  const headerNormal = await runAttach(undefined);
  assert.ok(headerNormal, `PT33.4(api-6): without fault, Idempotency-Key must be present through api`);

  const headerFaulted = await runAttach('idempotency-header-dropped');
  assert.ok(!headerFaulted, `PT33.4(api-6): with fault, Idempotency-Key must be absent through api, got ${headerFaulted}`);
});
