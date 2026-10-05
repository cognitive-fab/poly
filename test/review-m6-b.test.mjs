// The code review of M6, part B (registry, CLI, MCP server, poly new): each finding, reproduced by a script under
// .poly/review-m6-b, is a test here that failed before its fix. No test runs a model or the real claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ROOT } from './helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const GOOD = readFileSync(join(ROOT, 'conformance', 'm6', 'brief.poly'), 'utf8');
const DIR = join(ROOT, '.poly', 'test-review-m6-b');

test('review B-F1: the headless provider refuses to start while Bedrock or Vertex billing is switched on, checked by name', () => {
  const code = `
    const { claudeCliProvider, API_KEY_VARIABLES } = await import('@poly/new');
    console.log(JSON.stringify(API_KEY_VARIABLES));
    try { await claudeCliProvider({ bin: 'poly-no-such-claude' }).draft({ description: 'x', grammar: '' }); console.log('STARTED'); }
    catch (e) { console.log('OUTCOME ' + e.message); }
  `;
  for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
    const env = { ...process.env, [name]: 'stand-in-switch' };
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) if (k !== name) delete env[k];
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8', env });
    assert.ok(JSON.parse(r.stdout.split('\n')[0]).includes(name), name);
    assert.match(r.stdout, new RegExp(`OUTCOME poly new does not start Claude Code while ${name}`), r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /stand-in-switch/);
  }
});

test('review B-F2: poly new never overwrites a module that is not its own draft, and refuses before any provider runs', async () => {
  const { newCommand, recordedProvider, HEADER } = await import('@poly/new');
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const mine = join(DIR, 'mine.poly');
  writeFileSync(mine, GOOD);
  const provider = recordedProvider([GOOD]);
  await assert.rejects(newCommand(() => provider).run({ description: 'x', into: mine }), /already holds a module/);
  assert.equal(readFileSync(mine, 'utf8'), GOOD);
  assert.equal(provider.requests.length, 0);
  // An earlier draft of poly new's own may be drafted again.
  const draft = join(DIR, 'draft.poly');
  writeFileSync(draft, HEADER + GOOD);
  const o = await newCommand(() => recordedProvider([GOOD])).run({ description: 'x', into: draft });
  assert.equal(o.result.verdict, 'CLEAN');
});

/** A raw MCP session, for the protocol findings. */
function raw() {
  const child = spawn(process.execPath, [CLI, 'mcp'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const seen = [];
  createInterface({ input: child.stdout }).on('line', (l) => { try { seen.push(JSON.parse(l)); } catch { /* not ours */ } });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const until = async (pred, ms) => { const t0 = Date.now(); for (;;) { const m = seen.find(pred); if (m) return m; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 50)); } };
  return { child, seen, send, until, close: () => { child.stdin.end(); child.kill(); } };
}

test('review B-F3, B-F4: a ping is answered while poly_new waits on sampling, and a response from the client gets no reply', { timeout: 120_000 }, async () => {
  mkdirSync(DIR, { recursive: true });
  const s = raw();
  try {
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { sampling: {} }, clientInfo: { name: 't', version: '0' } } });
    assert.ok(await s.until((m) => m.id === 1, 20_000));
    s.send({ method: 'notifications/initialized' });
    s.send({ id: 77, result: {} });
    assert.equal(await s.until((m) => m.id === 77, 2_000), null, 'no reply to a response (B-F4)');
    s.send({ id: 2, method: 'tools/call', params: { name: 'poly_new', arguments: { description: 'x', into: join(DIR, 'pinged.poly') } } });
    const sampling = await s.until((m) => m.method === 'sampling/createMessage', 30_000);
    assert.ok(sampling);
    s.send({ id: 3, method: 'ping' });
    assert.ok(await s.until((m) => m.id === 3, 5_000), 'the ping is answered while the call waits (B-F3)');
    s.send({ id: sampling.id, result: { role: 'assistant', content: { type: 'text', text: GOOD }, model: 'recorded', stopReason: 'endTurn' } });
    const done = await s.until((m) => m.id === 2, 90_000);
    assert.equal(done?.result?.structuredContent?.verdict, 'CLEAN');
  } finally { s.close(); }
});

test('review B-F5: the module is the poly block of an answer, even after another fenced block', async () => {
  const { sourceOf } = await import('@poly/new');
  assert.equal(sourceOf('Here is a shell line:\n```sh\nnpm test\n```\nThe module:\n```poly\nmodule m\n```\n'), 'module m\n');
  assert.equal(sourceOf('```\nmodule n\n```'), 'module n\n');
  assert.equal(sourceOf('module bare'), 'module bare\n');
});

test('review B-F6: poly bench gate with bad sizes prints the usage text, as before the registry', () => {
  const r = spawnSync(process.execPath, [CLI, 'bench', 'gate', '--sizes', '0'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /^usage: poly check/);
});
