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
