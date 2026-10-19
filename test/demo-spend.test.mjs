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
import { ProviderError, API_URL } from '../examples/inbox/host/providers.mjs';
import { makeProviders, TASKS } from '../demo/host/live-providers.mjs';

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

const MODEL = 'test-model';
// A request as the live providers send it: the task sentence in the user turn, the customer's text inside message tags.
const providerRequest = (task, text, extra = '') => ({
  method: 'POST',
  url: API_URL,
  headers: {},
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 100,
    system: 'You work on a shop\'s customer desk.',
    messages: [{ role: 'user', content: `Task: ${TASKS[task]}${extra}\n\n<message>\n${text}\n</message>` }],
  }),
});
const answerOf = (resp) => JSON.parse(JSON.parse(resp.body).content.filter((c) => c.type === 'text').map((c) => c.text).join(''));
const raw = (system, user, max = 100) => ({ method: 'POST', url: API_URL, headers: {}, body: JSON.stringify({ model: MODEL, max_tokens: max, system, messages: [{ role: 'user', content: user }] }) });

test('DF10.3: stubTransport returns a Messages-shaped body for the Messages URL', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const resp = await stubTransport().request(providerRequest('classify', 'refund me'));
  assert.equal(resp.status, 200);
  const body = JSON.parse(resp.body);
  assert.ok(Array.isArray(body.content) && body.content[0].type === 'text');
  assert.equal(typeof body.usage.input_tokens, 'number');
  assert.equal(typeof body.usage.output_tokens, 'number');
});

test('DF10.3: stubTransport refuses other URLs with a no route error', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  await assert.rejects(() => stubTransport().request({ method: 'POST', url: 'https://api.stripe.com/v1/refunds', headers: {}, body: '{}' }), /no route/);
});

test('DF10.3: classify answers Refund, Status or Other by the customer\'s text alone (the task sentence holds the words refund and order)', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const t = stubTransport();
  const cases = [['refund me', 'Refund'], ['Money back please', 'Refund'], ['REFUND', 'Refund'], ['order status', 'Status'], ['where is it', 'Status'], ['STATUS', 'Status'], ['hello', 'Other'], ['xyz', 'Other']];
  for (const [text, want] of cases) {
    assert.deepEqual(answerOf(await t.request(providerRequest('classify', text))), { answer: want }, text);
  }
});

test('DF10.3: amount answers the first whole number of the text, 0 if none, with the first order id given', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const t = stubTransport();
  const orders = '\n\n<order id="o-9011">\nOrder o-9011\n</order>';
  const withOrder = (text) => ({ ...providerRequest('amount', text), body: JSON.stringify({ ...JSON.parse(providerRequest('amount', text).body), messages: [{ role: 'user', content: `Task: ${TASKS.amount}\n\n<message>\n${text}\n</message>${orders}` }] }) });
  assert.deepEqual(answerOf(await t.request(withOrder('refund 50 for me'))), { value: 50, cites: ['o-9011'] });
  assert.deepEqual(answerOf(await t.request(withOrder('please help me'))), { value: 0, cites: ['o-9011'] });
  assert.deepEqual(answerOf(await t.request(providerRequest('amount', 'refund 450'))), { value: 450, cites: [] });
});

test('DF10.3: answer and reply give one sentence as a JSON object', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const t = stubTransport();
  for (const task of ['answer', 'reply']) {
    const a = answerOf(await t.request(providerRequest(task, 'hello')));
    assert.equal(typeof a.answer, 'string');
    assert.ok(a.answer.length > 0);
  }
});

test('DF10.3: usage is input = ceil(chars of system and user text / 4), output = 20', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const body = JSON.parse((await stubTransport().request(raw('a'.repeat(8), 'b'.repeat(12)))).body);
  assert.equal(body.usage.input_tokens, 5);
  assert.equal(body.usage.output_tokens, 20);
  const odd = JSON.parse((await stubTransport().request(raw('a'.repeat(8), 'b'.repeat(13)))).body);
  assert.equal(odd.usage.input_tokens, 6);
});

test('DF10.3: the same request gives the same answer', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const t = stubTransport();
  const r1 = await t.request(providerRequest('classify', 'refund 100'));
  const r2 = await t.request(providerRequest('classify', 'refund 100'));
  assert.equal(r1.body, r2.body);
});

test('DF10.3: the live providers run over the stub and the meter, and the meter counts their calls', async () => {
  const { stubTransport } = await import('../demo/host/stub-model.mjs');
  const { createSpendMeter, meteredTransport } = await import('../demo/host/spend.mjs');
  const meter = createSpendMeter({ capUsd: 10, tables: { [MODEL]: { perMillionTokens: { input: 3_000_000, output: 15_000_000 } } } });
  const providers = makeProviders({ transport: meteredTransport(stubTransport(), meter), apiKey: 'stub-model', models: { small: MODEL, large: MODEL } });
  const out = await providers.tiers.small({ decision: 'classify', limits: { maxInputTokens: 2000, maxTokens: 400 } }, { bodies: { m1: 'I want my money back' }, items: {} });
  assert.equal(out.answer, 'Refund');
  assert.equal(meter.calls(), 5, 'five samples, five metered calls');
  assert.ok(meter.spentUsd() > 0);
});

// ---- DF10.4: createSpendMeter and meteredTransport (imports in tests, fails on missing module) --------

// A body of known size: the worst case of a request is ceil(chars of body / 2) input tokens plus max_tokens output tokens.
const meterRequest = (model, { max = 100, system = 'hi', user = 'test' } = {}) => ({ method: 'POST', url: API_URL, headers: {}, body: JSON.stringify({ model, max_tokens: max, system, messages: [{ role: 'user', content: user }] }) });
const reply = (input, output, status = 200) => ({ status, headers: {}, body: JSON.stringify({ content: [{ type: 'text', text: '{}' }], usage: { input_tokens: input, output_tokens: output } }) });
const worstCase = (req, inPrice, outPrice) => { const b = JSON.parse(req.body); return (Math.ceil(req.body.length / 2) * inPrice + b.max_tokens * outPrice) / 1e6; };

test('DF10.4: createSpendMeter has the interface of DF10 item 4', async () => {
  const { createSpendMeter } = await import('../demo/host/spend.mjs');
  const meter = createSpendMeter({ capUsd: 5, tables: {} });
  for (const name of ['spentUsd', 'calls', 'capReached', 'reserve', 'settle']) assert.equal(typeof meter[name], 'function', name);
  assert.equal(meter.capUsd, 5);
  assert.equal(meter.spentUsd(), 0);
  assert.equal(meter.calls(), 0);
  assert.equal(meter.capReached(), false);
});

test('DF10.4: cost arithmetic is exact: 1000 input tokens at 3 dollars per million and 500 output tokens at 15 dollars per million cost 0.0105 dollars', async () => {
  const { createSpendMeter, meteredTransport } = await import('../demo/host/spend.mjs');
  const meter = createSpendMeter({ capUsd: 10, tables: { [MODEL]: { perMillionTokens: { input: 3_000_000, output: 15_000_000 } } } });
  const wrapped = meteredTransport({ request: async () => reply(1000, 500) }, meter);
  await wrapped.request(meterRequest(MODEL));
  assert.ok(Math.abs(meter.spentUsd() - 0.0105) < 1e-12, `got ${meter.spentUsd()}`);
  assert.equal(meter.calls(), 1);
});

test('DF10.4: reserve before a request and settle after it with the usage the response reports', async () => {
  const { createSpendMeter } = await import('../demo/host/spend.mjs');
  const meter = createSpendMeter({ capUsd: 10, tables: { [MODEL]: { perMillionTokens: { input: 3_000_000, output: 15_000_000 } } } });
  const reservation = meter.reserve(meterRequest(MODEL));
  assert.notEqual(reservation, undefined);
  meter.settle(reservation, reply(10, 20));
  assert.ok(Math.abs(meter.spentUsd() - (10 * 3 + 20 * 15) / 1e6) < 1e-12, `got ${meter.spentUsd()}`);
});

test('DF10.4: a response with a non-200 status costs nothing', async () => {
  const { createSpendMeter } = await import('../demo/host/spend.mjs');
  const meter = createSpendMeter({ capUsd: 10, tables: { [MODEL]: { perMillionTokens: { input: 3_000_000, output: 15_000_000 } } } });
  meter.settle(meter.reserve(meterRequest(MODEL)), { status: 500, headers: {}, body: '{}' });
  assert.equal(meter.spentUsd(), 0);
});

test('DF10.4: a request that throws is charged its reserved worst case', async () => {
  const { createSpendMeter, meteredTransport } = await import('../demo/host/spend.mjs');
  const meter = createSpendMeter({ capUsd: 10, tables: { [MODEL]: { perMillionTokens: { input: 3_000_000, output: 15_000_000 } } } });
  const wrapped = meteredTransport({ request: async () => { throw new Error('connection reset'); } }, meter);
  const req = meterRequest(MODEL);
  await assert.rejects(() => wrapped.request(req), /connection reset/);
  assert.ok(Math.abs(meter.spentUsd() - worstCase(req, 3, 15)) < 1e-12, `got ${meter.spentUsd()}, want ${worstCase(req, 3, 15)}`);
});

test('DF10.4: a model id with no table is refused (fail closed)', async () => {
  const { createSpendMeter } = await import('../demo/host/spend.mjs');
  const meter = createSpendMeter({ capUsd: 10, tables: { 'known-model': { perMillionTokens: { input: 3_000_000, output: 15_000_000 } } } });
  assert.throws(() => meter.reserve(meterRequest('unknown-model')), ProviderError);
});

test('DF10.4: a request whose worst case would cross the cap is not sent, and the meter says the cap is reached', async () => {
  const { createSpendMeter, meteredTransport } = await import('../demo/host/spend.mjs');
  let sent = 0;
  const meter = createSpendMeter({ capUsd: 0.0001, tables: { [MODEL]: { perMillionTokens: { input: 1_000_000, output: 1_000_000 } } } });
  const wrapped = meteredTransport({ request: async () => { sent++; return reply(10, 10); } }, meter);
  const req = meterRequest(MODEL, { system: 'x'.repeat(1000) });
  assert.ok(worstCase(req, 1, 1) > 0.0001, 'the case is built so that the worst case crosses the cap');
  await assert.rejects(() => wrapped.request(req), (e) => e instanceof ProviderError && /spend cap/i.test(e.message) && /nothing was asked/i.test(e.message));
  assert.equal(sent, 0, 'the inner transport was not called');
  assert.equal(meter.capReached(), true);
});

test('DF10.4: concurrent requests are reserved together: only those that fit under the cap are sent, and the spend never exceeds it', async () => {
  const { createSpendMeter, meteredTransport } = await import('../demo/host/spend.mjs');
  const req = meterRequest(MODEL);
  const one = worstCase(req, 1, 1);
  const cap = one * 3.5; // three reservations fit, the fourth does not
  let sent = 0;
  const meter = createSpendMeter({ capUsd: cap, tables: { [MODEL]: { perMillionTokens: { input: 1_000_000, output: 1_000_000 } } } });
  const wrapped = meteredTransport({ request: async () => { sent++; await new Promise((r) => setImmediate(r)); return reply(10, 10); } }, meter);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => wrapped.request(req)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason instanceof ProviderError && /spend cap/i.test(r.reason.message)).length, 7);
  assert.equal(sent, 3);
  assert.ok(meter.spentUsd() <= cap, `spent ${meter.spentUsd()} must not exceed ${cap}`);
});

test('DF10.4: formatSpend has the exact form of the spend line', async () => {
  const { createSpendMeter, meteredTransport, formatSpend } = await import('../demo/host/spend.mjs');
  const meter = createSpendMeter({ capUsd: 5, tables: { [MODEL]: { perMillionTokens: { input: 3_000_000, output: 15_000_000 } } } });
  assert.equal(formatSpend(meter), 'spend: $0.0000 of $5.00 cap, 0 model calls');
  await meteredTransport({ request: async () => reply(1000, 500) }, meter).request(meterRequest(MODEL));
  assert.equal(formatSpend(meter), 'spend: $0.0105 of $5.00 cap, 1 model calls');
});

// ---- DF10.6: createRoom onReply --------

test('DF10.6: createRoom calls onReply with { session } after each reply it delivers to a guest', async () => {
  const { createRoom } = await import('../demo/host/room.mjs');
  const { createPersonaPool } = await import('../demo/host/personas.mjs');
  const { createLimiter } = await import('../demo/host/limits.mjs');
  const calls = [];
  const wa = { appSecret: 'a'.repeat(32), accessToken: 'b'.repeat(32), phoneNumberId: '106540352242922', verifyToken: 'c'.repeat(32), apiVersion: 'v23.0' };
  const pool = createPersonaPool({ size: 2 });
  const room = createRoom({ rt: { receive: async () => ({ status: 200 }) }, wa, pool, limiter: createLimiter({}), settle: async () => {}, onReply: (e) => calls.push(e) });
  room.join('s1');
  room.join('s2');
  assert.equal(room.deliver(pool.claim('s1').phone, 'Hello'), true);
  assert.deepEqual(calls, [{ session: 's1' }]);
  assert.equal(room.deliver('16505551234', 'Nobody'), false);
  assert.deepEqual(calls, [{ session: 's1' }], 'a reply that is dropped is not a turn');
  room.deliver(pool.claim('s2').phone, 'Hello');
  assert.deepEqual(calls, [{ session: 's1' }, { session: 's2' }]);
});
