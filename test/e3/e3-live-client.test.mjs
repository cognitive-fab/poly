// plan-e3.md E3.9: the live driver's parts that need no runtime: the tools the agent is offered and the reading of its answer, the
// Anthropic client against a local fake of the API, the key (read from the environment only, never logged, written or returned),
// the cost of a call, and the exec transport of the container. No model, no key of value, no network beyond the loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';
import { CANARY_KEY, answer, failure, fakeApi, toolUse } from './e3-fake-api.mjs';
import { costOf, createAnthropic, toApiMessages } from '../../examples/harness/host/anthropic.mjs';
import { callsFromBlocks, doneOf, resultsText, stopOf, toolSchema } from '../../examples/harness/host/tools-schema.mjs';
import { containerExec } from '../../examples/harness/host/container-exec.mjs';
import { systemPrompt, taskMessage } from '../../examples/harness/host/live.mjs';

const TABLES = {
  'test-main': { perMillionTokens: { input: 4000000, output: 20000000, cache_write: 5000000, cache_read: 200000 } },
  'test-cheap': { perMillionTokens: { input: 1000000, output: 5000000, cache_write: 1250000, cache_read: 100000 } },
};
const TMP = join(ROOT, '.poly', 'tmp', `live-client-${process.pid}`);
mkdirSync(TMP, { recursive: true });
const client = (api, over = {}) => createAnthropic({ baseUrl: api.url, getKey: () => CANARY_KEY, tables: TABLES, sleep: async () => {}, ...over });
const req = (over = {}) => ({ kind: 'agent', model: 'test-main', system: 'You are an agent.', messages: [{ role: 'user', text: 'Do the task.' }], maxTokens: 4000, ...over });

// ---------------------------------------------------------------- the tools and the reading of the answer

test('the tools: read, search, edit, write, bash and done always; the fused action edit_and_run only when fusion is on (HF2.2)', () => {
  const names = (fusion) => toolSchema({ fusion }).map((t) => t.name);
  assert.deepEqual(names(true), ['read', 'search', 'edit', 'write', 'bash', 'edit_and_run', 'done']);
  assert.deepEqual(names(false), ['read', 'search', 'edit', 'write', 'bash', 'done']);
  for (const t of toolSchema({ fusion: true })) {
    assert.ok(t.description.length > 20, t.name);
    assert.equal(t.input_schema.type, 'object');
    assert.ok(Array.isArray(t.input_schema.required ?? []));
  }
  const fused = toolSchema({ fusion: true }).find((t) => t.name === 'edit_and_run');
  assert.deepEqual(fused.input_schema.required, ['path', 'old', 'new', 'command']);
  // the tools are the same in every request of a trial: the schema is a pure function of the switch
  assert.deepEqual(toolSchema({ fusion: true }), toolSchema({ fusion: true }));
});

test('the bash tool\'s description names the runners of the classifier\'s table and not the vitest command (owner, 2026-10-13): an agent told of it uses it, and it is neither fused nor read by the Reducer', async () => {
  const { FUSABLE_COMMANDS } = await import('../../examples/harness/host/handlers/classify.mjs');
  const bash = toolSchema({ fusion: true }).find((t) => t.name === 'bash').description;
  assert.doesNotMatch(bash, /vitest/i);
  assert.match(bash, /npm test/);
  assert.match(bash, /go test/);
  // and the examples the description gives are in the table: they would be fused
  for (const example of ['npm test -- tests/unit/core/urgency.test.js', 'go test ./internal/filter -run TestHead -count 1', 'npm run build', 'npm run lint', 'node --test']) {
    assert.ok(FUSABLE_COMMANDS.some((re) => re.test(example)), example);
  }
  // while the vitest command, which the world still allows, is not in the table
  assert.ok(!FUSABLE_COMMANDS.some((re) => re.test('node node_modules/vitest/vitest.mjs run tests/unit/core/urgency.test.js')));
});

test('a request that never answers is abandoned at the timeout, as a failed request, with the key out of the message', async () => {
  const api = await fakeApi(() => new Promise(() => {}));
  const c = createAnthropic({ baseUrl: api.url, getKey: () => CANARY_KEY, tables: TABLES, sleep: async () => {}, retries: 0, timeoutMs: 150 });
  const t0 = Date.now();
  await assert.rejects(c.call(req()), (e) => /the request failed/.test(e.message) && !e.message.includes(CANARY_KEY));
  assert.ok(Date.now() - t0 < 5000);
  await api.close();
});

test('the calls of an answer: the machines read one JSON list; edit_and_run is an edit then a command; text blocks are not calls', () => {
  const blocks = [
    { type: 'text', text: 'I will look first.' },
    toolUse('read', { path: 'src/a.js' }),
    toolUse('edit_and_run', { path: 'src/a.js', old: 'x', new: 'y', command: 'npm test' }),
    toolUse('done', { summary: 'fixed' }),
    toolUse('mystery', { a: 1 }),
  ];
  assert.deepEqual(JSON.parse(callsFromBlocks(blocks)), [
    { tool: 'read', path: 'src/a.js' },
    { tool: 'edit', path: 'src/a.js', old: 'x', new: 'y' },
    { tool: 'bash', command: 'npm test' },
    { tool: 'done', summary: 'fixed' },
    { tool: 'mystery', a: 1 },
  ]);
  assert.equal(callsFromBlocks([{ type: 'text', text: 'only words' }]), '[]');
  assert.equal(callsFromBlocks(undefined), '[]');
  assert.deepEqual(JSON.parse(callsFromBlocks([{ type: 'tool_use', name: 'read', input: null }])), [{ tool: 'read' }]);
});

test('the done fact (assumption done-signal): true if and only if the calls hold the done tool, whatever else they hold, and false on anything malformed', () => {
  assert.equal(doneOf(JSON.stringify([{ tool: 'done' }])), true);
  assert.equal(doneOf(JSON.stringify([{ tool: 'edit', path: 'a' }, { tool: 'bash', command: 'npm test' }, { tool: 'done', summary: 'x' }])), true, 'done after an edit and a test');
  assert.equal(doneOf(JSON.stringify([{ tool: 'done' }, { tool: 'read', path: 'a' }])), true, 'done first');
  assert.equal(doneOf(JSON.stringify([{ tool: 'edit', path: 'a' }, { tool: 'bash', command: 'npm test' }])), false);
  assert.equal(doneOf('[]'), false);
  assert.equal(doneOf('[{"tool":"done"'), false, 'a cut-off list');
  assert.equal(doneOf('{"tool":"done"}'), false, 'not a list');
  assert.equal(doneOf('"done"'), false);
  assert.equal(doneOf('null'), false);
  assert.equal(doneOf(JSON.stringify([null, 3, 'done', { tool: 'doner' }])), false, 'a name that only contains done is not done');
  assert.equal(doneOf(undefined), false);
});

test('the stop reason the host reports: a cut-off is Length, a tool call is Tool, anything else is End', () => {
  assert.deepEqual(['max_tokens', 'tool_use', 'end_turn', 'stop_sequence', undefined].map(stopOf), ['Length', 'Tool', 'End', 'End', 'End']);
  assert.equal(resultsText('PASS\n', 0), '[tool results, exit status 0]\nPASS\n');
});

// ---------------------------------------------------------------- the client

test('the cost of a call is poly\'s (PS18.3): ceil of tokens times price per million over each class, an unpriced class at the highest price', () => {
  const t = TABLES['test-main'];
  assert.equal(costOf({ input: 1000, output: 300, cache_write: 5000, cache_read: 6500 }, t), Math.ceil((1000 * 4000000 + 300 * 20000000 + 5000 * 5000000 + 6500 * 200000) / 1e6));
  assert.equal(costOf({ input: 0, output: 0, cache_write: 0, cache_read: 0 }, t), 0);
  assert.equal(costOf({ input: 1, output: 0, cache_write: 0, cache_read: 0 }, t), 4, 'ceil: a fraction of a micro-unit is a micro-unit');
  assert.equal(costOf({ mystery: 10 }, t), 200, 'a class the table does not price takes the highest price (20 per million)');
});

test('the messages of a request: roles alternate (neighbours join), the system turn is the system prompt\'s, empty turns go, the last turn carries the cache breakpoint', () => {
  const m = toApiMessages([
    { role: 'system', text: 'sys' }, { role: 'user', text: 'task' }, { role: 'user', text: 'stage 1' }, { role: 'assistant', text: '[{"tool":"read"}]' },
    { role: 'tool', text: 'results' }, { role: 'assistant', text: '' }, { role: 'assistant', text: 'more' }, { role: 'tool', text: 'last results' },
  ]);
  assert.deepEqual(m.map((x) => [x.role, x.content[0].text]), [['user', 'task\nstage 1'], ['assistant', '[{"tool":"read"}]'], ['user', 'results'], ['assistant', 'more'], ['user', 'last results']]);
  assert.deepEqual(m.map((x) => !!x.content[0].cache_control), [false, false, false, false, true]);
  assert.equal(toApiMessages([{ role: 'user', text: 'a' }], { cacheLast: false })[0].content[0].cache_control, undefined);
});

test('a call: the request holds the system prompt and tools with a cache breakpoint, the limit as max_tokens, and the key in one header only; the usage is by class', async () => {
  const api = await fakeApi(() => answer({ blocks: [{ type: 'text', text: 'hello' }, toolUse('done', {})], stop: 'tool_use', usage: { input_tokens: 700, output_tokens: 55, cache_creation_input_tokens: 4200, cache_read_input_tokens: 9100 } }));
  const logPath = join(TMP, 'a.jsonl');
  const c = client(api, { logPath });
  const tools = toolSchema({ fusion: true });
  const r = await c.call(req({ tools }));
  const s = api.seen[0];
  assert.equal(s.method, 'POST');
  assert.equal(s.url, '/v1/messages');
  assert.equal(s.headers['x-api-key'], CANARY_KEY);
  assert.equal(s.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(Object.keys(s.headers).filter((h) => String(s.headers[h]).includes(CANARY_KEY)), ['x-api-key'], 'the key is in one header');
  assert.ok(!s.raw.includes(CANARY_KEY), 'the key is not in the body');
  assert.equal(s.body.model, 'test-main');
  assert.equal(s.body.max_tokens, 4000);
  assert.deepEqual(s.body.system, [{ type: 'text', text: 'You are an agent.', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(s.body.tools.map((t) => t.name), tools.map((t) => t.name));
  assert.equal(s.body.messages.at(-1).content.at(-1).cache_control.type, 'ephemeral');
  assert.deepEqual(r.usage, { input: 700, output: 55, cache_write: 4200, cache_read: 9100 });
  assert.equal(r.microUsd, Math.ceil((700 * 4000000 + 55 * 20000000 + 4200 * 5000000 + 9100 * 200000) / 1e6));
  assert.equal(r.stopReason, 'tool_use');
  assert.equal(r.text, 'hello');
  assert.deepEqual(c.totals, { calls: 1, microUsd: r.microUsd, byKind: { agent: r.microUsd } });
  // the log: one line, usage and cost, no key, no headers, no body
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].kind, lines[0].model, lines[0].status, lines[0].stopReason, lines[0].usage, lines[0].microUsd, lines[0].toolUses], ['agent', 'test-main', 200, 'tool_use', r.usage, r.microUsd, 1]);
  assert.ok(Number.isFinite(lines[0].latencyMs) && lines[0].requestBytes > 100);
  assert.ok(!readFileSync(logPath, 'utf8').includes(CANARY_KEY));
  assert.ok(!('headers' in lines[0]) && !('body' in lines[0]));
  await api.close();
});

test('the cheap tier is priced by its own table, and a model with no table is refused before any request', async () => {
  const api = await fakeApi(() => answer({ usage: { input_tokens: 1000, output_tokens: 100 } }));
  const c = client(api);
  const r = await c.call(req({ kind: 'read', model: 'test-cheap' }));
  assert.equal(r.microUsd, Math.ceil((1000 * 1000000 + 100 * 5000000) / 1e6));
  assert.deepEqual(Object.keys(c.totals.byKind), ['read']);
  await assert.rejects(c.call(req({ model: 'no-such-model' })), /no price table/);
  assert.equal(api.seen.length, 1, 'no request for the model without a table');
  await api.close();
});

test('the key is read from the environment at the moment of the call, and an unset key stops the call before any request', async () => {
  const api = await fakeApi(() => answer());
  let calls = 0;
  const c = createAnthropic({ baseUrl: api.url, tables: TABLES, sleep: async () => {}, getKey: () => { calls += 1; return undefined; } });
  await assert.rejects(c.call(req()), /the key is not set in the environment/);
  assert.equal(api.seen.length, 0);
  assert.equal(calls, 1);
  // the default getter is process.env.ANTHROPIC_API_KEY
  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = CANARY_KEY;
    const d = createAnthropic({ baseUrl: api.url, tables: TABLES, sleep: async () => {} });
    await d.call(req());
    assert.equal(api.seen[0].headers['x-api-key'], CANARY_KEY);
    delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(d.call(req()), /the key is not set/);
    process.env.ANTHROPIC_API_KEY = '';
    await assert.rejects(d.call(req()), /the key is not set/, 'an empty key is not a key');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
  await api.close();
});

test('a busy API is retried with a growing delay, and a persistent one fails; a refusal (401, 400) is not retried', async () => {
  const delays = [];
  const api1 = await fakeApi(({ n }) => (n < 3 ? failure(529, 'overloaded') : answer()));
  const r = await client(api1, { sleep: async (ms) => { delays.push(ms); }, backoffMs: 100 }).call(req());
  assert.equal(r.stopReason, 'end_turn');
  assert.equal(api1.seen.length, 3);
  assert.deepEqual(delays, [100, 200]);
  await api1.close();
  const api2 = await fakeApi(() => failure(503, 'down'));
  await assert.rejects(client(api2, { retries: 2 }).call(req()), /the API answered 503: down/);
  assert.equal(api2.seen.length, 3);
  await api2.close();
  for (const status of [400, 401, 403, 404]) {
    const api = await fakeApi(() => failure(status, 'nope'));
    await assert.rejects(client(api).call(req()), new RegExp(`answered ${status}`));
    assert.equal(api.seen.length, 1, `${status} is not retried`);
    await api.close();
  }
});

test('the key never appears in an error, a log line, a returned value or the totals, even when the API echoes it back', async () => {
  const logPath = join(TMP, 'echo.jsonl');
  rmSync(logPath, { force: true });
  const api = await fakeApi(({ n }) => (n === 1 ? failure(401, `invalid x-api-key: ${CANARY_KEY}`) : n === 2 ? { status: 500, body: { error: { message: `bad ${CANARY_KEY} key` } } } : answer({ blocks: [{ type: 'text', text: 'fine' }] })));
  const c = client(api, { logPath, retries: 0 });
  const errors = [];
  for (let i = 0; i < 2; i++) {
    try {
      await c.call(req());
    } catch (e) {
      errors.push(String(e.message), String(e.stack ?? ''));
    }
  }
  assert.equal(errors.length, 4);
  for (const e of errors) assert.ok(!e.includes(CANARY_KEY), e.slice(0, 80));
  assert.match(errors[0], /\[key\]/, 'the key is replaced where it appeared');
  const ok = await c.call(req());
  assert.ok(!JSON.stringify(ok).includes(CANARY_KEY));
  assert.ok(!JSON.stringify(c.totals).includes(CANARY_KEY));
  assert.ok(!readFileSync(logPath, 'utf8').includes(CANARY_KEY));
  // a key of the shape the vendor uses is scrubbed even when it is not the one in use
  assert.equal(c.scrub('x sk-ant-api03-ABCDEFGHIJKLMNOP y'), 'x [key] y');
  // a request that cannot connect: the message is scrubbed too
  const dead = createAnthropic({ baseUrl: 'http://127.0.0.1:9', getKey: () => CANARY_KEY, tables: TABLES, sleep: async () => {}, retries: 0 });
  await assert.rejects(dead.call(req()), (e) => /the request failed/.test(e.message) && !e.message.includes(CANARY_KEY));
  await api.close();
});

test('the driver\'s source never prints, writes or interpolates the key: the one place it is read is the getter, and it goes to one header', () => {
  const dir = join(ROOT, 'examples', 'harness', 'host');
  for (const f of ['anthropic.mjs', 'live.mjs', 'container-exec.mjs', 'tools-schema.mjs']) {
    const src = readFileSync(join(dir, f), 'utf8');
    const uses = src.split('\n').filter((l) => /ANTHROPIC_API_KEY|getKey|\bkey\b/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));
    if (f !== 'anthropic.mjs') assert.deepEqual(uses.filter((l) => /process\.env/.test(l)), [], `${f} reads the environment`);
    assert.ok(!/console\.(log|error|warn|info)\([^)]*\bkey\b/.test(src), `${f} prints the key`);
    assert.ok(!/(writeFileSync|appendFileSync)\([^)]*\bkey\b/.test(src), `${f} writes the key`);
  }
  const isComment = (l) => l.trimStart().startsWith('//') || l.trimStart().startsWith('*') || l.trimStart().startsWith('/*');
  const code = readFileSync(join(dir, 'anthropic.mjs'), 'utf8').split(String.fromCharCode(10)).filter((l) => !isComment(l)).join(String.fromCharCode(10));
  assert.equal(code.split('process.env').length - 1, 1, 'the environment is read in one place');
});

// ---------------------------------------------------------------- the prompt and the container's exec

test('the system prompt is the editable prompt and skills, then the note on stages and the bound; the first message holds the task and its plan', () => {
  const sys = systemPrompt(join(ROOT, 'examples', 'harness', 'editable'));
  assert.match(sys, /You are a coding agent/);
  assert.match(sys, /Fix a failing test/);
  assert.match(sys, /call the done tool|Call done when the stage is finished/);
  assert.match(sys, /8 turns/);
  const msg = taskMessage({ prompt: 'Fix the thing.', plan: ['first', 'second'] });
  assert.equal(msg, 'Fix the thing.\n\nThe work has 2 stages, one after another:\n1. first\n2. second');
});

test('the container\'s exec: it makes one copy, sends the two commands to the runner with that copy, and refuses anything else', async () => {
  const sent = [];
  const send = async (r) => {
    sent.push(r);
    if (r.op === 'prepare') return { copy: '/opt/poly/.poly/e3-tasks/live/t' };
    if (r.op === 'calls') return { text: 'out\n', exitStatus: 0 };
    if (r.op === 'check') return { passed: r.stage === 0, text: '', exitStatus: r.stage === 0 ? 0 : 1 };
    return { error: 'unknown' };
  };
  const task = { id: 't', stages: [{}, {}] };
  const c = containerExec({ send, task, run: 'live' });
  await assert.rejects(c.exec('harness-tool', ['[]']), /no task copy/);
  assert.equal(await c.prepare(), '/opt/poly/.poly/e3-tasks/live/t');
  await assert.rejects(c.prepare(), /made once/);
  assert.deepEqual(await c.exec('harness-tool', ['[{"tool":"done"}]']), { text: 'out\n', exitStatus: 0 });
  assert.equal((await c.exec('harness-check', ['0'])).passed, true);
  assert.equal((await c.exec('harness-check', ['1'])).passed, false);
  await assert.rejects(c.exec('harness-check', ['5']), /no stage 5/);
  await assert.rejects(c.exec('rm', ['-rf', '/']), /not a command of the host/);
  // the copy sent is the one the container named, never one a payload gave
  assert.deepEqual(sent.filter((r) => r.op !== 'prepare').map((r) => r.copy), ['/opt/poly/.poly/e3-tasks/live/t', '/opt/poly/.poly/e3-tasks/live/t', '/opt/poly/.poly/e3-tasks/live/t']);
  // an error from the runner is a permanent failure of the effect, not a pass
  const bad = containerExec({ send: async (r) => (r.op === 'prepare' ? { copy: '/c' } : { error: 'boom' }), task, run: 'x' });
  await bad.prepare();
  await assert.rejects(bad.exec('harness-check', ['0']), (e) => e.permanent === true && /boom/.test(e.message));
  await assert.rejects(bad.exec('harness-tool', ['[]']), (e) => e.permanent === true);
  await assert.rejects(containerExec({ send: async () => ({ error: 'no' }), task, run: 'x' }).prepare(), /could not prepare/);
});

test('the temporary files of this file are removed', () => {
  rmSync(TMP, { recursive: true, force: true });
  assert.ok(!existsSync(TMP));
});
