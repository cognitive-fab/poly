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
const statSyncOrNull = (p) => { try { return statSync(p); } catch { return null; } };

/**
 * Runs `<bin> plugin validate <dir>` with CLAUDE_CONFIG_DIR at a stand-in folder created for the call and removed after
 * it, so the owner's own configuration is never read or written. A host that cannot be started is not run.
 */
function validateInStandIn(bin, dir) {
  const configDir = mkdtempSync(join(tmpdir(), 'poly-claude-config-'));
  try {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
    const version = spawnSync(bin, ['--version'], { encoding: 'utf8', env, shell: process.platform === 'win32', timeout: 60_000 });
    if (version.status !== 0) return { ran: false, reason: `not run: ${bin} is not installed here, so the host's own validation did not run` };
    const r = spawnSync(bin, ['plugin', 'validate', dir], { encoding: 'utf8', env, shell: process.platform === 'win32', timeout: 120_000 });
    return { ran: true, status: r.status, output: (r.stdout ?? '') + (r.stderr ?? ''), configDir };
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

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

// decisions-m6.md (step 8 accepted with one change): the host's validation runs with CLAUDE_CONFIG_DIR at a stand-in
// folder the test creates, so it never reads or writes the owner's own Claude configuration; and where the host is not
// installed the check is listed as not run, never as passed.
test('S167: the host\'s validation runs in a stand-in configuration, and a host that is not installed is not run, not passed', () => {
  const missing = validateInStandIn('poly-no-such-claude-cli', ADAPTER);
  assert.equal(missing.ran, false);
  assert.match(missing.reason, /not run/);
  const real = validateInStandIn('claude', ADAPTER);
  if (real.ran) {
    assert.ok(real.configDir.startsWith(tmpdir()), real.configDir);
    assert.equal(statSyncOrNull(real.configDir), null, 'the stand-in folder is removed after the check');
  }
});

test('S167: the plugin passes the host\'s own validation, where the host is installed', (t) => {
  const r = validateInStandIn('claude', ADAPTER);
  if (!r.ran) { t.skip(r.reason); return; }
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Validation passed/);
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
