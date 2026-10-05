// M6 step 9 (PF9.3, S169): `poly new` drafts a module from a description with a provider, checks each draft with poly
// check, feeds the diagnostics back, and stops at CLEAN or after five rounds. A draft is never admitted: it is written
// with a header that says so. No test calls a model: the drafts come from a recorded provider, here directly and
// through MCP sampling, where the test's client answers with recorded drafts. The headless Claude Code provider refuses
// to start while an API key variable is present, checked by name only, tested with a stand-in name in a child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';
import { mcpClient } from './mcp-client.mjs';

const DIR = join(ROOT, '.poly', 'test-new');
const GOOD = readFileSync(join(ROOT, 'conformance', 'm6', 'brief.poly'), 'utf8');
const BAD = GOOD.replace('  input Start', '  input Begin');

test('PF9.3: a draft that fails is sent back with its diagnostics, and the loop stops at CLEAN; the draft is not admitted', async () => {
  const { draftModule, recordedProvider } = await import('@poly/new');
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const provider = recordedProvider([BAD, '```poly\n' + GOOD + '```\n']);
  const into = join(DIR, 'brief.poly');
  const r = await draftModule({ description: 'a daily brief workflow', into, provider, root: DIR });
  assert.equal(r.rounds, 2);
  assert.equal(r.verdict, 'CLEAN');
  assert.equal(r.admitted, false);
  assert.match(provider.requests[1].previous.diagnostics.map((d) => d.code).join(' '), /PL6801/);
  assert.equal(provider.requests[1].previous.source, BAD);
  const written = readFileSync(into, 'utf8');
  assert.match(written, /^\/\/ Drafted by poly new: not admitted/);
  assert.ok(written.endsWith(GOOD));
  assert.equal(existsSync(join(DIR, '.poly', 'certificate.json')), false);
});

test('PF9.3: a provider that drafts an invalid module every round ends after five rounds with the last diagnostics', async () => {
  const { draftModule, recordedProvider } = await import('@poly/new');
  mkdirSync(DIR, { recursive: true });
  const provider = recordedProvider([BAD, BAD, BAD, BAD, BAD, GOOD]);
  const into = join(DIR, 'never.poly');
  const r = await draftModule({ description: 'a daily brief workflow', into, provider, root: DIR });
  assert.equal(r.rounds, 5);
  assert.notEqual(r.verdict, 'CLEAN');
  assert.ok(r.diagnostics.some((d) => d.code === 'PL6801'));
  assert.equal(provider.requests.length, 5, 'no sixth round');
  assert.match(readFileSync(into, 'utf8'), /^\/\/ Drafted by poly new: not admitted/);
});

test('S169: the headless Claude Code provider refuses to start while an API key variable is present, naming it, never its value', () => {
  const code = `
    const { claudeCliProvider, API_KEY_VARIABLES } = await import('@poly/new');
    console.log(JSON.stringify(API_KEY_VARIABLES));
    try { await claudeCliProvider({ keyVariables: ['POLY_TEST_STANDIN_KEY'] }).draft({ description: 'x', grammar: '' }); console.log('STARTED'); }
    catch (e) { console.log('REFUSED ' + e.message); }
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, POLY_TEST_STANDIN_KEY: 'stand-in-value-never-printed' } });
  assert.equal(r.status, 0, r.stderr);
  const [names, outcome] = r.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(names), ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  assert.match(outcome, /^REFUSED .*POLY_TEST_STANDIN_KEY/);
  assert.doesNotMatch(r.stdout + r.stderr, /stand-in-value-never-printed/);
});

test('S169: poly_new over MCP drafts through the client\'s model by sampling, here a client that answers with recorded drafts', { timeout: 180_000 }, async () => {
  mkdirSync(DIR, { recursive: true });
  const drafts = [BAD, GOOD];
  const asked = [];
  const c = mcpClient(process.execPath, [join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js'), 'mcp'], {
    cwd: ROOT,
    capabilities: { sampling: {} },
    onRequest: async (msg) => {
      assert.equal(msg.method, 'sampling/createMessage');
      asked.push(msg.params);
      return { role: 'assistant', content: { type: 'text', text: drafts.shift() }, model: 'recorded', stopReason: 'endTurn' };
    },
  });
  try {
    await c.initialize();
    const tools = (await c.request('tools/list')).tools.map((t) => t.name);
    assert.ok(tools.includes('poly_new'));
    const r = await c.call('poly_new', { description: 'a daily brief workflow', into: join(DIR, 'sampled.poly') });
    assert.equal(r.verdict, 'CLEAN');
    assert.equal(r.rounds, 2);
    assert.equal(r.provider, 'sampling');
    assert.equal(asked.length, 2);
    assert.match(asked[1].messages.map((m) => m.content.text).join('\n'), /PL6801/);
  } finally { await c.close(); }
});

// The boundary check's rule 4: only poly-new calls a model; no package on a check path loads it.
test('PF9.3: a package on a check path that loads poly new is refused by the boundary check', async () => {
  const { violationsOf, checkRepository } = await import('../scripts/check-boundaries.mjs');
  assert.ok(violationsOf('poly-check', 'packages/poly-check/src/pipeline.ts', "const m = await import('@poly/new');\n").some((v) => /@poly\/new/.test(v)));
  assert.ok(violationsOf('poly-ref', 'packages/poly-ref/src/x.ts', "import { draftModule } from '@poly/new';\n").some((v) => /@poly\/new/.test(v)));
  assert.deepEqual(violationsOf('poly-check', 'packages/poly-check/src/cli.ts', "const pkg = '@poly/new';\n"), []);
  assert.deepEqual(checkRepository(ROOT), []);
});

// decisions-m6.md (the provider fixes need tests): the headless provider's launcher, with a stand-in claude on a PATH the
// test builds, never the real CLI and never a model. Each runs in a child process, whose environment carries no key
// variable, so the provider's refusal does not stop it; with a stand-in key variable present, the stand-in never starts.
async function launcher(mode, description, opts = {}) {
  const { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { delimiter } = await import('node:path');
  const bin = mkdtempSync(join(tmpdir(), 'poly-fake-claude-'));
  const fake = join(ROOT, 'test', 'fixtures', 'fake-claude-cli.mjs');
  if (process.platform === 'win32') writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "${fake}" %*\r\n`);
  else { writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); chmodSync(join(bin, 'claude'), 0o755); }
  const started = join(bin, 'started');
  const code = `
    const { claudeCliProvider } = await import('@poly/new');
    const p = claudeCliProvider(${opts.keyVariables ? `{ keyVariables: ${JSON.stringify(opts.keyVariables)} }` : ''});
    try { const text = await p.draft({ description: process.env.POLY_TEST_DESCRIPTION, grammar: '' }); console.log('DRAFTED ' + JSON.stringify(text)); }
    catch (e) { console.log('REJECTED ' + e.message); }
    console.log('ALIVE');
  `;
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_STARTED: started, POLY_TEST_DESCRIPTION: description, ...(opts.env ?? {}) };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete env[k];
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8', env, timeout: 60_000 });
    return { ...r, started: existsSync(started) ? readFileSync(started, 'utf8') : null };
  } finally { rmSync(bin, { recursive: true, force: true }); }
}

test('S169: the headless provider starts the claude on the PATH, a .cmd shim on Windows, with the prompt on stdin', async () => {
  const r = await launcher('echo', 'a turnstile with "quotes" & a %PATH% and\nsecond line');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRAFTED /, r.stdout + r.stderr);
  const text = JSON.parse(r.stdout.match(/DRAFTED (.*)/)[1]);
  assert.ok(text.includes('a turnstile with "quotes" & a %PATH% and\nsecond line'), 'the prompt reached the CLI on stdin, unchanged');
  assert.equal(r.started, '-p --output-format text', 'the arguments are fixed words; the prompt is not among them');
});

test('S169: a CLI that exits before reading its prompt ends the draft by its exit code, and the process survives', async () => {
  const r = await launcher('exit', 'x'.repeat(4 * 1024 * 1024));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /REJECTED .*exited 3/, r.stdout + r.stderr);
  assert.match(r.stdout, /ALIVE/);
});

test('S169: with a stand-in key variable present, the stand-in CLI is never started', async () => {
  const r = await launcher('echo', 'x', { keyVariables: ['POLY_TEST_STANDIN_KEY'], env: { POLY_TEST_STANDIN_KEY: 'stand-in' } });
  assert.match(r.stdout, /REJECTED .*POLY_TEST_STANDIN_KEY/);
  assert.equal(r.started, null);
  assert.doesNotMatch(r.stdout + r.stderr, /stand-in"/);
});
