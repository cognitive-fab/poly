// M6 step 6 (PF9.1, PF9.2, PT14, S167): `poly mcp` serves the registry's commands as MCP tools over stdio, with their
// published schemas as inputSchema and outputSchema and each result as structuredContent. A scripted client, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { agentCommands } from '@poly/agent';

const COMMANDS = agentCommands();
import { ROOT } from './helpers.mjs';
import { mcpClient } from './mcp-client.mjs';
import { schemaProblems } from './json-schema.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const schema = (name, kind) => JSON.parse(readFileSync(join(ROOT, 'schemas', `${name}.${kind}.json`), 'utf8'));

test('S167: poly mcp lists the registry\'s tools with their schemas, and none that takes a person\'s key', { timeout: 60_000 }, async () => {
  const c = mcpClient(process.execPath, [CLI, 'mcp'], { cwd: ROOT });
  try {
    const init = await c.initialize();
    assert.equal(init.serverInfo.name, 'poly');
    assert.ok(init.capabilities.tools);
    const tools = (await c.request('tools/list')).tools;
    const want = COMMANDS.filter((x) => x.mcp);
    assert.deepEqual(tools.map((t) => t.name).sort(), want.map((x) => x.mcp).sort());
    for (const t of tools) {
      const cmd = want.find((x) => x.mcp === t.name);
      assert.deepEqual(t.inputSchema, schema(cmd.name, 'input'), t.name);
      assert.deepEqual(t.outputSchema, schema(cmd.name, 'output'), t.name);
      assert.match(t.description, /\S/);
    }
    for (const absent of ['poly_approve', 'poly_accept']) assert.ok(!tools.some((t) => t.name === absent), absent);
  } finally { await c.close(); }
});

test('S167: poly_check and poly_fmt return structured content that fits their output schemas; a bad call is an error result', { timeout: 120_000 }, async () => {
  const dir = join(ROOT, '.poly', 'test-mcp');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const c = mcpClient(process.execPath, [CLI, 'mcp'], { cwd: ROOT });
  try {
    await c.initialize();
    const checked = await c.request('tools/call', { name: 'poly_check', arguments: { target: join(ROOT, 'conformance', 'm6', 'brief.poly'), root: dir } });
    assert.equal(checked.isError ?? false, false);
    assert.deepEqual(schemaProblems(schema('check', 'output'), checked.structuredContent), []);
    assert.equal(checked.structuredContent.verdict, 'CLEAN');
    assert.deepEqual(JSON.parse(checked.content[0].text), checked.structuredContent);
    const formatted = await c.request('tools/call', { name: 'poly_fmt', arguments: { file: join(ROOT, 'conformance', 'm6', 'brief.poly') } });
    assert.deepEqual(schemaProblems(schema('fmt', 'output'), formatted.structuredContent), []);
    assert.equal(formatted.structuredContent.changed, false);
    const bad = await c.request('tools/call', { name: 'poly_check', arguments: {} });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /target is required/);
    await assert.rejects(c.request('tools/call', { name: 'poly_approve', arguments: {} }), /unknown tool/);
  } finally { await c.close(); }
});
