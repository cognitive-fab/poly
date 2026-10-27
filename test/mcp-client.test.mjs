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
  await client.initialize();
  await client.callTool('find_customers', { query: 'a' });
  assert.equal(server.requests.length > 0, true);
  assert.ok(server.requests.every((r) => !('Authorization' in r.headers) && r.headers['x-trace'] === 'a'));
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
