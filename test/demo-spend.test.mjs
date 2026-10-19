// Step 12 (DF10, DAC15): the spend cap, the stub model and the spend line. The launcher's cap flag
// (parsed, enforced, refused before any side effect), the spend meter (reserves before a request,
// refunds after a response, enforces the cap, formats the line), the stub transport (deterministic,
// offline, shaped like the Messages API), and the room's onReply hook. Heavy tests in test/after/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseArgs } from '../demo/launch.mjs';
import { LaunchRefused } from '../demo/host/assemble.mjs';
import { ProviderError } from '../examples/inbox/host/providers.mjs';
import { API_URL } from '../examples/inbox/host/providers.mjs';

// ---- DF10.1: parseArgs and --cap-usd flag --------

test('DF10.1: --cap-usd accepts 5, 0.5, 0.02, 10 as valid values', () => {
  for (const val of ['5', '0.5', '0.02', '10']) {
    const r = parseArgs(['--live', '--cap-usd', val]);
    assert.equal(typeof r.capUsd, 'number', `${val} parses to a number`);
    assert.ok(r.capUsd > 0 && r.capUsd <= 10, `${val} is in valid range`);
  }
});

test('DF10.1: --cap-usd refuses 0, -1, 10.01, 11, abc, 1e1, 5., empty', () => {
  const bad = [
    ['--live', '--cap-usd', '0'],
    ['--live', '--cap-usd', '-1'],
    ['--live', '--cap-usd', '10.01'],
    ['--live', '--cap-usd', '11'],
    ['--live', '--cap-usd', 'abc'],
    ['--live', '--cap-usd', '1e1'],
    ['--live', '--cap-usd', '5.'],
    ['--live', '--cap-usd', ''],
  ];
  for (const argv of bad) {
    assert.throws(() => parseArgs(argv), /cap|usd|10/i, `${argv[2]} should be refused`);
  }
});

test('DF10.1: a value above 10 is refused and the message names 10', () => {
  assert.throws(() => parseArgs(['--live', '--cap-usd', '11']), /10/);
  assert.throws(() => parseArgs(['--live', '--cap-usd', '20']), /10/);
});

test('DF10.1: --live without --cap-usd is refused', () => {
  assert.throws(() => parseArgs(['--live']), /cap|usd/i);
});

test('DF10.1: --cap-usd with --recorded is refused (today because --cap-usd is unknown)', () => {
  assert.throws(() => parseArgs(['--recorded', '--cap-usd', '5']), /cap|usd|unknown/i);
});

test('DF10.1: --cap-usd with no mode is refused (today because --cap-usd is unknown)', () => {
  assert.throws(() => parseArgs(['--cap-usd', '5']), /cap|usd|unknown/i);
});

test('DF10.1: --stub-model needs --cap-usd', () => {
  assert.throws(() => parseArgs(['--stub-model']), /cap|usd|unknown/i);
});

test('DF10.1: --stub-model is exclusive with --live', () => {
  assert.throws(() => parseArgs(['--stub-model', '--cap-usd', '5', '--live']), /either|exclusive|unknown/i);
});

test('DF10.1: --stub-model is exclusive with --recorded', () => {
  assert.throws(() => parseArgs(['--stub-model', '--cap-usd', '5', '--recorded']), /either|exclusive|unknown/i);
});

test('DF10.1: --stub-model with --cap-usd parses correctly', () => {
  const r = parseArgs(['--stub-model', '--cap-usd', '5']);
  assert.equal(r.mode, 'stub-model');
  assert.equal(r.capUsd, 5);
});

test('DF10.1: the result for argument lists without --cap-usd has no capUsd key', () => {
  const r = parseArgs([]);
  assert.ok(!('capUsd' in r), 'recorded has no capUsd');
  assert.deepEqual(Object.keys(r).sort(), ['lan', 'mode', 'port', 'size']);
});

// ---- DF10.2: main catches LaunchRefused and refuses before side effects --------

test('DF10.2: main catches error, prints refused: on err, returns 2', async () => {
  const { main } = await import('../demo/launch.mjs');
  let errLine = null;
  const io = {
    out: () => {},
    err: (s) => { errLine = s; },
    env: new Proxy({}, {
      get(target, prop) {
        throw new Error(`env.${String(prop)} read during refusal`);
      },
    }),
  };
  const result = await main(['--live'], io);
  assert.equal(result, 2, 'main returns 2');
  assert.ok(errLine && /^refused:/.test(errLine), `err prints refused: (got ${errLine})`);
  // The refusal must be the cap's (DF10.1). Today main refuses a live launch for its placeholder price tables, which is not this refusal.
  assert.match(errLine, /cap-usd/, 'the refusal names --cap-usd');
});

test('DF10.2: refusal before io.env is read (env is a Proxy that throws)', async () => {
  const { main } = await import('../demo/launch.mjs');
  let envWasRead = false;
  const io = {
    out: () => {},
    err: () => {},
    env: new Proxy({}, {
      get(target, prop) {
        envWasRead = true;
        throw new Error(`env read: ${String(prop)}`);
      },
    }),
  };
  let errText = '';
  io.err = (x) => { errText += x; };
  const result = await main(['--live'], io);
  assert.equal(result, 2, 'main returns 2 before env is read');
  assert.match(errText, /cap-usd/, 'the refusal names --cap-usd');
  assert.equal(envWasRead, false, 'env was not read during refusal');
});

test('DF10.2: no poly-demo-run-* folder created in tmpdir during refusal', async () => {
  const { main } = await import('../demo/launch.mjs');
  const tmpBefore = new Set(readdirSync(tmpdir()));
  let printed = 0;
  let errText = '';
  const io = {
    out: () => { printed++; },
    err: (x) => { errText += x; },
    env: new Proxy({}, { get: () => undefined }),
  };
  const result = await main(['--live'], io);
  assert.equal(result, 2, 'main returns 2');
  assert.match(errText, /cap-usd/, 'the refusal names --cap-usd');
  assert.equal(printed, 0, 'nothing is printed before the refusal (the diff is a side effect)');
  const tmpAfter = readdirSync(tmpdir());
  for (const entry of tmpAfter) {
    assert.ok(!entry.startsWith('poly-demo-run-') || tmpBefore.has(entry), `no new poly-demo-run-* folder`);
  }
});

// ---- DF10.3: stubTransport (imports in tests, fails on missing module) --------

test('DF10.3: stubTransport returns Messages-shaped body for API_URL', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const t = stubTransport();
  const resp = await t.request({
    method: 'POST',
    url: API_URL,
    headers: {},
    body: JSON.stringify({ system: 'hi', messages: [{ role: 'user', content: 'refund me' }], model: 'claude-3-5-sonnet-20241022', max_tokens: 100 }),
  });
  assert.equal(resp.status, 200);
  const body = JSON.parse(resp.body);
  assert.ok(body.content);
  assert.ok(body.usage);
  assert.equal(typeof body.usage.input_tokens, 'number');
  assert.equal(typeof body.usage.output_tokens, 'number');
});

test('DF10.3: stubTransport refuses other URLs with no route error', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const t = stubTransport();
  await assert.rejects(
    () => t.request({
      method: 'POST',
      url: 'https://api.stripe.com/v1/refunds',
      headers: {},
      body: '{}',
    }),
    /no route/
  );
});

test('DF10.3: stubTransport classifies refund|money back as Refund', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const t = stubTransport();
  const mkReq = (text) => ({
    method: 'POST',
    url: API_URL,
    headers: {},
    body: JSON.stringify({ system: 'classify', messages: [{ role: 'user', content: text }], model: 'claude-3-5-sonnet-20241022', max_tokens: 100 }),
  });

  for (const text of ['refund me', 'Money back please', 'REFUND']) {
    const r = await t.request(mkReq(text));
    const b = JSON.parse(r.body);
    assert.ok(b.content.some(c => c.text.includes('Refund')), `${text} -> Refund`);
  }
});

test('DF10.3: stubTransport classifies order|where|status as Status', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const t = stubTransport();
  const mkReq = (text) => ({
    method: 'POST',
    url: API_URL,
    headers: {},
    body: JSON.stringify({ system: 'classify', messages: [{ role: 'user', content: text }], model: 'claude-3-5-sonnet-20241022', max_tokens: 100 }),
  });

  for (const text of ['order status', 'where is it', 'STATUS']) {
    const r = await t.request(mkReq(text));
    const b = JSON.parse(r.body);
    assert.ok(b.content.some(c => c.text.includes('Status')), `${text} -> Status`);
  }
});

test('DF10.3: stubTransport classifies other text as Other', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const t = stubTransport();
  const mkReq = (text) => ({
    method: 'POST',
    url: API_URL,
    headers: {},
    body: JSON.stringify({ system: 'classify', messages: [{ role: 'user', content: text }], model: 'claude-3-5-sonnet-20241022', max_tokens: 100 }),
  });

  for (const text of ['hello', 'xyz']) {
    const r = await t.request(mkReq(text));
    const b = JSON.parse(r.body);
    assert.ok(b.content.some(c => c.text.includes('Other')), `${text} -> Other`);
  }
});

test('DF10.3: stubTransport amount extracts first whole number', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const t = stubTransport();
  const mkReq = (text) => ({
    method: 'POST',
    url: API_URL,
    headers: {},
    body: JSON.stringify({ system: 'amount', messages: [{ role: 'user', content: text }], model: 'claude-3-5-sonnet-20241022', max_tokens: 100 }),
  });

  const r1 = await t.request(mkReq('refund 50 for me'));
  const b1 = JSON.parse(r1.body);
  const text1 = b1.content[0].text;
  assert.ok(text1.includes('50'), `50 extracted: ${text1}`);
});

test('DF10.3: stubTransport amount is 0 when no number in text', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const t = stubTransport();
  const mkReq = (text) => ({
    method: 'POST',
    url: API_URL,
    headers: {},
    body: JSON.stringify({ system: 'amount', messages: [{ role: 'user', content: text }], model: 'claude-3-5-sonnet-20241022', max_tokens: 100 }),
  });

  const r = await t.request(mkReq('please help me'));
  const b = JSON.parse(r.body);
  const text = b.content[0].text;
  assert.ok(text.includes('0'), `0 when no number: ${text}`);
});

test('DF10.3: stubTransport usage input = ceil(chars / 4), output = 20', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const t = stubTransport();
  const system = 'a'.repeat(8);
  const userMsg = 'b'.repeat(12);
  const resp = await t.request({
    method: 'POST',
    url: API_URL,
    headers: {},
    body: JSON.stringify({
      system,
      messages: [{ role: 'user', content: userMsg }],
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
    }),
  });
  const body = JSON.parse(resp.body);
  const totalChars = system.length + userMsg.length;
  const expectedInput = Math.ceil(totalChars / 4);
  assert.equal(body.usage.input_tokens, expectedInput, `${totalChars} chars = ${expectedInput} input tokens`);
  assert.equal(body.usage.output_tokens, 20, 'output is always 20');
});

test('DF10.3: same request gives same answer (deterministic)', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const t = stubTransport();
  const req = {
    method: 'POST',
    url: API_URL,
    headers: {},
    body: JSON.stringify({ system: 'test', messages: [{ role: 'user', content: 'refund 100' }], model: 'claude-3-5-sonnet-20241022', max_tokens: 100 }),
  };
  const r1 = await t.request(req);
  const r2 = await t.request(req);
  assert.equal(r1.body, r2.body, 'same request gives same response');
});

// ---- DF10.4: createSpendMeter and meteredTransport (imports in tests, fails on missing module) --------

test('DF10.4: createSpendMeter has required interface', async () => {
  const { createSpendMeter } = await import('../demo/host/spend.mjs');
  const meter = createSpendMeter({ capUsd: 5, tables: {} });
  assert.equal(typeof meter.spentUsd, 'function');
  assert.equal(typeof meter.calls, 'function');
  assert.equal(typeof meter.capUsd, 'number');
  assert.equal(typeof meter.capReached, 'function');
  assert.equal(typeof meter.reserve, 'function');
  assert.equal(typeof meter.settle, 'function');
});

test('DF10.4: cost arithmetic exact: 1000 input at 3 per million, 500 output at 15 per million = $0.0105', async () => {
  const { createSpendMeter, meteredTransport } = await import('../demo/host/spend.mjs');
  const inner = {
    request: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1000, output_tokens: 500 } }),
    }),
  };
  const meter = createSpendMeter({
    capUsd: 10,
    tables: { 'test-model': { perMillionTokens: { input: 3, output: 15 } } },
  });
  const wrapped = meteredTransport(inner, meter);
  await wrapped.request({
    method: 'POST',
    url: API_URL,
    headers: {},
    body: JSON.stringify({ model: 'test-model', max_tokens: 100, system: 'hi', messages: [{ role: 'user', content: 'test' }] }),
  });
  const spent = meter.spentUsd();
  assert.equal(spent, 0.0105, `1000*3/1e6 + 500*15/1e6 = $0.0105, got $${spent}`);
});

test('DF10.4: reserve before request, settle after with actual usage', async () => {
  const { createSpendMeter } = await import('../demo/host/spend.mjs');
  const meter = createSpendMeter({
    capUsd: 10,
    tables: { 'test-model': { perMillionTokens: { input: 3, output: 15 } } },
  });
  const req = {
    method: 'POST',
    url: API_URL,
    headers: {},
    body: JSON.stringify({ model: 'test-model', max_tokens: 100, system: 'hi', messages: [{ role: 'user', content: 'test' }] }),
  };
  const res = meter.reserve(req);
  assert.ok(res !== undefined, 'reserve returns a value');
  meter.settle(res, {
    status: 200,
    headers: {},
    body: JSON.stringify({ content: [], usage: { input_tokens: 10, output_tokens: 20 } }),
  });
  assert.ok(meter.spentUsd() > 0, 'settled cost is positive');
});

test('DF10.4: response with non-200 status costs nothing', async () => {
  const { createSpendMeter } = await import('../demo/host/spend.mjs');
  const meter = createSpendMeter({
    capUsd: 10,
    tables: { 'test-model': { perMillionTokens: { input: 3, output: 15 } } },
  });
  const req = {
    method: 'POST',
    url: API_URL,
    headers: {},
    body: JSON.stringify({ model: 'test-model', max_tokens: 100, system: 'hi', messages: [{ role: 'user', content: 'test' }] }),
  };
  const res = meter.reserve(req);
  meter.settle(res, { status: 500, headers: {}, body: '{}' });
  assert.equal(meter.spentUsd(), 0, 'status 500 costs nothing');
});

test('DF10.4: a model id with no table is refused (fail closed)', async () => {
  const { createSpendMeter } = await import('../demo/host/spend.mjs');
  const meter = createSpendMeter({
    capUsd: 10,
    tables: { 'known-model': { perMillionTokens: { input: 3, output: 15 } } },
  });
  assert.throws(
    () => meter.reserve({
      method: 'POST',
      url: API_URL,
      headers: {},
      body: JSON.stringify({ model: 'unknown-model', max_tokens: 100, system: 'hi', messages: [] }),
    }),
    ProviderError,
    'unknown model throws ProviderError'
  );
});

test('DF10.4: spent + reserved + worst case exceeds cap -> throws ProviderError, inner not called', async () => {
  const { createSpendMeter, meteredTransport } = await import('../demo/host/spend.mjs');
  let innerCalled = false;
  const inner = {
    request: async () => {
      innerCalled = true;
      return { status: 200, headers: {}, body: JSON.stringify({ content: [], usage: { input_tokens: 10, output_tokens: 20 } }) };
    },
  };
  const meter = createSpendMeter({
    capUsd: 0.01,
    tables: { 'expensive-model': { perMillionTokens: { input: 1000000, output: 1000000 } } },
  });
  const wrapped = meteredTransport(inner, meter);
  await assert.rejects(
    () => wrapped.request({
      method: 'POST',
      url: API_URL,
      headers: {},
      body: JSON.stringify({ model: 'expensive-model', max_tokens: 1000, system: 'x'.repeat(1000), messages: [] }),
    }),
    /cap|exceed/i
  );
  assert.equal(innerCalled, false, 'inner transport not called when cap would be exceeded');
});

test('DF10.4: concurrent requests never exceed cap (some fulfilled, some rejected)', async () => {
  const { createSpendMeter, meteredTransport } = await import('../demo/host/spend.mjs');
  let requestCount = 0;
  const inner = {
    request: async () => {
      requestCount++;
      await new Promise(r => setImmediate(r));
      return { status: 200, headers: {}, body: JSON.stringify({ content: [], usage: { input_tokens: 100, output_tokens: 100 } }) };
    },
  };
  const meter = createSpendMeter({
    capUsd: 0.1,
    tables: { 'test-model': { perMillionTokens: { input: 1000, output: 1000 } } },
  });
  const wrapped = meteredTransport(inner, meter);
  const reqs = Array(10).fill(0).map(() => ({
    method: 'POST',
    url: API_URL,
    headers: {},
    body: JSON.stringify({ model: 'test-model', max_tokens: 100, system: 'hi', messages: [{ role: 'user', content: 'test' }] }),
  }));
  const results = await Promise.allSettled(reqs.map(r => wrapped.request(r)));
  const fulfilled = results.filter(r => r.status === 'fulfilled').length;
  const rejected = results.filter(r => r.status === 'rejected').length;
  assert.ok(fulfilled > 0, 'at least one request fulfilled');
  assert.ok(rejected > 0, 'at least one request rejected when cap exceeded');
  assert.ok(results.some(r => r.status === 'rejected' && r.reason instanceof ProviderError && /cap/.test(r.reason.message)), 'cap message in rejection');
  assert.ok(meter.spentUsd() <= meter.capUsd, `spent ${meter.spentUsd()} <= cap ${meter.capUsd}`);
});

test('DF10.4: capReached() when request refused for cap', async () => {
  const { createSpendMeter, meteredTransport } = await import('../demo/host/spend.mjs');
  let innerCalled = false;
  const inner = {
    request: async () => {
      innerCalled = true;
      return { status: 200, headers: {}, body: JSON.stringify({ content: [], usage: { input_tokens: 100, output_tokens: 100 } }) };
    },
  };
  const meter = createSpendMeter({
    capUsd: 0.001,
    tables: { 'test-model': { perMillionTokens: { input: 1000000, output: 1000000 } } },
  });
  const wrapped = meteredTransport(inner, meter);
  await assert.rejects(
    () => wrapped.request({
      method: 'POST',
      url: API_URL,
      headers: {},
      body: JSON.stringify({ model: 'test-model', max_tokens: 100, system: 'x'.repeat(1000), messages: [{ role: 'user', content: 'test' }] }),
    }),
    ProviderError
  );
  assert.equal(innerCalled, false, 'inner transport not called when cap would be exceeded');
  assert.ok(meter.capReached(), 'capReached after refused request');
});

test('DF10.4: formatSpend exact format: spend: $X.XXXX of $Y.YY cap, N model calls', async () => {
  const { createSpendMeter, formatSpend } = await import('../demo/host/spend.mjs');
  const meter = createSpendMeter({
    capUsd: 5,
    tables: { 'test-model': { perMillionTokens: { input: 3, output: 15 } } },
  });
  const str = formatSpend(meter);
  assert.match(str, /^spend: \$\d+\.\d{4} of \$\d+\.\d{2} cap, \d+ model calls$/);
  assert.match(str, /of \$5\.00 cap/, 'cap is 2 decimals');
});

// ---- DF10.6: createRoom onReply --------

test('DF10.6: createRoom onReply called with { session } after each delivered reply', async () => {
  const { createRoom } = await import('../demo/host/room.mjs');
  const { supportTransport } = await import('../demo/host/transport.mjs');
  const replies = [];
  const onReply = ({ session }) => {
    replies.push(session);
  };
  const transport = supportTransport(() => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ content: [{ type: 'text', text: 'Hello' }] }),
  }));
  const room = createRoom({
    transport,
    onReply,
  });
  room.join('session-1');
  const result = await room.say('session-1', 'Hi there');
  assert.ok(result.ok, 'message delivered');
  assert.ok(replies.includes('session-1'), `onReply called with session-1, got ${JSON.stringify(replies)}`);
});
