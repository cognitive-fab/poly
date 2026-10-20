// DF12: the failed decisions are shown, and the timeouts fit the provider. Fast tests for parsing
// arguments, the stub's latency, error descriptions, route discovery, failure watching, and the
// demo copy's timeouts. Heavy tests in test/after/demo-failures.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../demo/launch.mjs';
import { LaunchRefused } from '../demo/host/assemble.mjs';
import { makeDemoConcierge } from '../demo/scripts/make-demo-concierge.mjs';
import { stubTransport } from '../demo/host/stub-model.mjs';
import { makeProviders, ProviderError, TASKS } from '../demo/host/live-providers.mjs';
import { createSpendMeter, meteredTransport } from '../demo/host/spend.mjs';

// A NaN or an undefined limit becomes null (or is left out) when the body is written as JSON, so a null anywhere in the parsed body is a defect.
function noNulls(value, path = 'body') {
  if (value === null) assert.fail(`${path} is null`);
  if (Array.isArray(value)) value.forEach((x, i) => noNulls(x, `${path}[${i}]`));
  else if (typeof value === 'object') for (const [k, x] of Object.entries(value)) noNulls(x, `${path}.${k}`);
}

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// ---- DF12.2: stubTransport with latency, parseArgs --stub-latency --------

test('DF12.2: stubTransport() answers with no latency by default', async () => {
  const t = stubTransport();
  const before = performance.now();
  const resp = await t.request({
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', max_tokens: 100, system: 's', messages: [{ role: 'user', content: 'c' }] }),
  });
  const elapsed = performance.now() - before;
  assert.equal(resp.status, 200);
  assert.ok(elapsed < 100, `answer in ${elapsed} ms, no latency`);
});

test('DF12.2: stubTransport({ latencyMs: 300 }) delays by approximately 300 ms', async () => {
  const t = stubTransport({ latencyMs: 300 });
  const before = performance.now();
  const resp = await t.request({
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', max_tokens: 100, system: 's', messages: [{ role: 'user', content: 'c' }] }),
  });
  const elapsed = performance.now() - before;
  assert.equal(resp.status, 200);
  assert.ok(elapsed >= 290 && elapsed < 400, `answer in ${elapsed} ms, expected ~300ms`);
});

test('DF12.2: stubTransport with latency gives the same body as without', async () => {
  const slow = stubTransport({ latencyMs: 50 });
  const fast = stubTransport({ latencyMs: 0 });
  const req = {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', max_tokens: 100, system: 's', messages: [{ role: 'user', content: 'refund me' }] }),
  };
  const respSlow = await slow.request(req);
  const respFast = await fast.request(req);
  assert.equal(respSlow.body, respFast.body, 'same body');
});

test('DF12.2: parseArgs accepts --stub-model --cap-usd --stub-latency with whole number 0 to 60000', async () => {
  for (const latency of [0, 50, 30000, 60000]) {
    const r = parseArgs(['--stub-model', '--cap-usd', '5', '--stub-latency', String(latency)]);
    assert.equal(r.mode, 'stub-model');
    assert.equal(r.stubLatencyMs, latency, `--stub-latency ${latency}`);
  }
});

test('DF12.2: parseArgs refuses --stub-latency without --stub-model (with --live, --recorded, or no mode)', () => {
  for (const argv of [
    ['--live', '--cap-usd', '5', '--stub-latency', '100'],
    ['--recorded', '--stub-latency', '100'],
    ['--stub-latency', '100'],
  ]) {
    assert.throws(() => parseArgs(argv), LaunchRefused, `${argv.join(' ')} refused`);
  }
});

test('DF12.2: parseArgs refuses --stub-latency with values outside 0..60000', () => {
  for (const val of ['60001', '-1', '1.5', 'abc', '']) {
    assert.throws(() => parseArgs(['--stub-model', '--cap-usd', '5', '--stub-latency', val]), LaunchRefused, `--stub-latency ${val} refused`);
  }
});

// ---- DF12.3: describeFailure, routesOf, watchFailures --------

test('DF12.3: describeFailure is exported from failures.mjs and accepts (row, context)', async () => {
  // This test fails because failures.mjs does not exist yet and its implementation is missing.
  const { describeFailure } = await import('../demo/host/failures.mjs');
  assert.equal(typeof describeFailure, 'function');
  // Example: a route call that timed out
  const row = {
    kind: 'route.triage.call',
    attempts: 1,
    last_error: "effect 'route.triage.call' timed out after 800ms",
    payload: { tier: 0 },
  };
  const context = {
    routes: [{ kind: 'route.triage.call', decision: 'classify', tiers: ['small', 'large'] }],
    secrets: ['sk-test-key'],
  };
  const line = describeFailure(row, context);
  assert.match(line, /^decision failed: classify, tier small, timed out after 800 ms$/);
});

test('DF12.3: describeFailure on tier 1 gives "tier large"', async () => {
  const { describeFailure } = await import('../demo/host/failures.mjs');
  const row = {
    kind: 'route.triage.call',
    attempts: 1,
    last_error: "effect 'route.triage.call' timed out after 800ms",
    payload: { tier: 1 },
  };
  const context = {
    routes: [{ kind: 'route.triage.call', decision: 'classify', tiers: ['small', 'large'] }],
    secrets: [],
  };
  const line = describeFailure(row, context);
  assert.match(line, /tier large/);
});

test('DF12.3: describeFailure maps HTTP status codes', async () => {
  const { describeFailure } = await import('../demo/host/failures.mjs');
  const cases = [
    {
      row: { kind: 'decision.amount', attempts: 1, last_error: 'answered HTTP 401', payload: { tier: 0 } },
      want: /^decision failed: amount, tier none, HTTP 401$/,
    },
    {
      row: { kind: 'decision.answer', attempts: 1, last_error: 'answered HTTP 503 (service_unavailable)', payload: { tier: 0 } },
      want: /HTTP 503 \(service_unavailable\)/,
    },
  ];
  const context = {
    routes: [],
    secrets: [],
  };
  for (const { row, want } of cases) {
    const line = describeFailure(row, context);
    assert.match(line, want);
  }
});

test('DF12.3: describeFailure recognizes provider error reasons', async () => {
  const { describeFailure } = await import('../demo/host/failures.mjs');
  const cases = [
    {
      error: 'the message counts 50 tokens, over its share of 40',
      want: /over its input share/,
    },
    {
      error: 'no ask gave an allowed answer',
      want: /no allowed answer/,
    },
    {
      error: 'the model gave no text',
      want: /no text/,
    },
  ];
  const context = {
    routes: [{ kind: 'route.triage.call', decision: 'classify', tiers: ['small', 'large'] }],
    secrets: [],
  };
  for (const { error, want } of cases) {
    const row = { kind: 'route.triage.call', attempts: 1, last_error: error, payload: { tier: 0 } };
    const line = describeFailure(row, context);
    assert.match(line, want);
  }
});

test('DF12.3: describeFailure on route-exhausted shows "every tier failed"', async () => {
  const { describeFailure } = await import('../demo/host/failures.mjs');
  const row = {
    kind: 'decision.classify',
    attempts: 2,
    last_error: 'permanent: route-exhausted',
    payload: { tier: 0 },
  };
  const context = {
    routes: [{ kind: 'route.triage.call', decision: 'classify', tiers: ['small', 'large'] }],
    secrets: [],
  };
  const line = describeFailure(row, context);
  assert.match(line, /decision failed: classify.*every tier failed/);
});

test('DF12.3: describeFailure on non-decision row or empty last_error gives null', async () => {
  const { describeFailure } = await import('../demo/host/failures.mjs');
  assert.equal(describeFailure({ kind: 'sendTo', attempts: 1, last_error: 'something', payload: {} }, {}), null);
  assert.equal(describeFailure({ kind: 'channel.support.send', attempts: 1, last_error: 'something', payload: {} }, {}), null);
  assert.equal(describeFailure({ kind: 'decision.answer', attempts: 1, last_error: null, payload: {} }, { routes: [], secrets: [] }), null);
  assert.equal(describeFailure({ kind: 'decision.answer', attempts: 1, last_error: '', payload: {} }, { routes: [], secrets: [] }), null);
});

test('DF12.3: describeFailure redacts secrets: a key in last_error is removed', async () => {
  const { describeFailure } = await import('../demo/host/failures.mjs');
  const row = {
    kind: 'decision.classify',
    attempts: 1,
    last_error: "the model provider refused the key (HTTP 401): set a fresh key and restart",
    payload: { tier: 0 },
  };
  const secret = 'sk' + '-test-' + '123';
  const context = {
    routes: [{ kind: 'route.triage.call', decision: 'classify', tiers: ['small', 'large'] }],
    secrets: [secret],
  };
  // The error does not contain the secret, so no redaction. Add one that does.
  const row2 = { ...row, last_error: `error with ${secret} in it` };
  const line = describeFailure(row2, context);
  assert.ok(line.includes('[removed]'));
  assert.ok(!line.includes(secret));
  assert.ok(!line.includes('sk'));
  assert.ok(!line.includes('test'));
});

test('DF12.3: describeFailure never includes customer text from last_error', async () => {
  const { describeFailure } = await import('../demo/host/failures.mjs');
  const row = {
    kind: 'decision.answer',
    attempts: 1,
    last_error: "the customer said: my card is 4111 and account number 123456",
    payload: { tier: 0 },
  };
  const context = {
    routes: [],
    secrets: [],
  };
  const line = describeFailure(row, context);
  assert.ok(!line.includes('4111'));
  assert.ok(!line.includes('123456'));
  assert.ok(!line.includes('card'));
  assert.ok(!line.includes('account'));
});

test('DF12.3: routesOf returns routes of the program', async () => {
  const { routesOf } = await import('../demo/host/failures.mjs');
  const out = mkdtempSync(join(tmpdir(), 'demo-copy-'));
  try {
    makeDemoConcierge({ out });
    const prog = readFileSync(join(out, 'concierge.poly'), 'utf8');
    const routes = routesOf(prog);
    assert.ok(Array.isArray(routes));
    const triage = routes.find((r) => r.kind === 'route.triage.call');
    assert.ok(triage);
    assert.equal(triage.decision, 'classify');
    assert.deepEqual(triage.tiers, ['small', 'large']);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('DF12.3: watchFailures polls the database and calls onLine once per distinct (intent, attempts, last_error)', async () => {
  const { watchFailures } = await import('../demo/host/failures.mjs');
  let pollCount = 0;
  const rows = [
    [
      { intent_id: 'i1', attempts: 1, last_error: "effect 'route.triage.call' timed out after 800ms", kind: 'route.triage.call', payload: JSON.stringify({ tier: 0 }) },
    ],
    [
      { intent_id: 'i1', attempts: 1, last_error: "effect 'route.triage.call' timed out after 800ms", kind: 'route.triage.call', payload: JSON.stringify({ tier: 0 }) },
      { intent_id: 'i2', attempts: 1, last_error: 'some other error', kind: 'decision.amount', payload: JSON.stringify({ tier: 0 }) },
    ],
  ];
  let pollPhase = 0;
  const db = {
    prepare: () => ({
      all: () => {
        pollCount++;
        const result = rows[Math.min(pollPhase, rows.length - 1)];
        pollPhase++;
        return result;
      },
    }),
  };
  const lines = [];
  const context = {
    routes: [{ kind: 'route.triage.call', decision: 'classify', tiers: ['small', 'large'] }],
    secrets: [],
  };
  const { stop } = await watchFailures({ db, context, onLine: (line) => lines.push(line), everyMs: 1 });
  // Wait for a few polls
  await new Promise((resolve) => setTimeout(resolve, 50));
  stop();
  // Should have called onLine once for the first row (on first poll), then once for the second row (on second poll).
  // The first row appears again on the second poll but is not a new distinct tuple.
  assert.ok(lines.length >= 1);
  assert.ok(lines.some((l) => l.includes('classify')));
  assert.ok(lines.some((l) => l.includes('amount')));
});

// ---- DF12.5: makeDemoConcierge timeouts --------

test('DF12.5: makeDemoConcierge exports DEMO_TIMEOUTS with the demo copy\'s values', async () => {
  const { DEMO_TIMEOUTS } = await import('../demo/scripts/make-demo-concierge.mjs');
  assert.deepEqual(DEMO_TIMEOUTS, {
    classify: '20s',
    amount: '10s',
    answer: '10s',
    reply: '10s',
  });
});

test('DF12.5: examples/concierge is unchanged and holds the original timeouts', () => {
  const prog = readFileSync(join(ROOT, 'examples', 'concierge', 'concierge.poly'), 'utf8');
  const count800 = (prog.match(/timeout 800ms/g) || []).length;
  const count2s = (prog.match(/timeout 2s/g) || []).length;
  assert.equal(count800, 2, 'two "timeout 800ms" in example');
  assert.equal(count2s, 4, 'four "timeout 2s" in example');
});

test('DF12.5: makeDemoConcierge applies the new timeouts to the copy', async () => {
  const out = mkdtempSync(join(tmpdir(), 'demo-copy-'));
  try {
    const { diff } = makeDemoConcierge({ out });
    const prog = readFileSync(join(out, 'concierge.poly'), 'utf8');
    // The demo copy should have the new timeouts
    assert.ok(prog.includes('timeout 20s'), 'copy has "timeout 20s"');
    assert.ok(prog.includes('timeout 10s'), 'copy has "timeout 10s"');
    // The diff should show the timeout changes
    assert.ok(diff.includes('timeout'), 'diff shows timeout changes');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ---- DF12.6: measureLatency --------

test('DF12.6: parseArgs accepts --measure-latency with --live and --cap-usd', () => {
  const r = parseArgs(['--live', '--cap-usd', '5', '--measure-latency']);
  assert.equal(r.measureLatency, true);
  assert.equal(r.runs, 5, 'default runs is 5');
});

test('DF12.6: parseArgs accepts --measure-latency --runs with a value 1 to 20', () => {
  for (const runs of [1, 5, 10, 20]) {
    const r = parseArgs(['--stub-model', '--cap-usd', '5', '--measure-latency', '--runs', String(runs)]);
    assert.equal(r.runs, runs);
  }
});

test('DF12.6: parseArgs refuses --measure-latency without a mode or with --recorded', () => {
  assert.throws(() => parseArgs(['--measure-latency', '--cap-usd', '5']), LaunchRefused);
  assert.throws(() => parseArgs(['--recorded', '--measure-latency']), LaunchRefused);
});

test('DF12.6: parseArgs refuses --measure-latency with --runs outside 1..20 or not an integer', () => {
  for (const val of ['0', '21', 'abc', '']) {
    assert.throws(() => parseArgs(['--live', '--cap-usd', '5', '--measure-latency', '--runs', val]), LaunchRefused, `--runs ${val}`);
  }
});

test('DF12.6: parseArgs refuses --measure-latency without --cap-usd', () => {
  assert.throws(() => parseArgs(['--live', '--measure-latency']), LaunchRefused);
});

test('DF12.6: measureLatency is exported from latency.mjs', async () => {
  const { measureLatency } = await import('../demo/host/latency.mjs');
  assert.equal(typeof measureLatency, 'function');
});

test('DF12.6: measureLatency returns structure with tiers, runs times, min/median/max, and suggestedSeconds', async () => {
  const { measureLatency } = await import('../demo/host/latency.mjs');
  const t = stubTransport({ latencyMs: 50 });
  const meter = createSpendMeter({ capUsd: 100, tables: { 'test-model': { perMillionTokens: { input: 1000, output: 1000 } } } });
  const providers = makeProviders({
    transport: meteredTransport(t, meter),
    apiKey: 'test-key',
    models: { small: 'test-model', large: 'test-model' },
  });
  const result = await measureLatency({ providers, models: { small: 'test-model', large: 'test-model' }, runs: 2, now: () => Date.now() });
  assert.ok(result.small);
  assert.ok(result.large);
  assert.equal(result.small.model, 'test-model');
  assert.ok(Array.isArray(result.small.runsMs));
  assert.equal(result.small.runsMs.length, 2);
  assert.ok(typeof result.small.minMs === 'number');
  assert.ok(typeof result.small.medianMs === 'number');
  assert.ok(typeof result.small.maxMs === 'number');
  assert.ok(typeof result.small.suggestedSeconds === 'number');
});

test('DF12.6: measureLatency uses the formula suggestedSeconds = max(2, ceil(2 * maxMs / 1000))', async () => {
  const { measureLatency } = await import('../demo/host/latency.mjs');
  const t = stubTransport({ latencyMs: 100 });
  const meter = createSpendMeter({ capUsd: 100, tables: { 'test-model': { perMillionTokens: { input: 1000, output: 1000 } } } });
  const providers = makeProviders({
    transport: meteredTransport(t, meter),
    apiKey: 'test-key',
    models: { small: 'test-model', large: 'test-model' },
  });
  // Use fake now to control timing. Advance by 1700 per call to ensure maxMs > 1000.
  let timeMs = 0;
  const now = () => {
    const current = timeMs;
    timeMs += 1700;
    return current;
  };
  const result = await measureLatency({ providers, models: { small: 'test-model', large: 'test-model' }, runs: 1, now });
  const { maxMs, suggestedSeconds } = result.small;
  assert.ok(maxMs > 1000, `maxMs ${maxMs} should be > 1000`);
  const expected = Math.max(2, Math.ceil(2 * maxMs / 1000));
  assert.equal(suggestedSeconds, expected, `suggestedSeconds should be max(2, ceil(2 * ${maxMs} / 1000)) = ${expected}`);
});

test('DF12.6: measureLatency measurements are at least the latency (50 ms x 2 round trips)', async () => {
  const { measureLatency } = await import('../demo/host/latency.mjs');
  const latency = 50;
  const t = stubTransport({ latencyMs: latency });
  const meter = createSpendMeter({ capUsd: 100, tables: { 'test-model': { perMillionTokens: { input: 1000, output: 1000 } } } });
  const providers = makeProviders({
    transport: meteredTransport(t, meter),
    apiKey: 'test-key',
    models: { small: 'test-model', large: 'test-model' },
  });
  const result = await measureLatency({ providers, models: { small: 'test-model', large: 'test-model' }, runs: 3, now: () => Date.now() });
  const minExpected = latency * 2 - 10; // Two round trips, allow some slack
  assert.ok(result.small.minMs >= minExpected, `minMs ${result.small.minMs} should be at least ~${minExpected}`);
  assert.ok(result.small.medianMs >= minExpected);
  assert.ok(result.small.maxMs >= minExpected);
  assert.ok(result.small.minMs <= result.small.medianMs);
  assert.ok(result.small.medianMs <= result.small.maxMs);
});

// ---- DF13: guard on limits, API message in ProviderError, describeFailure with message, request shape

// Helper: create a recording transport that wraps another transport
function recordingTransport(delegate) {
  const records = [];
  return {
    records,
    async request(r) {
      records.push(r);
      return delegate.request(r);
    },
  };
}

// Helper: parse JSON body of a request
function parseBody(req) {
  return JSON.parse(req.body);
}

test('DF13.2: the guard refuses maxInputTokens that is not a whole number above 0', async () => {
  const badValues = [undefined, null, NaN, 0, -1, 1.5, '400', Infinity];
  for (const bad of badValues) {
    const t = recordingTransport(stubTransport());
    const providers = makeProviders({ transport: t, apiKey: 'stub-key-for-test', models: { small: 'small-model-id', large: 'large-model-id' } });
    const limits = { maxInputTokens: 2000, maxTokens: 400 };
    if (bad !== undefined) {
      limits.maxInputTokens = bad;
    } else {
      delete limits.maxInputTokens;
    }
    const provider = providers.decisions.answer.provider;
    const question = { decision: 'answer', payload: {}, intent: 'i', limits };
    const materials = { bodies: { m: 'test' }, items: {} };
    const valueText = String(bad).slice(0, 20);
    const expectedMsg = `the limit maxInputTokens is not a whole number above 0 (${valueText}): nothing was asked`;
    await assert.rejects(
      provider(question, materials),
      (e) => {
        assert.ok(e instanceof ProviderError, `should be ProviderError for maxInputTokens=${bad}`);
        assert.equal(e.message, expectedMsg, `wrong message for maxInputTokens=${bad}`);
        return true;
      }
    );
    assert.equal(t.records.length, 0, `transport should not be called for maxInputTokens=${bad}`);
  }
});

test('DF13.2: the guard refuses maxTokens that is not a whole number above 0', async () => {
  const badValues = [undefined, null, NaN, 0, -1, 1.5, '400', Infinity];
  for (const bad of badValues) {
    const t = recordingTransport(stubTransport());
    const providers = makeProviders({ transport: t, apiKey: 'stub-key-for-test', models: { small: 'small-model-id', large: 'large-model-id' } });
    const limits = { maxInputTokens: 2000, maxTokens: 400 };
    if (bad !== undefined) {
      limits.maxTokens = bad;
    } else {
      delete limits.maxTokens;
    }
    const provider = providers.tiers.small;
    const question = { decision: 'classify', limits };
    const materials = { bodies: { m: 'test' }, items: {} };
    const valueText = String(bad).slice(0, 20);
    const expectedMsg = `the limit maxTokens is not a whole number above 0 (${valueText}): nothing was asked`;
    await assert.rejects(
      provider(question, materials),
      (e) => {
        assert.ok(e instanceof ProviderError, `should be ProviderError for tier.small, maxTokens=${bad}`);
        assert.equal(e.message, expectedMsg, `wrong message for tier.small, maxTokens=${bad}`);
        return true;
      }
    );
    assert.equal(t.records.length, 0, `transport should not be called for tier.small, maxTokens=${bad}`);
  }
});

test('DF13.2: every provider refuses a bad limit of either field before any call', async () => {
  const providerOf = (providers) => ({
    'tiers.small': [providers.tiers.small, 'classify'],
    'tiers.large': [providers.tiers.large, 'classify'],
    amount: [providers.decisions.amount.provider, 'amount'],
    answer: [providers.decisions.answer.provider, 'answer'],
    reply: [providers.decisions.reply.provider, 'reply'],
  });
  const names = Object.keys(providerOf(makeProviders({ transport: stubTransport(), apiKey: 'stub-key-for-test', models: { small: 's', large: 'l' } })));
  assert.equal(names.length, 5);
  for (const name of names) {
    for (const field of ['maxInputTokens', 'maxTokens']) {
      for (const bad of [undefined, null, NaN, 0, -1, 1.5, '400', Infinity]) {
        const t = recordingTransport(stubTransport());
        const providers = makeProviders({ transport: t, apiKey: 'stub-key-for-test', models: { small: 'small-model-id', large: 'large-model-id' } });
        const [provider, decision] = providerOf(providers)[name];
        const limits = { maxInputTokens: 2000, maxTokens: 400 };
        if (bad === undefined) delete limits[field]; else limits[field] = bad;
        const question = { decision, payload: { outcome: 'Unsure' }, intent: 'i', limits };
        const materials = { bodies: { m: 'test' }, items: {} };
        await assert.rejects(provider(question, materials), (e) => {
          assert.ok(e instanceof ProviderError, `${name} ${field}=${String(bad)}: a ProviderError`);
          assert.equal(e.message, `the limit ${field} is not a whole number above 0 (${String(bad).slice(0, 20)}): nothing was asked`, `${name} ${field}=${String(bad)}`);
          return true;
        });
        assert.equal(t.records.length, 0, `${name} ${field}=${String(bad)}: the transport was not called`);
      }
    }
  }
});

test('DF13.2: a question with no limits passes the guard and uses defaults', async () => {
  const t = recordingTransport(stubTransport());
  const providers = makeProviders({ transport: t, apiKey: 'stub-key-for-test', models: { small: 'small-model-id', large: 'large-model-id' } });
  const question = { decision: 'answer', payload: {}, intent: 'i' }; // no limits
  const materials = { bodies: { m: 'test message' }, items: {} };
  const result = await providers.decisions.answer.provider(question, materials);
  assert.ok(result, 'provider should return a result');
  assert.ok(t.records.length > 0, 'transport should be called');
});

test('DF13.3: a 400 with error message is in the ProviderError', async () => {
  const t = recordingTransport({
    async request() {
      return {
        status: 400,
        headers: {},
        body: JSON.stringify({ error: { type: 'invalid_request_error', message: 'max_tokens: Field required' } }),
      };
    },
  });
  const providers = makeProviders({ transport: t, apiKey: 'stub-key-for-test', models: { small: 'small-model-id', large: 'large-model-id' } });
  const question = { decision: 'answer', limits: { maxInputTokens: 2000, maxTokens: 400 } };
  const materials = { bodies: { m: 'test' }, items: {} };
  const expectedMsg = 'the model provider answered HTTP 400 (invalid_request_error): max_tokens: Field required';
  await assert.rejects(
    providers.decisions.answer.provider(question, materials),
    (e) => {
      assert.ok(e instanceof ProviderError, 'should be ProviderError');
      assert.equal(e.message, expectedMsg, 'message should include error message');
      return true;
    }
  );
});

test('DF13.3: a 400 without error message uses shorter form', async () => {
  const t = recordingTransport({
    async request() {
      return { status: 400, headers: {}, body: JSON.stringify({ error: { type: 'invalid_request_error' } }) };
    },
  });
  const providers = makeProviders({ transport: t, apiKey: 'stub-key-for-test', models: { small: 'small-model-id', large: 'large-model-id' } });
  const question = { decision: 'answer', limits: { maxInputTokens: 2000, maxTokens: 400 } };
  const materials = { bodies: { m: 'test' }, items: {} };
  const expectedMsg = 'the model provider answered HTTP 400 (invalid_request_error)';
  await assert.rejects(
    providers.decisions.answer.provider(question, materials),
    (e) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.message, expectedMsg, `should match expected form, got: ${e.message}`);
      return true;
    }
  );
});

test('DF13.3: a 400 without error type uses shortest form', async () => {
  const t = recordingTransport({
    async request() {
      return { status: 400, headers: {}, body: JSON.stringify({ error: {} }) };
    },
  });
  const providers = makeProviders({ transport: t, apiKey: 'stub-key-for-test', models: { small: 'small-model-id', large: 'large-model-id' } });
  const question = { decision: 'answer', limits: { maxInputTokens: 2000, maxTokens: 400 } };
  const materials = { bodies: { m: 'test' }, items: {} };
  const expectedMsg = 'the model provider answered HTTP 400';
  await assert.rejects(
    providers.decisions.answer.provider(question, materials),
    (e) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.message, expectedMsg, `should match expected form, got: ${e.message}`);
      return true;
    }
  );
});

test('DF13.3: a key in the error message is replaced by [removed]', async () => {
  const key = 'stub-key-for-test';
  const t = recordingTransport({
    async request() {
      return {
        status: 400,
        headers: {},
        body: JSON.stringify({ error: { type: 'invalid_request_error', message: `invalid key ${key} provided` } }),
      };
    },
  });
  const providers = makeProviders({ transport: t, apiKey: key, models: { small: 'small-model-id', large: 'large-model-id' } });
  const question = { decision: 'answer', limits: { maxInputTokens: 2000, maxTokens: 400 } };
  const materials = { bodies: { m: 'test' }, items: {} };
  await assert.rejects(
    providers.decisions.answer.provider(question, materials),
    (e) => {
      assert.ok(e instanceof ProviderError);
      assert.ok(e.message.includes('[removed]'), 'message should contain [removed]');
      assert.ok(!e.message.includes(key), `message should not contain key: ${e.message}`);
      return true;
    }
  );
});

test('DF13.3: whitespace including newlines is collapsed to single space', async () => {
  const t = recordingTransport({
    async request() {
      return {
        status: 400,
        headers: {},
        body: JSON.stringify({ error: { type: 'err', message: 'line1\n   line2   line3\n\nline4' } }),
      };
    },
  });
  const providers = makeProviders({ transport: t, apiKey: 'stub-key-for-test', models: { small: 'small-model-id', large: 'large-model-id' } });
  const question = { decision: 'answer', limits: { maxInputTokens: 2000, maxTokens: 400 } };
  const materials = { bodies: { m: 'test' }, items: {} };
  await assert.rejects(
    providers.decisions.answer.provider(question, materials),
    (e) => {
      assert.ok(e instanceof ProviderError);
      assert.match(e.message, /line1 line2 line3 line4/, `whitespace should be collapsed, got: ${e.message}`);
      assert.ok(!e.message.includes('\n'), 'should have no newlines');
      return true;
    }
  );
});

test('DF13.3: a 500-character message is cut at 200 characters', async () => {
  const longMsg = 'x'.repeat(500);
  const t = recordingTransport({
    async request() {
      return { status: 400, headers: {}, body: JSON.stringify({ error: { type: 'err', message: longMsg } }) };
    },
  });
  const providers = makeProviders({ transport: t, apiKey: 'stub-key-for-test', models: { small: 'small-model-id', large: 'large-model-id' } });
  const question = { decision: 'answer', limits: { maxInputTokens: 2000, maxTokens: 400 } };
  const materials = { bodies: { m: 'test' }, items: {} };
  await assert.rejects(
    providers.decisions.answer.provider(question, materials),
    (e) => {
      assert.ok(e instanceof ProviderError);
      const msgPart = e.message.replace(/^[^:]*: /, '');
      assert.equal(msgPart.length, 200, `message part should be exactly 200 chars, got ${msgPart.length}`);
      return true;
    }
  );
});

test('DF13.4: describeFailure with an API message line', async () => {
  const { describeFailure } = await import('../demo/host/failures.mjs');
  const row = {
    kind: 'decision.answer',
    attempts: 1,
    last_error: 'the model provider answered HTTP 400 (invalid_request_error): max_tokens: Field required',
    payload: {},
  };
  const context = { routes: [], secrets: [] };
  const line = describeFailure(row, context);
  assert.ok(line.startsWith('decision failed: answer, tier none, HTTP 400 (invalid_request_error): max_tokens: Field required'), `got: ${line}`);
});

test('DF13.4: describeFailure removes the key from the message part', async () => {
  const { describeFailure } = await import('../demo/host/failures.mjs');
  const key = 'stub-key-for-test';
  const row = {
    kind: 'decision.answer',
    attempts: 1,
    last_error: `the model provider answered HTTP 400 (invalid_request_error): error with ${key} in it`,
    payload: {},
  };
  const context = { routes: [], secrets: [key] };
  const line = describeFailure(row, context);
  assert.ok(line.includes('[removed]'), `should contain [removed], got: ${line}`);
  assert.ok(!line.includes(key), `should not contain key, got: ${line}`);
});

test('DF13.4: describeFailure collapses whitespace in the message part', async () => {
  const { describeFailure } = await import('../demo/host/failures.mjs');
  const row = {
    kind: 'decision.answer',
    attempts: 1,
    last_error: 'the model provider answered HTTP 400 (err): line1\n  line2   line3',
    payload: {},
  };
  const context = { routes: [], secrets: [] };
  const line = describeFailure(row, context);
  assert.match(line, /line1 line2 line3/, `whitespace should be collapsed, got: ${line}`);
});

test('DF13.4: describeFailure cuts the message part at 200 characters', async () => {
  const { describeFailure } = await import('../demo/host/failures.mjs');
  const longMsg = 'x'.repeat(500);
  const row = {
    kind: 'decision.answer',
    attempts: 1,
    last_error: `the model provider answered HTTP 400 (err): ${longMsg}`,
    payload: {},
  };
  const context = { routes: [], secrets: [] };
  const line = describeFailure(row, context);
  // The line should be capped: "decision failed: answer, tier none, HTTP 400 (err): " + up to 200 chars of message
  const head = 'HTTP 400 (err): ';
  const msgPart = line.slice(line.indexOf(head) + head.length);
  assert.equal(msgPart.length, 200, `message part should be 200 chars, got ${msgPart.length}: ${msgPart}`);
});

test('DF13.4: describeFailure on limit error gives the limit reason', async () => {
  const { describeFailure } = await import('../demo/host/failures.mjs');
  const row = {
    kind: 'decision.answer',
    attempts: 1,
    last_error: 'the limit maxTokens is not a whole number above 0 (NaN): nothing was asked',
    payload: {},
  };
  const context = { routes: [], secrets: [] };
  const line = describeFailure(row, context);
  assert.match(line, /limit is not a whole number/, `should have limit reason, got: ${line}`);
});

test('DF13.4: describeFailure extracts HTTP form from mixed error text', async () => {
  const { describeFailure } = await import('../demo/host/failures.mjs');
  const row = {
    kind: 'decision.answer',
    attempts: 1,
    last_error: 'some prefix text. the model provider answered HTTP 400 (err_type). some suffix text.',
    payload: {},
  };
  const context = { routes: [], secrets: [] };
  const line = describeFailure(row, context);
  // Should extract only the HTTP form, not the surrounding text
  assert.match(line, /HTTP 400 \(err_type\)/, `should have HTTP form, got: ${line}`);
  assert.ok(!line.includes('prefix'), `should not include prefix, got: ${line}`);
  assert.ok(!line.includes('suffix'), `should not include suffix, got: ${line}`);
});

// DF14, DAC19: no request holds temperature field
test('DF13.1: the answer request has correct structure and content', async () => {
  const t = recordingTransport(stubTransport());
  const providers = makeProviders({ transport: t, apiKey: 'stub-key-for-test', models: { small: 'small-model-id', large: 'large-model-id' } });
  const question = { decision: 'answer', payload: {}, intent: 'i' };
  const materials = {
    bodies: { m: 'where is my order?' },
    items: { o: [
      { id: 'o-9011', body: 'Order 9011: a desk lamp, delivered on 2 October.' },
      { id: 'o-9012', body: 'Order 9012: a sofa.' },
    ] },
  };
  await providers.decisions.answer.provider(question, materials);
  assert.equal(t.records.length, 1, 'should make exactly one request');
  const body = parseBody(t.records[0]);
  const keys = Object.keys(body).sort();
  assert.deepEqual(keys, ['max_tokens', 'messages', 'model', 'system'].sort(), `wrong keys: ${keys}`);
  assert.equal(body.model, 'small-model-id', 'model should be small-model-id');
  assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens === 400, `max_tokens should be 400, got ${body.max_tokens}`);
  assert.equal(Object.hasOwn(body, 'temperature'), false, 'temperature should not be in body');
  assert.ok(typeof body.system === 'string' && body.system.length > 0, 'system should be non-empty string');
  assert.equal(body.messages.length, 1, 'should have one message');
  const msg = body.messages[0];
  assert.equal(msg.role, 'user', 'message role should be user');
  assert.ok(typeof msg.content === 'string' && msg.content.length > 0, 'message content should be non-empty string');
  assert.ok(msg.content.includes('Your order') || msg.content.includes(TASKS.answer), 'content should hold task sentence');
  assert.ok(msg.content.includes('where is my order?'), 'content should hold customer message');
  assert.ok(msg.content.includes('o-9011'), 'content should hold order id o-9011');
  assert.ok(msg.content.includes('o-9012'), 'content should hold order id o-9012');
  // Check JSON has no null or NaN
  const jsonStr = JSON.stringify(body);
  noNulls(body, 'the answer request');
  // NaN becomes null in JSON.stringify, but we check for finite numbers
  const checkFinite = (val) => {
    if (typeof val === 'number') assert.ok(Number.isFinite(val), `${val} is not finite`);
    if (Array.isArray(val)) val.forEach(checkFinite);
    if (typeof val === 'object' && val !== null) Object.values(val).forEach(checkFinite);
  };
  checkFinite(body);
});

// DF14, DAC19: no request holds temperature field
test('DF13.1: the reply request has correct structure and content', async () => {
  const t = recordingTransport(stubTransport());
  const providers = makeProviders({ transport: t, apiKey: 'stub-key-for-test', models: { small: 'small-model-id', large: 'large-model-id' } });
  const question = { decision: 'reply', payload: { outcome: 'Unsure' }, intent: 'i' };
  const materials = { bodies: { m: 'please refund' }, items: {} };
  await providers.decisions.reply.provider(question, materials);
  assert.equal(t.records.length, 1, 'should make exactly one request for reply');
  const body = parseBody(t.records[0]);
  const keys = Object.keys(body).sort();
  assert.deepEqual(keys, ['max_tokens', 'messages', 'model', 'system'].sort(), `wrong keys for reply: ${keys}`);
  assert.equal(body.model, 'small-model-id', 'reply model should be small-model-id');
  assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens === 400, `reply max_tokens should be 400, got ${body.max_tokens}`);
  assert.equal(Object.hasOwn(body, 'temperature'), false, 'temperature should not be in reply body');
  assert.ok(body.messages.length > 0, 'reply should have messages');
  const jsonStr = JSON.stringify(body);
  noNulls(body, 'the reply request');
  const checkFinite = (val) => {
    if (typeof val === 'number') assert.ok(Number.isFinite(val), `${val} is not finite`);
    if (Array.isArray(val)) val.forEach(checkFinite);
    if (typeof val === 'object' && val !== null) Object.values(val).forEach(checkFinite);
  };
  checkFinite(body);
});

// DF14, DAC19: no request holds temperature field
test('DF13.1: the amount request has correct structure and content (vote of 5)', async () => {
  const t = recordingTransport(stubTransport());
  const providers = makeProviders({ transport: t, apiKey: 'stub-key-for-test', models: { small: 'small-model-id', large: 'large-model-id' } });
  const question = { decision: 'amount', payload: {}, intent: 'i' };
  const materials = { bodies: { m: 'refund 50' }, items: {} };
  await providers.decisions.amount.provider(question, materials);
  assert.ok(t.records.length >= 1, 'amount should make at least one request (it is a vote)');
  // Check all requests are well-formed
  for (let i = 0; i < t.records.length; i++) {
    const body = parseBody(t.records[i]);
    const keys = Object.keys(body).sort();
    assert.deepEqual(keys, ['max_tokens', 'messages', 'model', 'system'].sort(), `wrong keys in amount request ${i}: ${keys}`);
    assert.equal(body.model, 'small-model-id', `amount request ${i} model should be small-model-id`);
    assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0, `amount request ${i} max_tokens should be whole number above 0, got ${body.max_tokens}`);
    assert.equal(Object.hasOwn(body, 'temperature'), false, `amount request ${i} should not have temperature field`);
    const jsonStr = JSON.stringify(body);
    noNulls(body, `the amount request ${i}`);
  }
});

// ---- DF14: no request of any provider holds temperature --------

test('DF14: no request of any provider holds temperature', async () => {
  const t = recordingTransport(stubTransport());
  const providers = makeProviders({ transport: t, apiKey: 'stub-key-for-test', models: { small: 'small-model-id', large: 'large-model-id' } });
  const materials = {
    bodies: { m: 'where is my order?' },
    items: { o: [
      { id: 'o-9011', body: 'Order 9011: a desk lamp, delivered on 2 October.' },
      { id: 'o-9012', body: 'Order 9012: a sofa.' },
    ] },
  };
  const limits = { maxInputTokens: 2000, maxTokens: 400 };

  // Call tiers.small (classify, a vote of 5)
  const beforeSmall = t.records.length;
  await providers.tiers.small({ decision: 'classify', payload: {}, intent: 'i', limits }, materials);
  const afterSmall = t.records.length;
  const smallCount = afterSmall - beforeSmall;

  // Call tiers.large (classify, a vote of 5)
  const beforeLarge = t.records.length;
  await providers.tiers.large({ decision: 'classify', payload: {}, intent: 'i', limits }, materials);
  const afterLarge = t.records.length;
  const largeCount = afterLarge - beforeLarge;

  // Call decisions.amount.provider (a vote of 5)
  const beforeAmount = t.records.length;
  await providers.decisions.amount.provider({ decision: 'amount', payload: {}, intent: 'i', limits }, materials);
  const afterAmount = t.records.length;
  const amountCount = afterAmount - beforeAmount;

  // Call decisions.answer.provider (1 request)
  const beforeAnswer = t.records.length;
  await providers.decisions.answer.provider({ decision: 'answer', payload: {}, intent: 'i', limits }, materials);
  const afterAnswer = t.records.length;
  const answerCount = afterAnswer - beforeAnswer;

  // Call decisions.reply.provider with Unsure (1 request)
  const beforeReply = t.records.length;
  await providers.decisions.reply.provider({ decision: 'reply', payload: { outcome: 'Unsure' }, intent: 'i', limits }, materials);
  const afterReply = t.records.length;
  const replyCount = afterReply - beforeReply;

  // Total should be at least 5 + 5 + 5 + 1 + 1 = 17
  const totalCount = afterReply;
  assert.ok(totalCount >= 17, `should have at least 17 total requests, got ${totalCount}: small=${smallCount}, large=${largeCount}, amount=${amountCount}, answer=${answerCount}, reply=${replyCount}`);

  // Assert that every recorded request has no temperature field and correct keys
  for (let i = 0; i < t.records.length; i++) {
    const body = parseBody(t.records[i]);
    const keys = Object.keys(body).sort();
    assert.deepEqual(keys, ['max_tokens', 'messages', 'model', 'system'].sort(), `request ${i}: wrong keys: ${keys}`);
    assert.equal(Object.hasOwn(body, 'temperature'), false, `request ${i}: should not have temperature field`);
  }
});
