// The code review of M6, part D (the boundary check, the adapters and the vendored engines): each finding, reproduced by
// a script under .poly/review-m6-d, is a test here that failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { violationsOf, checkRepository } from '../scripts/check-boundaries.mjs';
import { ROOT } from './helpers.mjs';

test('review D-F1: a host is named in any case or spelling, and a host SDK reached by a template or a computed name is refused', () => {
  for (const [pkg, src] of [
    ['poly-check', '// started by Claude Code\n'],
    ['poly-agent', "const bin = 'claude';\n"],
    ['poly-check', "const host = 'Claude-Code';\n"],
    ['poly-check', '// the DeepSeek Harness plugin\n'],
    ['poly-agent', "const sdk = '@modelcontextprotocol/' + 'sdk/server';\nconst { Server } = await import(sdk);\n"],
    ['poly-agent', 'const { Server } = await import(`@modelcontextprotocol/sdk/server`);\n'],
  ]) assert.ok(violationsOf(pkg, `packages/${pkg}/src/x.ts`, src).length >= 1, src);
  // poly-new is the one package that starts the host's command line (S169), so it may name it.
  assert.deepEqual(violationsOf('poly-new', 'packages/poly-new/src/x.ts', "const bin = 'claude'; // Claude Code, headless\n"), []);
  // The model is not a host: a sentence that names Claude the model, or a word that contains a host's name, passes.
  assert.deepEqual(violationsOf('poly-check', 'packages/poly-check/src/x.ts', '// claudes and claudette are not hosts\n'), []);
});

test('review D-F2: rule 4 holds against a computed name, a relative path, a subpath and getBuiltinModule', () => {
  for (const [pkg, src] of [
    ['poly-runtime', "const pkg = '@poly/' + 'new';\nconst { claudeCliProvider } = await import(pkg);\n"],
    ['poly-check', "import { claudeCliProvider } from '../../poly-new/dist/src/index.js';\n"],
    ['poly-check', "import { claudeCliProvider } from '@poly/new/dist/src/providers.js';\n"],
    ['poly-check', "const { spawn } = process.getBuiltinModule('node:child_process');\n"],
  ]) assert.ok(violationsOf(pkg, `packages/${pkg}/src/x.ts`, src).length >= 1, src);
});

test('review D-F3: .mts and .cts sources are checked as .ts ones are', () => {
  const root = mkdtempSync(join(tmpdir(), 'poly-review-d-'));
  try {
    const src = join(root, 'packages', 'poly-check', 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'host.mts'), "import { spawn } from 'node:child_process';\n");
    writeFileSync(join(src, 'host.cts'), "import { Server } from '@modelcontextprotocol/sdk/server';\n");
    const v = checkRepository(root);
    assert.ok(v.some((x) => x.includes('host.mts')), JSON.stringify(v));
    assert.ok(v.some((x) => x.includes('host.cts')), JSON.stringify(v));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('review D-F4: an adapter launches poly mcp, poly lsp or the polyflow server only, and carries no hooks', () => {
  const root = mkdtempSync(join(tmpdir(), 'poly-review-d-'));
  try {
    mkdirSync(join(root, 'packages'), { recursive: true });
    const dir = join(root, 'adapters', 'h');
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'h', mcpServers: { x: { command: 'node', args: ['-e', 'process.exit(0)'] } } }));
    writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo' }] }] } }));
    const v = checkRepository(root);
    assert.ok(v.some((x) => /plugin\.json/.test(x) && /launches/.test(x)), JSON.stringify(v));
    assert.ok(v.some((x) => /hooks\.json/.test(x) && /hook/.test(x)), JSON.stringify(v));
    // What poly's own adapters launch passes.
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), readFileSync(join(ROOT, 'adapters', 'claude-code', '.claude-plugin', 'plugin.json')));
    writeFileSync(join(dir, 'install.json'), readFileSync(join(ROOT, 'adapters', 'claude-code', 'install.json')));
    rmSync(join(dir, 'hooks'), { recursive: true, force: true });
    assert.deepEqual(checkRepository(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const walk = (d) => readdirSync(d).flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)]));
const written = (dir) => [...readFileSync(join(ROOT, 'vendor', dir, 'PROVENANCE.md'), 'utf8').matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \| written for poly \|$/gm)].map((m) => ({ file: m[1], sha: m[2] }));
const copied = (dir) => [...readFileSync(join(ROOT, 'vendor', dir, 'PROVENANCE.md'), 'utf8').matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((m) => m[1]);

test('review D-F5: every file under vendor/ is pinned, the copies and the files written for poly alike', () => {
  for (const dir of ['polygraph', 'sam-pattern', 'polyflow']) {
    const rows = written(dir);
    assert.ok(rows.some((r) => r.file === 'package.json'), `${dir}: its package.json is pinned`);
    for (const { file, sha } of rows) assert.equal(createHash('sha256').update(readFileSync(join(ROOT, 'vendor', dir, file))).digest('hex'), sha, `${dir}/${file}`);
    const pinned = new Set([...copied(dir), ...rows.map((r) => r.file), 'PROVENANCE.md']);
    const loose = walk(join(ROOT, 'vendor', dir)).map((f) => relative(join(ROOT, 'vendor', dir), f).split(sep).join('/')).filter((f) => !pinned.has(f));
    assert.deepEqual(loose, [], `${dir}: files no row covers`);
  }
});

test('review D-F6: the install test removes the project it builds', { timeout: 600_000 }, () => {
  // The test's project is named by its process, so the suite's own run of it, alongside, is a different folder.
  const r = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', '--test-name-pattern=launched exactly as printed', join(ROOT, 'test', 'adapters.test.mjs')], { cwd: ROOT, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')) });
  assert.equal(r.status, 0, r.stdout.slice(-3000) + r.stderr.slice(-2000));
  assert.match(r.stdout, /# pass 1/);
  assert.equal(existsSync(join(ROOT, '.poly', `test-install-${r.pid}`)), false);
});
