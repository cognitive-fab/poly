// P3: the MCP client over Streamable HTTP (packages/poly-io/src/mcp.ts) against the recorded customer-records server.
// No test opens a socket (S182, S183). PL6825: the client holds no credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpClient, digestOf, TOKEN_SHAPES } from '@poly/io';
import { secretShapes } from '../packages/poly-check/dist/src/secrets.js';
import { recordedMcp } from './fixtures/agentlab/recorded-mcp.mjs';

const URL = 'https://gateway.example.test/surfaces/customer-records/mcp';
const TOOLS = ['find_customers', 'read_customer', 'update_customer'];
const open = async (opts) => {
  const server = recordedMcp(opts);
  const client = mcpClient({ url: URL, tools: TOOLS, transport: server.transport });
  const init = await client.initialize();
  return { server, client, init };
};

test('initialize then tools/list gives three tools, and the session id is kept', async () => {
  const { server, client, init } = await open();
  assert.equal(init.ok, true);
  assert.equal(client.sessionId, 'sess-0123456789abcdef');
  const l = await client.listTools();
  assert.deepEqual(l.tools.map((t) => t.name), TOOLS);
  assert.ok(!l.tools.some((t) => t.name === 'export_all_customers'));
  const after = server.requests.slice(1);
  assert.deepEqual(after.map((r) => r.message.method), ['notifications/initialized', 'tools/list']);
  for (const r of after) {
    assert.equal(r.headers['mcp-session-id'], 'sess-0123456789abcdef');
    assert.equal(r.headers['mcp-protocol-version'], '2025-11-25');
    assert.match(r.headers.accept, /text\/event-stream/);
  }
});

test('find_customers returns at most 10, over JSON and over a single-event SSE answer', async () => {
  for (const sse of [false, true]) {
    const { client } = await open({ sse });
    const r = await client.callTool('find_customers', { query: 'example.test' });
    assert.equal(r.ok, true);
    assert.equal(JSON.parse(r.text).customers.length, 10);
    assert.equal(r.structured.customers.length, 10);
    assert.equal(r.digest, digestOf(r.text));
  }
});

for (const field of ['phone', 'address', 'email']) {
  test(`update_customer changes one field: ${field}`, async () => {
    const { server, client } = await open();
    const before = { ...server.customers[3] };
    const r = await client.callTool('update_customer', { id: before.id, field, value: `new ${field}` });
    assert.equal(r.ok, true);
    assert.deepEqual({ ...server.customers[3], [field]: before[field] }, before);
    assert.equal(server.customers[3][field], `new ${field}`);
  });
}

test('update_customer refuses a missing value', async () => {
  const { server, client } = await open();
  const before = { ...server.customers[0] };
  const r = await client.callTool('update_customer', { id: before.id, field: 'phone' });
  assert.deepEqual([r.ok, r.answered], [false, true]);
  assert.deepEqual(server.customers[0], before);
});

test('update_customer refuses a field outside phone, address and email', async () => {
  const { server, client } = await open();
  const before = { ...server.customers[3] };
  const r = await client.callTool('update_customer', { id: before.id, field: 'name', value: 'x' });
  assert.deepEqual([r.ok, r.answered], [false, true]);
  assert.deepEqual(server.customers[3], before);
});

test('a tool the client was not configured with is refused before any request is sent', async () => {
  const { server, client } = await open();
  const sent = server.requests.length;
  const r = await client.callTool('export_all_customers', {});
  assert.equal(r.ok, false);
  assert.equal(r.permanent, true);
  assert.equal(server.requests.length, sent);
});

test('isError is a failure that keeps the tool text by digest', async () => {
  const { client } = await open();
  const r = await client.callTool('read_customer', { id: 'C999' });
  assert.equal(r.ok, false);
  assert.equal(r.answered, true);
  assert.equal(r.text, 'no customer C999');
  assert.equal(r.digest, digestOf('no customer C999'));
});

test('a configuration that carries a credential is refused', () => {
  const server = recordedMcp();
  const make = (extra) => () => mcpClient({ url: URL, tools: TOOLS, transport: server.transport, ...extra });
  assert.throws(make({ headers: { Authorization: 'Bearer abc' } }), /Authorization header/);
  assert.throws(make({ headers: { 'x-api-key': 'k' } }), /x-api-key header/);
  assert.throws(make({ headers: { 'x-trace': 'sk_live_abcdefghijklmnop' } }), /token-shaped/);
  assert.throws(make({ url: 'https://u:p@gateway.example.test/mcp' }), /user or password/);
  assert.throws(make({ url: `${URL}?api_key=zzz` }), /api_key parameter/);
  assert.throws(make({ headers: { api_key: 'k' } }), /api_key header/);
  assert.throws(make({ url: `${URL}?auth_token=z` }), /auth_token parameter/);
  assert.throws(make({ tools: [] }), /no tools/);
  assert.doesNotThrow(make({ headers: { 'x-trace': 'abc' } }));
});

test('the token shapes are the ones PL6825 reads', () => {
  const samples = ['sk_live_abcdefghijklmnop', 'xoxb-1234567890-abc', 'ya29.' + 'a'.repeat(24), 'ghp_' + 'a'.repeat(32), 'AKIA' + 'A'.repeat(16), 'eyJhbGciOiJ.eyJzdWIiOiJ.c2lnbmF0dXJl', '-----BEGIN PRIVATE KEY-----'];
  for (const s of samples) {
    assert.ok(secretShapes(s).length > 0, s);
    assert.ok(TOKEN_SHAPES.some((re) => re.test(s)), s);
  }
  assert.equal(TOKEN_SHAPES.length, samples.length);
});

test('a 403 from the gateway is permanent and names the status', async () => {
  const denied = recordedMcp({ status: 403 });
  const client = mcpClient({ url: URL, tools: TOOLS, transport: denied.transport });
  const init = await client.initialize();
  assert.deepEqual([init.ok, init.permanent, init.status], [false, true, 403]);
  const { client: live } = await open({ callStatus: 403 });
  const r = await live.callTool('find_customers', { query: 'a' });
  assert.deepEqual([r.ok, r.permanent, r.status], [false, true, 403]);
  assert.match(r.error, /403/);
});

test('an answer with neither result nor error is a failure, not an empty success', async () => {
  const { client } = await open({ emptyCall: true });
  const r = await client.callTool('find_customers', { query: 'a' });
  assert.deepEqual([r.ok, r.answered], [false, true]);
});

test('a 5xx is a failure with no answer', async () => {
  const { client } = await open({ callStatus: 502 });
  const r = await client.callTool('find_customers', { query: 'a' });
  assert.deepEqual([r.ok, r.answered, r.permanent], [false, false, false]);
});

test('a call before initialize is refused without a request, and a server of another version is not used', async () => {
  const server = recordedMcp();
  const client = mcpClient({ url: URL, tools: TOOLS, transport: server.transport });
  assert.equal((await client.callTool('find_customers', { query: 'a' })).ok, false);
  assert.equal((await client.listTools()).ok, false);
  assert.equal(server.requests.length, 0);
  const other = await open({ version: '2024-11-05' });
  assert.equal(other.init.ok, false);
  assert.match(other.init.error, /2024-11-05/);
  assert.equal(other.client.sessionId, null);
  assert.equal((await other.client.callTool('find_customers', { query: 'a' })).ok, false);
});

test('the configuration is copied: changing it afterwards moves no endpoint and adds no header', async () => {
  const server = recordedMcp();
  const config = { url: URL, tools: TOOLS, transport: server.transport, headers: { 'x-trace': 'a' }, clientInfo: { name: 'poly', version: '1' } };
  const client = mcpClient(config);
  config.url = 'https://evil.example.test/mcp';
  config.headers.Authorization = 'Bearer abc';
  config.headers['x-trace'] = 'b';
  await client.initialize();
  await client.callTool('find_customers', { query: 'a' });
  assert.equal(server.requests.length > 0, true);
  assert.ok(server.requests.every((r) => !('Authorization' in r.headers) && r.headers['x-trace'] === 'a'));
  // Item 5 of the review of 2026-11-02: the test once changed config.url and never asserted where requests went.
  assert.equal(client.url, URL);
  assert.ok(server.requests.every((r) => r.url === URL), JSON.stringify(server.requests.map((r) => r.url)));
});

test('clientInfo and the scheme are checked too', () => {
  const server = recordedMcp();
  const make = (extra) => () => mcpClient({ url: URL, tools: TOOLS, transport: server.transport, ...extra });
  assert.throws(make({ clientInfo: { name: 'sk_live_abcdefghijklmnop', version: '1' } }), /token-shaped/);
  assert.throws(make({ url: 'http://gateway.example.test/mcp' }), /https/);
});

test('a connection dropped after the request is sent is a failure with no answer and no retry', async () => {
  const { server, client } = await open({ dropAfterSend: true });
  const r = await client.callTool('update_customer', { id: 'C001', field: 'email', value: 'x@example.test' });
  assert.deepEqual([r.ok, r.answered, r.permanent], [false, false, false]);
  assert.match(r.error, /no answer/);
  assert.equal(server.requests.filter((q) => q.message.method === 'tools/call').length, 1);
  assert.equal(server.customers[0].email, 'ada.alder@example.test');
});

// The review of 2026-11-02, item 1 (PT10g, PL6825): a header name is not evidence. Every header value and every decoded
// part of the URL is checked, whatever its name. Each value below triggers one rule only, because the spec does not order
// the token-shape, scheme-shape and malformed checks against each other. Names are innocent (x-trace, q, trace): a
// credential-named header or parameter is refused by its name first.
const made = (extra) => () => mcpClient({ url: URL, tools: TOOLS, transport: recordedMcp().transport, ...extra });
const tokenShaped = (s) => TOKEN_SHAPES.some((re) => new RegExp(re.source, re.flags.replace(/[gy]/g, '')).test(s));
const BASE = 'https://gateway.example.test/mcp';

// The IANA registry's schemes and the four in common use outside it, in mixed case and after leading whitespace.
for (const value of [
  'Bearer abc', 'bearer abc', 'BASIC dXNlcjpwYXNz', 'Concealed x', 'digest username="u"', 'DPoP x', 'gnap x', 'HOBA x',
  'Mutual x', 'negotiate YII', 'OAuth x', 'privatetoken token=x', 'SCRAM-SHA-1 x', 'scram-sha-256 x', 'vapid t=x',
  'ApiKey x', 'aws4-hmac-sha256 x', 'NTLM x', 'token x', '  Bearer abc', '\tBasic x', 'Bearer\tabc',
]) {
  test(`item 1: a header value that starts with an authentication scheme is refused under an innocent name: ${JSON.stringify(value)}`, () => {
    assert.throws(made({ headers: { 'x-trace': value } }), /authentication scheme/);
  });
}

for (const value of ['Bearer', 'bearer', 'Bearerish x', 'abc', 'TokenRing 2']) {
  test(`item 1: a scheme name alone or inside a longer word is accepted: ${JSON.stringify(value)}`, () => {
    assert.doesNotThrow(made({ headers: { 'x-trace': value } }));
  });
}

test('item 1: a token shape under an innocent header name is refused', () => {
  for (const value of ['ghp_' + 'a'.repeat(32), 'AKIA' + 'A'.repeat(16), 'xoxb-1234567890-abc']) {
    assert.throws(made({ headers: { 'x-trace': value } }), /token-shaped/, value);
  }
});

// Each part of the URL is checked decoded: written plainly, then percent-encoded so that the raw URL matches no shape.
const SK = 'sk_live_abcdefghijklmnop';
const SK_ENCODED = 'sk%5Flive%5Fabcdefghijklmnop';
for (const [part, plain, encoded] of [
  ['the host', `https://${SK}.example.test/mcp`, `https://%73k_live_abcdefghijklmnop.example.test/mcp`],
  ['a path segment', `${BASE}/${SK}`, `${BASE}/${SK_ENCODED}`],
  ['a query name', `${BASE}?${SK}=1`, `${BASE}?${SK_ENCODED}=1`],
  ['a query value', `${BASE}?q=${SK}`, `${BASE}?q=${SK_ENCODED}`],
  ['the fragment', `${BASE}#${SK}`, `${BASE}#${SK_ENCODED}`],
]) {
  test(`item 1: a token shape in ${part} of the URL is refused, written plainly`, () => {
    assert.throws(made({ url: plain }), /token-shaped/);
  });
  test(`item 1: a token shape in ${part} of the URL is refused when percent-encoding hides it`, () => {
    assert.equal(tokenShaped(encoded), false, 'the raw URL must hide the token, or this test proves nothing about decoding');
    assert.throws(made({ url: encoded }), /token-shaped/);
  });
}

for (const [part, url] of [
  ['a path segment', `${BASE}/Bearer%20abc`],
  ['a query name', `${BASE}?Basic%20x=1`],
  ['a query value', `${BASE}?trace=Bearer%20abc`],
  ['the fragment', `${BASE}#Token%20x`],
]) {
  test(`item 1: an authentication scheme in ${part} of the URL, decoded, is refused`, () => {
    assert.throws(made({ url }), /authentication scheme/);
  });
}

for (const [part, url] of [
  ['a path segment', `${BASE}/%zz`],
  ['a query name', `${BASE}?%zz=1`],
  ['a query value', `${BASE}?q=%4`],
  ['the fragment', `${BASE}#%`],
]) {
  test(`item 1: a malformed percent-encoding in ${part} of the URL is refused`, () => {
    assert.throws(made({ url }), /malformed/);
  });
}

test('item 1: innocent values, plain and percent-encoded, are accepted', () => {
  assert.doesNotThrow(made({ headers: { 'x-trace': 'abc' } }));
  assert.doesNotThrow(made({ url: `${BASE}/a%20b?q=hello%20world&trace=abc#top` }));
});

test('item 1: the existing checks keep their messages, and a credential name is refused before the new shapes', () => {
  assert.throws(made({ headers: { Authorization: 'Bearer abc' } }), /Authorization header/);
  assert.throws(made({ headers: { 'x-api-key': 'Bearer abc' } }), /x-api-key header/);
  assert.throws(made({ url: `${BASE}?api_key=Bearer%20x` }), /api_key parameter/);
  assert.throws(made({ url: 'http://u:p@gateway.example.test/mcp' }), /user or password/);
  assert.throws(made({ url: 'http://gateway.example.test/mcp' }), /https/);
});

// The spec states the order "by its name first, then a user or password in the URL". Measured before the fix: a URL with
// both is refused for its user or password, so this states the spec's order, not today's.
test('item 1: a credential-named query parameter is refused by its name before a user or password in the same URL', () => {
  assert.throws(made({ url: 'https://u:p@gateway.example.test/mcp?api_key=z' }), /api_key parameter/);
});

// The review of 2026-11-02, item 2: sessionId is set only by an initialize that succeeds. When notifications/initialized
// is refused or gets no answer, initialize fails, sessionId is null, and later calls send nothing. The notification itself
// still carries the session id of the initialize answer.
for (const [why, opts] of [
  ['refused with 400', { initializedStatus: 400 }],
  ['refused with 403', { initializedStatus: 403 }],
  ['refused with 404', { initializedStatus: 404 }],
  ['answered with 502', { initializedStatus: 502 }],
  ['given no answer (a thrown transport error)', { initializedDrop: true }],
]) {
  test(`item 2: a notifications/initialized ${why} leaves no session, and later calls send nothing`, async () => {
    const { server, client, init } = await open(opts);
    const notified = server.requests.filter((r) => r.message.method === 'notifications/initialized');
    assert.equal(notified.length, 1);
    assert.equal(notified[0].headers['mcp-session-id'], 'sess-0123456789abcdef');
    assert.equal(init.ok, false);
    assert.equal(client.sessionId, null);
    const sent = server.requests.length;
    assert.equal((await client.listTools()).ok, false);
    assert.equal((await client.callTool('find_customers', { query: 'a' })).ok, false);
    assert.equal(server.requests.length, sent);
  });
}

// The review of 2026-11-02, item 3: a tools/call result whose content is not an array is no answer. The server answered,
// but whether the tool ran is not known, so the attempt is spent as for a transport error, whatever isError says.
for (const result of [
  {},
  { isError: true },
  { content: null },
  { content: null, isError: true },
  { content: { type: 'text', text: 'x' } },
  { content: { type: 'text', text: 'x' }, isError: false },
]) {
  test(`item 3: a tools/call result of ${JSON.stringify(result)} is a failure with no answer`, async () => {
    const { server, client } = await open({ callResult: result });
    const r = await client.callTool('find_customers', { query: 'a' });
    assert.deepEqual([r.ok, r.answered, r.permanent], [false, false, false]);
    assert.equal(server.requests.filter((q) => q.message.method === 'tools/call').length, 1);
  });
}

test('item 3: a tools/call result with a content of [] is a result with empty text', async () => {
  const { client } = await open({ callResult: { content: [] } });
  const r = await client.callTool('find_customers', { query: 'a' });
  assert.equal(r.ok, true);
  assert.equal(r.text, '');
});

// The review of 2026-11-02, item 4: 408 and 429 are permanent, by design. Every effect has one attempt and no retry
// (P1 item 5), so a status that invites a retry changes nothing and the client sends no second request.
for (const status of [408, 429]) {
  test(`item 4: a ${status} to tools/call is permanent, answered, names the status, and is one attempt with no retry (by design)`, async () => {
    const { server, client } = await open({ callStatus: status });
    const r = await client.callTool('find_customers', { query: 'a' });
    assert.deepEqual([r.ok, r.permanent, r.answered, r.status], [false, true, true, status]);
    assert.match(r.error, new RegExp(String(status)));
    assert.equal(server.requests.filter((q) => q.message.method === 'tools/call').length, 1);
  });

  test(`item 4: a ${status} to initialize is permanent and names the status, with no second request (by design)`, async () => {
    const server = recordedMcp({ status });
    const client = mcpClient({ url: URL, tools: TOOLS, transport: server.transport });
    const init = await client.initialize();
    assert.deepEqual([init.ok, init.permanent, init.status], [false, true, status]);
    assert.equal(server.requests.length, 1);
  });
}
