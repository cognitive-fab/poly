// M6 step 8 (S167, S170, plan section 7): host adapters are configuration over the host-neutral servers. The Claude
// Code adapter (adapters/claude-code) is a plugin that launches `poly mcp` and `poly lsp` and carries a skill; it holds
// no code, and the boundary check refuses code in an adapter and a host's name or SDK in the core. `poly install --host
// claude-code` prints the project's MCP entries from the adapter's own template; the gate launches exactly the commands
// it prints and runs AC5's script through them, with no model. The DeepSeek Harness half waits (S170).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { checkFile, commandNamed } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { mcpClient } from './mcp-client.mjs';
import { checkRepository, violationsOf } from '../scripts/check-boundaries.mjs';

const ADAPTER = join(ROOT, 'adapters', 'claude-code');
const walk = (d) => readdirSync(d).flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)]));

test('S167: the Claude Code adapter is a plugin that launches poly mcp and poly lsp, with a skill, and holds no code', () => {
  const manifest = JSON.parse(readFileSync(join(ADAPTER, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'poly');
  for (const k of ['version', 'description', 'author']) assert.ok(manifest[k], k);
  assert.deepEqual(manifest.mcpServers, { poly: { command: 'poly', args: ['mcp'] } });
  assert.deepEqual(manifest.lspServers, { poly: { command: 'poly', args: ['lsp'], extensionToLanguage: { '.poly': 'poly' } } });
  const skill = readFileSync(join(ADAPTER, 'skills', 'poly', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: poly\ndescription: .+\n---\n/);
  for (const f of walk(join(ROOT, 'adapters'))) assert.match(f, /\.(json|md)$/, `${f} is not configuration`);
  const market = JSON.parse(readFileSync(join(ROOT, 'adapters', '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [['poly', './claude-code']]);
});

test('S167: the boundary check refuses code in an adapter, and a host\'s name or SDK in the core', () => {
  const root = mkdtempSync(join(tmpdir(), 'poly-boundary-'));
  try {
    mkdirSync(join(root, 'packages', 'x', 'src'), { recursive: true });
    mkdirSync(join(root, 'adapters', 'h'), { recursive: true });
    writeFileSync(join(root, 'adapters', 'h', 'launch.mjs'), "import { COMMANDS } from '@poly/check';\n");
    assert.ok(checkRepository(root).some((v) => /adapters\/h\/launch\.mjs.*configuration/.test(v)), JSON.stringify(checkRepository(root)));
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.ok(violationsOf('poly-agent', 'a.ts', "import { Server } from '@modelcontextprotocol/sdk/server';\n").some((v) => /host SDK/.test(v)));
  assert.ok(violationsOf('poly-check', 'a.ts', "const host = 'claude-code';\n").some((v) => /host's name/.test(v)));
  assert.deepEqual(checkRepository(ROOT), []);
});

test('S167: the plugin passes the host\'s own validation, where the host is installed', { skip: spawnSync('claude', ['--version'], { shell: true }).status === 0 ? false : 'not run: the claude CLI is not installed here' }, () => {
  const r = spawnSync('claude', ['plugin', 'validate', ADAPTER], { encoding: 'utf8', shell: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /Validation passed/);
});

test('S170: the Claude Code entries poly install prints run the poly tools and AC5\'s workflow, launched exactly as printed', { timeout: 300_000 }, async () => {
  const project = join(ROOT, '.poly', 'test-install');
  rmSync(project, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  const r = await checkFile(join(ROOT, 'conformance', 'm6', 'customer-brief.poly'), { root: project });
  assert.equal(r.verdict, 'CLEAN');
  const o = await commandNamed('install').run({ host: 'claude-code', project });
  const file = o.result.files.find((f) => f.path.endsWith('.mcp.json'));
  assert.ok(file, JSON.stringify(o.result));
  const servers = JSON.parse(file.content).mcpServers;
  // The host resolves `poly` on its PATH; here it is the workspace's own bin.
  const env = { ...process.env, PATH: `${join(ROOT, 'node_modules', '.bin')}${delimiter}${process.env.PATH}` };
  const launch = (s) => mcpClient(s.command, s.args, { cwd: project, env: { ...env, ...(s.env ?? {}) }, shell: process.platform === 'win32' });
  const poly = launch(servers.poly);
  try {
    await poly.initialize();
    assert.ok((await poly.request('tools/list')).tools.some((t) => t.name === 'poly_check'));
  } finally { await poly.close(); }
  const wf = launch(servers['poly-workflows']);
  try {
    await wf.initialize();
    const [entry] = (await wf.call('workflow_list')).workflows;
    assert.deepEqual([entry.name, entry.admitted], ['customer-brief', true]);
    let v = await wf.call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-10-04' } });
    const tools = [];
    for (let k = 0; k < 10 && !v.done; k++) {
      const order = v.next[0];
      tools.push(order.tool);
      v = await wf.call('workflow_report', { order_id: order.order_id, ok: true, result: order.tool === 'github_search_issues' ? { count: 2 } : {} });
    }
    assert.deepEqual(tools, ['github_search_issues', 'ask', 'ask_user', 'slack_send']);
    assert.equal(v.state.briefState, 'posted');
  } finally { await wf.close(); }
});

test('S170: the DeepSeek Harness half is listed as waiting, not built', async () => {
  await assert.rejects(commandNamed('install').run({ host: 'dsh', project: ROOT }), /waiting/);
});
