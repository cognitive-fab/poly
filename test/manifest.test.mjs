// The manifest (PT1.2, decision M1-6): `poly check` takes a file or a project directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseManifest, loadProject, ManifestError } from '@poly/core';
import { checkProject } from '@poly/check';
import { ROOT } from './helpers.mjs';

const PROJECT = join(ROOT, 'test', 'fixtures', 'project');
const OUT = join(ROOT, '.poly', 'test-build', 'project');

test('PT1.2: the manifest as the spec states it parses', () => {
  const m = parseManifest('{ "poly": "1", "name": "orders", "modules": ["src/*.poly"], "host": "typescript", "require": { "grade": false }, "engines": { "polygraph": "^8.3", "polyaxion": "^2" } }');
  assert.equal(m.name, 'orders');
  assert.deepEqual(m.modules, ['src/*.poly']);
});

test('PT1.2: fields outside the spec, and malformed ones, are refused, not ignored', () => {
  const bad = [
    '{ "poly": "1", "name": "x", "modules": ["a.poly"], "configurations": [] }',
    '{ "poly": "2", "name": "x", "modules": ["a.poly"] }',
    '{ "poly": "1", "modules": ["a.poly"] }',
    '{ "poly": "1", "name": "x", "modules": [] }',
    '{ "poly": "1", "name": "x", "modules": ["a.poly"], "host": "python" }',
    '{ "poly": "1", "name": "x", "modules": ["a.poly"], "require": { "grade": "yes" } }',
    'not json',
  ];
  for (const text of bad) assert.throws(() => parseManifest(text), ManifestError, text);
});

test('module patterns: * within a segment, ** across segments; the files come back sorted', () => {
  const { files } = loadProject(PROJECT);
  assert.deepEqual(files.map((f) => relative(PROJECT, f).split('\\').join('/')), ['more/gate-empty.poly', 'src/gate.poly']);
});

test('a pattern that matches nothing, or matches a non-poly file, is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-manifest-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'notes.txt'), 'x');
    writeFileSync(join(dir, 'poly.json'), '{ "poly": "1", "name": "x", "modules": ["src/*.poly"] }');
    assert.throws(() => loadProject(dir), /matches no file/);
    writeFileSync(join(dir, 'poly.json'), '{ "poly": "1", "name": "x", "modules": ["src/*"] }');
    assert.throws(() => loadProject(dir), /not a \.poly file/);
    rmSync(join(dir, 'poly.json'));
    assert.throws(() => loadProject(dir), /no poly\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('poly check <dir> checks every module and folds the verdicts', async () => {
  const p = await checkProject(PROJECT, { root: OUT });
  assert.equal(p.name, 'hello-project');
  assert.deepEqual(p.files.map((r) => r.verdict), ['CLEAN', 'FINDINGS']);
  assert.equal(p.verdict, 'FINDINGS');
  assert.equal(p.exit, 1);
});

test('the CLI takes a directory, and a bad manifest is a usage error', () => {
  const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
  const ok = spawnSync(process.execPath, [cli, 'check', PROJECT, '--root', OUT], { encoding: 'utf8' });
  assert.equal(ok.status, 1, ok.stderr);
  assert.match(ok.stdout, /project hello-project: FINDINGS \(exit 1\) over 2 modules/);
  const dir = mkdtempSync(join(tmpdir(), 'poly-manifest-'));
  try {
    writeFileSync(join(dir, 'poly.json'), '{ "poly": "1" }');
    const bad = spawnSync(process.execPath, [cli, 'check', dir], { encoding: 'utf8' });
    assert.equal(bad.status, 64);
    assert.match(bad.stderr, /"name" must be a non-empty string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('polywatch: --root needs a value; an option in its place is a usage error', () => {
  const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'check', join(ROOT, 'examples', 'hello', 'hello.poly'), '--root', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 64, r.stdout + r.stderr);
});

test('polywatch: a symlinked directory is not followed out of the project, and a link loop ends', async () => {
  const { symlinkSync } = await import('node:fs');
  const outside = mkdtempSync(join(tmpdir(), 'poly-outside-'));
  const dir = mkdtempSync(join(tmpdir(), 'poly-links-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.poly'), 'module a\n');
    writeFileSync(join(outside, 'b.poly'), 'module b\n');
    // 'junction' needs no privilege on Windows and is ignored elsewhere.
    symlinkSync(outside, join(dir, 'src', 'out'), 'junction');
    symlinkSync(dir, join(dir, 'src', 'loop'), 'junction');
    writeFileSync(join(dir, 'poly.json'), '{ "poly": "1", "name": "x", "modules": ["src/**/*.poly"] }');
    const { files } = loadProject(dir);
    assert.deepEqual(files.map((f) => relative(dir, f).split('\\').join('/')), ['src/a.poly']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
