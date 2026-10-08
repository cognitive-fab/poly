// The full runs use the owner's subscription (4210fa6): each arm runs without --bare, with CLAUDE_CONFIG_DIR set to a
// dedicated folder that holds only the login and a settings.json with DISABLE_AUTOUPDATER=1. The runner checks the
// folder before each run and refuses an API key or an apiKeyHelper. The marker test plants markers in a stand-in for
// the owner's own setup (user CLAUDE.md, settings, skills, and a CLAUDE.md above the workspace) and runs the CLI with
// the runner's own arguments and environment against a local stand-in for the API, which records what the CLI would
// send to the model: no marker may reach it. No model is called and nothing is billed.
//
// It runs in the serial after-suite group (test/after/, one file at a time), as the v1 gate list rules (decisions-v1.md,
// V6): in the suite at 7175e4f0 its CLI child took 108 s against its 60 s limit under load, and 38 s alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { M3 } from '../../experiments/m3/lib/task.mjs';
import { claudeArgs } from '../../experiments/m3/runner/agent.mjs';
import { armEnv, configProblems, apiKeyProblems, SETTINGS } from '../../experiments/m3/runner/isolation.mjs';

const MARKERS = ['M3-MARKER-USER-CLAUDE-MD', 'M3-MARKER-ANCESTOR-CLAUDE-MD', 'M3-MARKER-SKILL', 'm3-marker-skill', 'Explanatory', 'M3_MARKER_ENV'];

/**
 * Deletes a test's folder, retrying a bounded number of times: under the full suite's parallel load a CLI that has
 * just exited may still hold a file in it for a moment (measured: EPERM on poly-m3-owner-*, decisions-m8.md). The test
 * fails only if the folder is still there after the retries, as the runner's cleanUp records it (37beede).
 */
async function removeDir(dir) {
  // The promise form: rmSync's retries block the event loop, and in a reproduction (a child process whose working
  // folder is inside dir) its 20 retries all failed while the promise form's succeeded once the child had exited.
  try { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* judged below */ }
  assert.equal(existsSync(dir), false, `${dir} is still there after 20 retries`);
}

/** A stand-in for the owner's home: markers in the user CLAUDE.md, settings and skills, and a CLAUDE.md above the workspace. */
function ownerHome() {
  const home = mkdtempSync(join(tmpdir(), 'poly-m3-owner-'));
  mkdirSync(join(home, '.claude', 'skills', 'm3-marker-skill'), { recursive: true });
  mkdirSync(join(home, 'ws'), { recursive: true });
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'M3-MARKER-USER-CLAUDE-MD\n');
  writeFileSync(join(home, 'CLAUDE.md'), 'M3-MARKER-ANCESTOR-CLAUDE-MD\n');
  writeFileSync(join(home, '.claude', 'skills', 'm3-marker-skill', 'SKILL.md'), '---\nname: m3-marker-skill\ndescription: M3-MARKER-SKILL\n---\nM3-MARKER-SKILL\n');
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ outputStyle: 'Explanatory', env: { M3_MARKER_ENV: '1' } }));
  return home;
}

/** Runs the CLI once with `env` in `cwd`, against a local server that records every request body; resolves to { init, bodies }. */
function capture(cwd, env) {
  return new Promise((resolve) => {
    const bodies = [];
    const server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d)).on('end', () => {
        bodies.push(b);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'capture only' } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      // A stand-in endpoint and a stand-in key: the request goes to this process only.
      const child = spawn('claude', claudeArgs({ arm: 3, model: 'claude-opus-5-5', prompt: 'hi' }), { cwd, env: { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'stand-in-not-a-key' } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      const timer = setTimeout(() => child.kill(), 60_000);
      child.on('close', () => {
        clearTimeout(timer);
        server.close();
        const init = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.type === 'system' && e.subtype === 'init');
        resolve({ init, bodies });
      });
    });
  });
}

test('markers in the owner\'s own CLAUDE.md, settings and skills never reach the arm', { timeout: 180_000 }, async () => {
  const home = ownerHome();
  const config = mkdtempSync(join(tmpdir(), 'poly-m3-armcfg-'));
  try {
    const base = { ...process.env, HOME: home, USERPROFILE: home };
    delete base.ANTHROPIC_API_KEY;
    // The control: the owner's own configuration, as the CLI would use it without isolation, carries every marker.
    const owner = await capture(join(home, 'ws'), { ...base, CLAUDE_CONFIG_DIR: join(home, '.claude') });
    assert.ok(owner.bodies.length > 0, 'the CLI sent no request');
    const ownerSent = owner.bodies.join('\n');
    // The arm's arguments disable slash commands, which keeps skills out even here; the files and settings get through.
    for (const m of ['M3-MARKER-USER-CLAUDE-MD', 'M3-MARKER-ANCESTOR-CLAUDE-MD', 'Explanatory']) assert.ok(ownerSent.includes(m), `the control does not carry ${m}`);
    // The arm: the runner's own environment, with its configuration folder.
    const arm = await capture(join(home, 'ws'), armEnv(base, config));
    assert.ok(arm.bodies.length > 0, 'the CLI sent no request');
    const sent = arm.bodies.join('\n');
    for (const m of MARKERS) assert.equal(sent.includes(m), false, `${m} reached the arm`);
    assert.ok(arm.init, 'no init event');
    assert.equal(arm.init.skills.includes('m3-marker-skill'), false);
    assert.equal(arm.init.output_style, 'default');
    assert.deepEqual(arm.init.mcp_servers, []);
    assert.equal(arm.init.permissionMode, 'dontAsk');
  } finally {
    await removeDir(home);
    await removeDir(config);
  }
});

test('the configuration folder holds only the login, the settings and the CLI\'s own state, or the runner refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-m3-cfgcheck-'));
  try {
    const ok = () => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, 'projects', 'C--ws-T1-arm1-run1'), { recursive: true });
      writeFileSync(join(dir, 'settings.json'), JSON.stringify(SETTINGS));
      writeFileSync(join(dir, '.credentials.json'), '{}');
      writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x' }, projects: {} }));
    };
    ok();
    assert.deepEqual(configProblems(dir), []);
    const cases = [
      [() => writeFileSync(join(dir, 'CLAUDE.md'), 'x'), /CLAUDE\.md/],
      [() => mkdirSync(join(dir, 'skills', 's'), { recursive: true }), /skills/],
      [() => mkdirSync(join(dir, 'plugins'), { recursive: true }), /plugins/],
      [() => mkdirSync(join(dir, 'agents'), { recursive: true }), /agents/],
      [() => mkdirSync(join(dir, 'commands'), { recursive: true }), /commands/],
      [() => writeFileSync(join(dir, 'settings.local.json'), '{}'), /settings\.local\.json/],
      [() => writeFileSync(join(dir, 'unexpected.txt'), 'x'), /unexpected\.txt/],
      [() => writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...SETTINGS, hooks: {} })), /settings\.json/],
      [() => writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...SETTINGS, apiKeyHelper: 'x' })), /settings\.json/],
      [() => writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: {}, mcpServers: { a: {} } })), /mcpServers/],
      [() => writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: {}, primaryApiKey: 'x' })), /API key/],
      [() => { mkdirSync(join(dir, 'projects', 'p', 'memory'), { recursive: true }); writeFileSync(join(dir, 'projects', 'p', 'memory', 'MEMORY.md'), 'x'); }, /memory/],
      [() => rmSync(join(dir, '.credentials.json')), /login/],
    ];
    for (const [make, why] of cases) {
      ok();
      make();
      const p = configProblems(dir);
      assert.ok(p.some((x) => why.test(x)), `${why}: ${JSON.stringify(p)}`);
    }
    assert.match(configProblems(join(dir, 'missing')).join(' '), /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no API billing: the runner refuses to start while ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set', () => {
  assert.deepEqual(apiKeyProblems({}), []);
  assert.equal(apiKeyProblems({ ANTHROPIC_API_KEY: 'x' }).length, 1);
  assert.equal(apiKeyProblems({ ANTHROPIC_AUTH_TOKEN: 'x' }).length, 1);
  const env = { ...process.env, ANTHROPIC_API_KEY: 'stand-in-not-a-key' };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [join(M3, 'runner', 'run.mjs'), '--arm', '1', '--task', 'P1', '--model', 'claude-opus-5-5', '--tokens', '1', '--wall', '1', '--out', join(tmpdir(), 'poly-m3-apikey')], { encoding: 'utf8', env });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(r.stderr + r.stdout, /stand-in-not-a-key/);
});

test('no arm may use the Skill tool, and the arm\'s CLI loads no MCP server and syncs no plugin or skill from the account', async () => {
  const { ALLOWED_TOOLS } = await import('../../experiments/m3/runner/agent.mjs');
  for (const [arm, tools] of Object.entries(ALLOWED_TOOLS)) assert.ok(!tools.some((t) => /^Skill\b/.test(t)), `arm ${arm} may use the Skill tool`);
  // Measured on the arms' folder after the owner's login, against the local stand-in: without these, the CLI synced
  // the account's 8 plugins and 58 MCP servers (Gmail and Drive among them) into the arm, and their names reached the model.
  const env = armEnv({}, 'cfg');
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.ok(claudeArgs({ arm: 1, model: 'm', prompt: 'p' }).includes('--strict-mcp-config'));
  assert.ok(!claudeArgs({ arm: 1, model: 'm', prompt: 'p' }).includes('--mcp-config'));
});

test('no arm\'s own material reaches it through a CLAUDE.md, which the arm\'s environment would not read', async () => {
  const { makeWorkspace } = await import('../../experiments/m3/runner/workspace.mjs');
  const { versions } = await import('../../experiments/m3/lib/task.mjs');
  for (const arm of [1, 2, 3, 4]) {
    const { ws, files } = makeWorkspace(join(tmpdir(), 'poly-m3-ws-test', `claude-md-arm${arm}`), arm, versions('T1')[0]);
    assert.deepEqual(files.filter((f) => /(^|\/)(CLAUDE(\.local)?\.md|AGENTS\.md|\.claude)(\/|$)/i.test(f)), [], `arm ${arm}`);
    rmSync(ws, { recursive: true, force: true });
  }
});
