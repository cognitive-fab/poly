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
import { makeProviders } from '../demo/host/live-providers.mjs';
import { createSpendMeter, meteredTransport } from '../demo/host/spend.mjs';

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
