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
  // Version negotiation, rule 2: 2024-11-05 is now spoken, so the other version is one the client does not speak.
  const other = await open({ version: '2024-10-07' });
  assert.equal(other.init.ok, false);
  assert.match(other.init.error, /2024-10-07/);
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

// The owner's ruling 1 of 2026-11-02 (PT10g, PL6825): the name and version of clientInfo are checked for the
// authentication-scheme shape of item 1, as header values are, and refused with a message that says "authentication
// scheme". The values are kept short so that none is also an HTTP credential (ruling 2): the spec does not place the
// clientInfo check in the order of the configuration checks, so a value with both shapes would test an unstated order.
const withInfo = (clientInfo) => () => mcpClient({ url: URL, tools: TOOLS, transport: recordedMcp().transport, clientInfo });
for (const value of ['Bearer abc', 'bearer abc', 'BEARER abc', 'Basic x', 'basic x', 'Token x', 'negotiate YII', 'DPoP x', 'ApiKey x', 'aws4-hmac-sha256 x', '  Bearer abc', '\tBasic x', 'Bearer\tabc']) {
  test(`ruling 1: a clientInfo name that starts with an authentication scheme is refused: ${JSON.stringify(value)}`, () => {
    assert.throws(withInfo({ name: value, version: '1' }), /authentication scheme/);
  });
  test(`ruling 1: a clientInfo version that starts with an authentication scheme is refused: ${JSON.stringify(value)}`, () => {
    assert.throws(withInfo({ name: 'poly', version: value }), /authentication scheme/);
  });
}

test('ruling 1: the case the ruling names, clientInfo { name: "Bearer abc", version: "1" }, is refused', () => {
  assert.throws(withInfo({ name: 'Bearer abc', version: '1' }), /authentication scheme/);
});

// Item 1's shape does not refuse a scheme name alone or one inside a longer word, so neither does ruling 1.
for (const clientInfo of [
  { name: 'poly', version: '1' },
  { name: 'poly-lab desk', version: '1.4.0' },
  { name: 'Bearer', version: '1' },
  { name: 'Bearerish x', version: '1' },
  { name: 'poly', version: 'TokenRing 2' },
]) {
  test(`ruling 1: an innocent clientInfo is accepted: ${JSON.stringify(clientInfo)}`, () => {
    assert.doesNotThrow(withInfo(clientInfo));
  });
}

test('ruling 1: a client made with an innocent clientInfo initializes', async () => {
  const server = recordedMcp();
  const client = mcpClient({ url: URL, tools: TOOLS, transport: server.transport, clientInfo: { name: 'poly', version: '1.4.0' } });
  const init = await client.initialize();
  assert.equal(init.ok, true, `initialize: ${JSON.stringify(init)}`);
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

// Item 1, the second review of 2026-11-02: the host is read as written in the URL, then decoded, never as a URL parser
// returns it. The parser lowercases the host, and the AKIA shape is case-sensitive, so %41KIA... read from the parsed
// host is akia... and matches nothing.
test('item 1: a case-sensitive token shape in the host, hidden by percent-encoding, is refused (the host is read as written)', () => {
  const url = 'https://%41KIAIOSFODNN7EXAMPLE.example.test/mcp';
  assert.equal(tokenShaped(url), false, 'the raw URL must hide the token, or this test proves nothing about decoding');
  assert.equal(tokenShaped(decodeURIComponent('%41KIAIOSFODNN7EXAMPLE')), true, 'the host label as written, decoded, is token-shaped');
  assert.equal(tokenShaped(new globalThis.URL(url).hostname), false, 'the parsed host is lowercased and matches nothing');
  assert.throws(made({ url }), /token-shaped/);
});

test('item 1: a plain lowercase host is accepted', () => {
  assert.doesNotThrow(made({ url: 'https://gateway.example.test/mcp' }));
});

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

// Version negotiation (rule 7a). The live probe of 2026-11-02: the Lab's Hello server, through the owner's gateway,
// answered initialize with protocolVersion "2024-11-05", as an SSE event with an mcp-session-id header. The client speaks
// 2024-11-05, 2025-03-26, 2025-06-18 and 2025-11-25 (rule 2) and asks for 2025-11-25 (rule 1).
// A header is looked up under any capitalization, so that "carries none" cannot pass because the client wrote
// MCP-Protocol-Version where the test read mcp-protocol-version.
const headerOf = (headers, name) => {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
};
const AFTER_INITIALIZE = ['notifications/initialized', 'tools/list', 'tools/call'];
const SPOKEN = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

for (const version of SPOKEN) {
  for (const sse of [false, true]) {
    const form = sse ? 'a single-event SSE answer' : 'a JSON answer';
    test(`version negotiation: a server answering ${version} as ${form} is used, and the version is the negotiated one`, async () => {
      const { server, client, init } = await open({ version, sse });
      assert.equal(init.ok, true, `initialize: ${JSON.stringify(init)}`);
      assert.equal(client.protocolVersion, version, 'rule 3: client.protocolVersion is the negotiated version');
      assert.equal(client.sessionId, 'sess-0123456789abcdef');
      const l = await client.listTools();
      assert.deepEqual(l.tools.map((t) => t.name), TOOLS);
      const r = await client.callTool('find_customers', { query: 'example.test' });
      assert.equal(r.ok, true);
      assert.equal(JSON.parse(r.text).customers.length, 10);
      // Rule 5: the session id goes on every later request, whatever the version.
      const after = server.requests.slice(1);
      assert.deepEqual(after.map((q) => q.message.method), AFTER_INITIALIZE);
      for (const q of after) assert.equal(headerOf(q.headers, 'mcp-session-id'), 'sess-0123456789abcdef', q.message.method);
    });
  }

  // Rule 4, as replaced after the second probe of 2026-11-02: every request after initialize carries the negotiated
  // version, whichever of the four it is, and never the 2025-11-25 that initialize asked for when the server answered
  // another. The first reading sent no header for 2024-11-05 and 2025-03-26, and the probed server refuses that. The
  // methods are asserted first, so that "every request carries" is never read over an empty list.
  test(`version negotiation: with ${version}, every request after initialize carries mcp-protocol-version ${version}`, async () => {
    const { server, client, init } = await open({ version });
    assert.equal(init.ok, true, `initialize: ${JSON.stringify(init)}`);
    await client.listTools();
    await client.callTool('find_customers', { query: 'a' });
    const after = server.requests.slice(1);
    assert.deepEqual(after.map((q) => q.message.method), AFTER_INITIALIZE);
    for (const q of after) {
      assert.equal(headerOf(q.headers, 'mcp-protocol-version'), version, q.message.method);
      if (version !== '2025-11-25') assert.notEqual(headerOf(q.headers, 'mcp-protocol-version'), '2025-11-25', `${q.message.method}: never the version asked for`);
    }
  });

  // Rules 1 and 4: initialize asks for 2025-11-25 and carries no version header, whatever the server then answers.
  test(`version negotiation: initialize asks for 2025-11-25 with no mcp-protocol-version header (server answers ${version})`, async () => {
    const { server } = await open({ version });
    const first = server.requests[0];
    assert.equal(first.message.method, 'initialize');
    assert.equal(first.message.params.protocolVersion, '2025-11-25');
    assert.equal(headerOf(first.headers, 'mcp-protocol-version'), undefined);
  });
}

// Rule 2: any other answer, or none, is a permanent failure that names the version answered and leaves no session.
// Whether notifications/initialized is sent after such an answer is not stated, so the requests are counted from the
// moment initialize returns.
for (const [why, opts, named] of [
  ['2024-10-07, a version older than any the client speaks', { version: '2024-10-07' }, /2024-10-07/],
  ['2026-07-28, the revision without initialize', { version: '2026-07-28' }, /2026-07-28/],
  ['2025-11-24, one day off a spoken version', { version: '2025-11-24' }, /2025-11-24/],
  ['an empty string', { version: '' }, null],
  ['no protocolVersion at all', { noVersion: true }, null],
]) {
  for (const sse of [false, true]) {
    test(`version negotiation: an initialize answer naming ${why} is refused, permanent, with no session${sse ? ' (SSE)' : ''}`, async () => {
      const { server, client, init } = await open({ ...opts, sse });
      assert.equal(init.ok, false, 'not ok');
      assert.equal(init.permanent, true, 'permanent');
      assert.equal(typeof init.error, 'string');
      assert.ok(init.error.length > 0, 'the error says why');
      if (named) assert.match(init.error, named, 'the error names the version answered');
      assert.equal(client.sessionId, null, 'no session');
      assert.equal(client.protocolVersion, null, 'rule 3: no negotiated version');
      const sent = server.requests.length;
      assert.equal((await client.listTools()).ok, false);
      assert.equal((await client.callTool('find_customers', { query: 'a' })).ok, false);
      assert.equal(server.requests.length, sent, 'later calls send nothing');
    });
  }
}

test('version negotiation: client.protocolVersion is null before initialize', () => {
  const client = mcpClient({ url: URL, tools: TOOLS, transport: recordedMcp().transport });
  assert.equal(client.protocolVersion, null);
});

// Rule 3: null after an initialize that fails, whatever made it fail, even when the version answered was spoken.
for (const [why, opts] of [
  ['a 403 to initialize', { status: 403 }],
  ['a refused notifications/initialized after a spoken 2024-11-05', { version: '2024-11-05', initializedStatus: 400 }],
  ['a notifications/initialized with no answer after a spoken 2025-06-18', { version: '2025-06-18', initializedDrop: true }],
]) {
  test(`version negotiation: client.protocolVersion is null after ${why}`, async () => {
    const { client, init } = await open(opts);
    assert.equal(init.ok, false);
    assert.equal(client.protocolVersion, null);
  });
}

// The second live probe of 2026-11-02, recorded (rule 4). The Lab's Hello server, through the owner's gateway, answers
// initialize with 2024-11-05 as one SSE event with an mcp-session-id header, and refuses with -32022 "Unsupported
// protocol version" a later request whose MCP-Protocol-Version is 2025-06-18. The fixture's probe option refuses every
// later request whose header is not 2024-11-05, a missing header included, with HTTP 400.
const send = (server, message, headers = {}) => server.transport.request({
  method: 'POST',
  url: URL,
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(message),
});
const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } };

// Sent straight to the fixture's transport, with no client, so that the green client test below is known to pass a
// server that does refuse. The session id is the one initialize returned, so a 400 here is not the session check, and
// the -32022 body tells the two apart (the session check answers 400 with an empty body).
test('the probe fixture refuses a later request whose mcp-protocol-version is not 2024-11-05, a missing one included', async () => {
  const server = recordedMcp({ probe: true });
  const init = await send(server, INITIALIZE);
  assert.equal(init.status, 200);
  assert.match(headerOf(init.headers, 'content-type'), /text\/event-stream/);
  assert.match(init.body, /"protocolVersion":"2024-11-05"/);
  const session = headerOf(init.headers, 'mcp-session-id');
  assert.equal(session, 'sess-0123456789abcdef');
  const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  for (const [why, headers] of [
    ['2025-06-18, as probed', { 'mcp-protocol-version': '2025-06-18' }],
    ['2025-11-25, the version initialize asked for', { 'mcp-protocol-version': '2025-11-25' }],
    ['no header at all', {}],
  ]) {
    const r = await send(server, list, { 'mcp-session-id': session, ...headers });
    assert.equal(r.status, 400, why);
    const error = JSON.parse(r.body).error;
    assert.deepEqual([error.code, error.message], [-32022, 'Unsupported protocol version'], why);
  }
  // The control: the same request with 2024-11-05, under another letter case, is answered, so the fixture does not
  // refuse everything.
  const answered = await send(server, list, { 'mcp-session-id': session, 'MCP-Protocol-Version': '2024-11-05' });
  assert.equal(answered.status, 200);
  assert.match(answered.body, /find_customers/);
});

test('the probe server: the client negotiates 2024-11-05, lists the three tools and calls a tool, every later request carrying mcp-protocol-version 2024-11-05', async () => {
  const { server, client, init } = await open({ probe: true });
  assert.equal(init.ok, true, `initialize: ${JSON.stringify(init)}`);
  assert.equal(client.protocolVersion, '2024-11-05');
  assert.equal(client.sessionId, 'sess-0123456789abcdef');
  const l = await client.listTools();
  assert.deepEqual(l.tools.map((t) => t.name), TOOLS);
  const c = server.customers[0];
  const r = await client.callTool('read_customer', { id: c.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.text, JSON.stringify(c));
  assert.deepEqual(server.requests.map((q) => q.message.method), ['initialize', ...AFTER_INITIALIZE]);
  assert.equal(headerOf(server.requests[0].headers, 'mcp-protocol-version'), undefined, 'initialize carries none');
  for (const q of server.requests.slice(1)) assert.equal(headerOf(q.headers, 'mcp-protocol-version'), '2024-11-05', q.message.method);
});

// Rule 4: a server that refuses the header (the probe's -32022, which the specification answers with HTTP 400) is a
// permanent failure, as any 4xx is. Here the server answers 2025-06-18 and then wants 2024-11-05, so the client's
// notifications/initialized, which carries the negotiated 2025-06-18, is refused, and initialize fails (item 2).
test('rule 4: a server that refuses the version header with 400 and -32022 is a permanent failure and leaves no session', async () => {
  const { server, client, init } = await open({ version: '2025-06-18', requireVersion: '2024-11-05' });
  const notified = server.requests.filter((q) => q.message.method === 'notifications/initialized');
  assert.equal(notified.length, 1);
  assert.equal(headerOf(notified[0].headers, 'mcp-protocol-version'), '2025-06-18', 'the negotiated version is what the server refused');
  assert.deepEqual([init.ok, init.permanent], [false, true]);
  assert.equal(client.sessionId, null);
  assert.equal(client.protocolVersion, null);
});

// Rule 6: every request, initialize included, carries accept-encoding: identity, and nothing else under that name in
// any letter case. All the values under the name are collected, so that a leftover Accept-Encoding: gzip beside an
// accept-encoding: identity cannot pass.
const valuesOf = (headers, name) => Object.keys(headers).filter((k) => k.toLowerCase() === name).map((k) => headers[k]);

for (const sse of [false, true]) {
  test(`rule 6: every request, initialize included, carries accept-encoding identity and no other (${sse ? 'SSE' : 'JSON'} answers)`, async () => {
    const { server, client, init } = await open({ sse });
    assert.equal(init.ok, true, `initialize: ${JSON.stringify(init)}`);
    await client.listTools();
    await client.callTool('find_customers', { query: 'a' });
    assert.deepEqual(server.requests.map((q) => q.message.method), ['initialize', ...AFTER_INITIALIZE]);
    for (const q of server.requests) assert.deepEqual(valuesOf(q.headers, 'accept-encoding'), ['identity'], q.message.method);
  });
}

test('rule 6: an initialize that is refused still carried accept-encoding identity', async () => {
  const server = recordedMcp({ status: 403 });
  const client = mcpClient({ url: URL, tools: TOOLS, transport: server.transport });
  await client.initialize();
  assert.equal(server.requests.length, 1);
  assert.deepEqual(valuesOf(server.requests[0].headers, 'accept-encoding'), ['identity']);
});

for (const name of ['Accept-Encoding', 'accept-encoding', 'ACCEPT-ENCODING', 'aCcEpT-eNcOdInG']) {
  test(`rule 6: a configuration header ${name} is replaced by accept-encoding identity on every request`, async () => {
    for (const value of ['gzip', 'gzip, deflate, br']) {
      const server = recordedMcp();
      const client = mcpClient({ url: URL, tools: TOOLS, transport: server.transport, headers: { [name]: value } });
      const init = await client.initialize();
      assert.equal(init.ok, true, `initialize: ${JSON.stringify(init)}`);
      await client.listTools();
      await client.callTool('find_customers', { query: 'a' });
      assert.deepEqual(server.requests.map((q) => q.message.method), ['initialize', ...AFTER_INITIALIZE]);
      for (const q of server.requests) {
        assert.deepEqual(valuesOf(q.headers, 'accept-encoding'), ['identity'], `${name}: ${value}, ${q.message.method}`);
      }
    }
  });
}

// Rule 6: the body is read as it arrives and never decoded by its content-encoding. The probed server labels its answers
// gzip and does not compress them. The fixture's label is checked first, so that a green read is a read of a gzip label.
for (const [why, opts] of [
  ['a plain JSON body', { gzipLabel: true }],
  ['a plain SSE body', { gzipLabel: true, sse: true }],
  ['the probe server as probed (2024-11-05, SSE)', { gzipLabel: true, probe: true }],
]) {
  test(`rule 6: answers labelled content-encoding gzip with ${why} are read as sent`, async () => {
    const raw = await send(recordedMcp(opts), INITIALIZE);
    assert.equal(headerOf(raw.headers, 'content-encoding'), 'gzip', 'the fixture labels its answer gzip');
    assert.match(raw.body, /"protocolVersion"/, 'the body is plain text');
    const { server, client, init } = await open(opts);
    assert.equal(init.ok, true, `initialize: ${JSON.stringify(init)}`);
    const l = await client.listTools();
    assert.deepEqual(l.tools.map((t) => t.name), TOOLS);
    const c = server.customers[0];
    const r = await client.callTool('read_customer', { id: c.id });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.text, JSON.stringify(c));
    assert.equal(r.digest, digestOf(JSON.stringify(c)));
  });
}

// Item 1, the third review of 2026-11-02: a URL that holds a space, a tab, a line end or any other control character
// (U+0000 to U+0020, and U+007F), anywhere, is refused with a message that says "whitespace or a control character". A
// URL parser drops these at the ends and removes tabs and line ends inside, so the URL it reads is not the one the checks
// read. The characters are kept out of the host, where the parser itself throws, so a red test here measures the client's
// check and not a parser error. Each case has a control, the same URL without the character, which is accepted, so a
// refusal is a refusal of the character and of nothing else.
const SPACED = /whitespace or a control character/;
const HEX = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
// JSON.stringify escapes U+0000 to U+001F but not U+007F, which the reporter would otherwise print raw.
const shown = (s) => JSON.stringify(s).replace(/\u007f/g, '\\u007f');
for (const [why, url, control] of [
  ['a leading space', ` ${URL}`, URL],
  ['a trailing space', `${URL} `, URL],
  ['a space inside the path', `${BASE}/a b`, `${BASE}/ab`],
  ['a tab inside the path', 'https://gateway.example.test/surfaces/customer\t-records/mcp', URL],
  ['a line feed inside the path', `${BASE}/a\nb`, `${BASE}/ab`],
  ['a carriage return inside the query', `${BASE}?q=a\rb`, `${BASE}?q=ab`],
  ['a NUL inside the fragment', `${BASE}#a\u0000b`, `${BASE}#ab`],
  ['U+001F inside the path', `${BASE}/a\u001fb`, `${BASE}/ab`],
  ['U+007F inside the query', `${BASE}?q=a\u007fb`, `${BASE}?q=ab`],
]) {
  test(`item 1: a URL with ${why} is refused: ${shown(url)}`, () => {
    assert.doesNotThrow(made({ url: control }), 'the control, without the character, is accepted');
    assert.throws(made({ url }), SPACED);
  });
}

// The case the third review found: with a leading space the host was not found in the URL as written, and the
// percent-encoded AKIA host of the second review was accepted. The first assertion separates "accepted", the defect,
// from "refused under another message"; the spec does not order this check against the token-shape check, and the
// bullet says such a URL is refused with the whitespace message, so the second assertion states that.
test('item 1: the URL the third review found, a leading space before a percent-encoded AKIA host, is refused', () => {
  const url = ' https://%41KIAIOSFODNN7EXAMPLE.example.test/mcp';
  assert.throws(made({ url }), undefined, 'the URL is refused at all');
  assert.throws(made({ url }), SPACED);
});

// "Anywhere": every character of the set, at the start, in the middle of the path and at the end. The misses are
// collected so that one red run names every character and place the client accepts or refuses under another message.
test('item 1: every character from U+0000 to U+0020, and U+007F, is refused at the start, inside the path and at the end', () => {
  const set = [...Array.from({ length: 0x21 }, (_, i) => String.fromCharCode(i)), '\u007f'];
  assert.equal(set.length, 34);
  const misses = [];
  for (const ch of set) {
    for (const [where, url] of [['start', `${ch}${URL}`], ['path', `${BASE}/a${ch}b`], ['end', `${URL}${ch}`]]) {
      try {
        made({ url })();
        misses.push(`${where} ${HEX(ch)}: accepted`);
      } catch (e) {
        if (!SPACED.test(String(e?.message))) misses.push(`${where} ${HEX(ch)}: ${String(e?.message)}`);
      }
    }
  }
  assert.deepEqual(misses, []);
});

// The set ends at U+0020 and U+007F: the characters just outside it are accepted, and the plain URL still works.
test('item 1: the characters just outside the set are accepted, and the plain configured URL is used', async () => {
  assert.doesNotThrow(made({ url: `${BASE}/a!b` }), 'U+0021');
  assert.doesNotThrow(made({ url: `${BASE}/a~b` }), 'U+007E');
  assert.doesNotThrow(made({ url: BASE }));
  const { server, client, init } = await open();
  assert.equal(init.ok, true, `initialize: ${JSON.stringify(init)}`);
  assert.equal(client.url, URL);
  assert.ok(server.requests.every((r) => r.url === URL));
});

// Version negotiation, rule 7: the headers the client sets are its own (content-type, accept, accept-encoding,
// mcp-session-id, mcp-protocol-version). A configured header with one of these names, in any letter case, is never sent,
// and the client's value is the only one of that name on a request. The third review of 2026-11-02 found a configured
// mcp-protocol-version sent on initialize. The server answers 2024-11-05, so the negotiated version differs from the
// 2025-11-25 initialize asks for. The client's own values are read from a baseline run with no such header configured,
// whose own shape is asserted first, so that "equal to the baseline" never passes over a baseline that sends nothing.
const OWN = ['content-type', 'accept', 'accept-encoding', 'mcp-session-id', 'mcp-protocol-version'];
const NEGOTIATED = '2024-11-05';
const SESSION = 'sess-0123456789abcdef';
// The configured values are markers, so a value that leaks under another name, or merges into the client's own, is seen.
// For mcp-protocol-version they are a spoken version that is not negotiated, the version initialize asks for, and the
// negotiated version itself: initialize must still carry none, and a later request one value and not two equal ones.
const CONFIGURED = {
  'content-type': ['text/x-configured'],
  accept: ['text/x-configured'],
  'accept-encoding': ['x-configured'],
  'mcp-session-id': ['sess-configured-0000'],
  'mcp-protocol-version': ['2025-06-18', '2025-11-25', NEGOTIATED],
};
const casesOf = (name) => {
  const title = name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('-');
  const alternating = [...name].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');
  return [...new Set([name, name.toUpperCase(), title, title.replace(/^Mcp-/, 'MCP-'), alternating])];
};

// One client, made with these headers, runs initialize, tools/list and tools/call against a server answering 2024-11-05.
// The client is made under doesNotThrow, so a refusal when it is made is reported as that and not as a missing header.
const runWith = async (headers, opts = {}) => {
  const server = recordedMcp({ version: NEGOTIATED, ...opts });
  let client;
  assert.doesNotThrow(() => {
    client = mcpClient({ url: URL, tools: TOOLS, transport: server.transport, headers });
  }, `a configuration with ${JSON.stringify(headers)} is accepted when the client is made`);
  const init = await client.initialize();
  await client.listTools();
  await client.callTool('find_customers', { query: 'a' });
  return { server, client, init };
};
const ownOf = (q) => Object.fromEntries(OWN.map((n) => [n, valuesOf(q.headers, n)]));

test('rule 7: the baseline, with no own header configured, carries one of each own header with the client\'s value', async () => {
  const { server, init } = await runWith({ 'x-trace': 'abc' });
  assert.equal(init.ok, true, `initialize: ${JSON.stringify(init)}`);
  assert.deepEqual(server.requests.map((q) => q.message.method), ['initialize', ...AFTER_INITIALIZE]);
  for (const q of server.requests) {
    const own = ownOf(q);
    const m = q.message.method;
    assert.equal(own['content-type'].length, 1, `${m}: content-type`);
    assert.equal(own.accept.length, 1, `${m}: accept`);
    assert.match(own.accept[0], /application\/json/, `${m}: accept`);
    assert.match(own.accept[0], /text\/event-stream/, `${m}: accept`);
    assert.deepEqual(own['accept-encoding'], ['identity'], `${m}: accept-encoding`);
    if (m === 'initialize') {
      assert.deepEqual(own['mcp-protocol-version'], [], 'initialize carries no mcp-protocol-version');
    } else {
      assert.deepEqual(own['mcp-session-id'], [SESSION], `${m}: mcp-session-id`);
      assert.deepEqual(own['mcp-protocol-version'], [NEGOTIATED], `${m}: mcp-protocol-version`);
    }
    assert.deepEqual(valuesOf(q.headers, 'x-trace'), ['abc'], `${m}: x-trace`);
  }
});

// The initialize request is checked before init.ok: a forged mcp-session-id beside the client's own can make the server
// answer 400, and checking init.ok first would hide the header fault behind "initialize failed".
const assertOwnOnly = async (headers, markers) => {
  const label = JSON.stringify(headers);
  const base = await runWith({ 'x-trace': 'abc' });
  const { server, init } = await runWith({ ...headers, 'x-trace': 'abc' });
  assert.ok(server.requests.length > 0, `${label}: initialize was sent`);
  const first = server.requests[0];
  assert.equal(first.message.method, 'initialize');
  assert.deepEqual(valuesOf(first.headers, 'mcp-protocol-version'), [], `${label}: initialize carries no mcp-protocol-version`);
  assert.deepEqual(ownOf(first), ownOf(base.server.requests[0]), `${label}: initialize carries the client's own headers only`);
  for (const q of server.requests) {
    for (const [k, v] of Object.entries(q.headers)) {
      for (const marker of markers) assert.ok(!String(v).includes(marker), `${label}: ${q.message.method} sent ${k}: ${v}`);
    }
  }
  assert.equal(init.ok, true, `${label}: initialize: ${JSON.stringify(init)}`);
  assert.deepEqual(server.requests.map((q) => q.message.method), ['initialize', ...AFTER_INITIALIZE], label);
  server.requests.forEach((q, i) => {
    const m = q.message.method;
    for (const n of OWN) {
      const values = valuesOf(q.headers, n);
      const expected = valuesOf(base.server.requests[i].headers, n);
      assert.deepEqual(values, expected, `${label}: ${m} carries ${n} ${JSON.stringify(values)}, the client's own is ${JSON.stringify(expected)}`);
    }
    if (m !== 'initialize') assert.deepEqual(valuesOf(q.headers, 'mcp-protocol-version'), [NEGOTIATED], `${label}: ${m} carries only the negotiated version`);
    assert.deepEqual(valuesOf(q.headers, 'x-trace'), ['abc'], `${label}: ${m} still carries x-trace`);
  });
};

for (const name of OWN) {
  for (const variant of casesOf(name)) {
    test(`rule 7: a configured ${variant} header is never sent, and every request carries the client's own ${name} only`, async () => {
      for (const value of CONFIGURED[name]) {
        // The negotiated version is the client's own value on later requests, so it cannot serve as a marker there.
        await assertOwnOnly({ [variant]: value }, value === NEGOTIATED ? [] : [value]);
      }
    });
  }
}

test('rule 7: the five own headers configured at once, each under two letter cases, are never sent', async () => {
  const headers = {};
  for (const name of OWN) {
    const value = CONFIGURED[name][0];
    headers[name] = value;
    headers[name.toUpperCase()] = value;
  }
  await assertOwnOnly(headers, [...new Set(OWN.map((n) => CONFIGURED[n][0]))]);
});

// The probed server of 2026-11-02 refuses a later request whose version is not 2024-11-05. A configured
// MCP-Protocol-Version of 2025-06-18 must not reach it: initialize carries none, and every later request only the
// negotiated version. The fixture reads the first header of the name it finds, so the counts here decide, not its answer.
test('rule 7: against the probe server, a configured MCP-Protocol-Version 2025-06-18 is never sent and the client works', async () => {
  const { server, client, init } = await runWith({ 'MCP-Protocol-Version': '2025-06-18', 'x-trace': 'abc' }, { probe: true });
  assert.ok(server.requests.length > 0);
  assert.deepEqual(valuesOf(server.requests[0].headers, 'mcp-protocol-version'), [], 'initialize carries none');
  for (const q of server.requests.slice(1)) {
    assert.deepEqual(valuesOf(q.headers, 'mcp-protocol-version'), [NEGOTIATED], q.message.method);
  }
  assert.equal(init.ok, true, `initialize: ${JSON.stringify(init)}`);
  assert.equal(client.protocolVersion, NEGOTIATED);
  assert.deepEqual(server.requests.map((q) => q.message.method), ['initialize', ...AFTER_INITIALIZE]);
  const r = await client.callTool('read_customer', { id: server.customers[0].id });
  assert.equal(r.ok, true, JSON.stringify(r));
});
