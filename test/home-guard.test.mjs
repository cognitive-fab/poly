// No test writes under the owner's real home (ruled 2026-10-11). test/fixtures/home-guard.mjs is preloaded into every test
// process and fails one that changes what is under the watched folder. Here it watches a folder of its own, named by
// POLY_HOME_GUARD_DIR, so the guard is tested without touching the real home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

const GUARD = pathToFileURL(join(ROOT, 'test', 'fixtures', 'home-guard.mjs')).href;
// NODE_TEST_CONTEXT is how the running test runner marks its children; a `node --test` child that inherits it does not run as a runner.
const run = (args, watched) => {
  const env = { ...process.env, POLY_HOME_GUARD_DIR: watched };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env });
};

test('a process that writes under the watched folder fails, and says which file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-guard-'));
  try {
    const file = join(dir, 'anchors.json');
    const r = run(['--import', GUARD, '-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, '{}')`], dir);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /HOME GUARD/);
    assert.ok(r.stderr.includes('anchors.json'), r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a process that changes or removes a file there fails, one that reads and writes elsewhere does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-guard-'));
  const other = mkdtempSync(join(tmpdir(), 'poly-guard-other-'));
  try {
    const file = join(dir, 'anchors.json');
    writeFileSync(file, '{}');
    const fs = "require('node:fs')";
    assert.equal(run(['--import', GUARD, '-e', `${fs}.readFileSync(${JSON.stringify(file)}); ${fs}.writeFileSync(${JSON.stringify(join(other, 'x'))}, 'x')`], dir).status, 0, 'a read, and a write elsewhere');
    assert.equal(run(['--import', GUARD, '-e', `${fs}.writeFileSync(${JSON.stringify(file)}, '{"anchors":{}}')`], dir).status, 1, 'a changed file');
    assert.equal(run(['--import', GUARD, '-e', `${fs}.rmSync(${JSON.stringify(file)})`], dir).status, 1, 'a removed file');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test('a test file run by `node --import guard --test` is failed by the guard, so `npm test` guards every file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-guard-'));
  const scratch = mkdtempSync(join(tmpdir(), 'poly-guard-test-'));
  try {
    const testFile = join(scratch, 'writes.test.mjs');
    writeFileSync(testFile, `import { test } from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('writes', () => { writeFileSync(${JSON.stringify(join(dir, 'anchors.json'))}, '{}'); });\n`);
    const r = run(['--import', GUARD, '--test', testFile], dir);
    assert.notEqual(r.status, 0, 'the file passes its own assertions and is failed by the guard');
    assert.match(r.stdout + r.stderr, /HOME GUARD/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); }
});

test('the guard is wired: npm test preloads it into both runs, and the helpers and the test-anchors preload import it', () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts.test.split('node --import ./test/fixtures/home-guard.mjs --test ').length - 1, 2);
  assert.match(readFileSync(join(ROOT, 'test', 'runtime-helpers.mjs'), 'utf8'), /import '\.\/fixtures\/home-guard\.mjs'/);
  assert.match(readFileSync(join(ROOT, 'test', 'fixtures', 'accept-test-anchors.mjs'), 'utf8'), /import '\.\/home-guard\.mjs'/);
});
