// DF27: The demo is admitted once per test run for each source.
// This file tests the key computation (item 4) and admission modes (items 2, 3, 7)
// without running real admissions. All admitted sources are shared by default;
// the mode controls whether POLY_TEST_RUN names a shared store or forces fresh
// (item 2, item 3, item 7). The store is outside the repository (item 5).
//
// Contract (to be implemented by demo/host/admission.mjs):
// - admissionKey(object): computes the key from source, project, run id,
//   files, handlers and toolchain digest. Files are read from source folder
//   recursively: concierge.poly, concierge.policy.poly, and every file under
//   maps/ and prices/. Paths are relative and use forward slashes. The key is
//   the lowercase hex SHA-256 of RFC 8785 canonical JSON of
//   { run, project, files, handlers, toolchain }. Files are ordered by POSIX
//   path with RFC 8785 rules (uppercase before lowercase after the same ASCII).
// - admissionMode(object): returns 'shared' or 'fresh', reading POLY_TEST_RUN
//   and POLY_DEMO_ADMISSION from the supplied env (default process.env).
//   Truth table: { admission, env } -> 'shared' (default) or 'fresh'.
// - storeDir(key): returns the path <os.tmpdir()>/poly-demo-admissions/<key>/.
// - storedAdmission(key): returns the store folder if ready.json exists, else null.
// - admissionCount(): returns the number of real admit() calls in this process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as A from '../demo/host/admission.mjs';
import { ROOT } from './helpers.mjs';

// RFC 8785 canonical JSON: keys sorted, no whitespace, strings quoted.
// Used to compute the expected key for testing purposes.
function canonicalJson(obj) {
  if (obj === null) return 'null';
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',') + '}';
  }
  return String(obj);
}

// Read a file and return base64 of its bytes.
function fileBase64(path) {
  return readFileSync(path).toString('base64');
}

// Recursively gather source files. POSIX relative paths with forward slashes.
// Order by path (the canonicalJson will sort them).
// Files must exist; missing files are an error.
function gatherSourceFiles(sourceDir, includedFolders = ['maps', 'prices']) {
  const files = {};
  const sourceFiles = ['concierge.poly', 'concierge.policy.poly'];

  // Gather named files at root.
  for (const name of sourceFiles) {
    const p = join(sourceDir, name);
    const relPath = relative(sourceDir, p).split(sep).join('/');
    files[relPath] = fileBase64(p);
  }

  // Recursively gather folders.
  function walkDir(dir) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const stat = statSync(p);
      if (stat.isDirectory()) {
        walkDir(p);
      } else {
        const relPath = relative(sourceDir, p).split(sep).join('/');
        files[relPath] = fileBase64(p);
      }
    }
  }

  for (const folder of includedFolders) {
    const p = join(sourceDir, folder);
    walkDir(p);
  }

  return files;
}

// Compute the expected key using the canonical JSON method.
// Inputs: run (string), project (string), sourceDir (path), toolchain (string),
// handlers (string, defaults to A.HANDLERS_TS from demo/host/admission.mjs).
function expectedAdmissionKey(run, project, sourceDir, toolchain, handlers) {
  const files = gatherSourceFiles(sourceDir);
  const obj = { run, project, files, handlers: handlers || A.HANDLERS_TS, toolchain };
  const json = canonicalJson(obj);
  return createHash('sha256').update(json).digest('hex');
}

test('DF27 item 4: admission key is SHA-256 of canonical JSON', async () => {
  // Test that the key is computed correctly from the required parts (item 4).
  // Build a synthetic source in a temporary folder.
  const tmpSource = join(tmpdir(), 'poly-test-key-' + Math.random().toString(36).slice(2));
  try {
    mkdirSync(tmpSource, { recursive: true });

    // Write test source files.
    writeFileSync(join(tmpSource, 'concierge.poly'), 'module concierge {}');
    writeFileSync(join(tmpSource, 'concierge.policy.poly'), 'policy {}');

    // Nested maps structure to catch backslash paths on Windows.
    mkdirSync(join(tmpSource, 'maps', 'sub'), { recursive: true });
    writeFileSync(join(tmpSource, 'maps', 'sub', 'x'), 'x');
    writeFileSync(join(tmpSource, 'maps', 'a'), 'a');
    writeFileSync(join(tmpSource, 'maps', 'B'), 'B');

    // Nested prices structure.
    mkdirSync(join(tmpSource, 'prices', 'sub'), { recursive: true });
    writeFileSync(join(tmpSource, 'prices', 'sub', 'y'), 'y');
    writeFileSync(join(tmpSource, 'prices', 'p'), 'p');

    const run = 'test-run-123';
    const project = 'concierge';
    const toolchain = 'digest-abc123';

    const actualKey = await A.admissionKey({ run, project, source: tmpSource, toolchain, handlers: A.HANDLERS_TS });
    const expectedKey = expectedAdmissionKey(run, project, tmpSource, toolchain, A.HANDLERS_TS);

    assert.equal(actualKey, expectedKey, 'key matches expected canonical JSON hash');
    assert.match(actualKey, /^[a-f0-9]{64}$/, 'key is 64 lowercase hex characters (SHA-256)');
  } finally {
    rmSync(tmpSource, { recursive: true, force: true });
  }
});

test('DF27 item 9a: changing one byte in a source file gives a new key', async () => {
  // Test that changing a single byte in any source file (concierge.poly,
  // concierge.policy.poly, or files under maps/ or prices/) produces a different key.
  const tmpSource = join(tmpdir(), 'poly-test-key-change-' + Math.random().toString(36).slice(2));
  try {
    mkdirSync(tmpSource, { recursive: true });

    // Write initial test source files.
    writeFileSync(join(tmpSource, 'concierge.poly'), 'module concierge { field x: int = 0 }');
    writeFileSync(join(tmpSource, 'concierge.policy.poly'), 'policy {}');
    mkdirSync(join(tmpSource, 'maps'), { recursive: true });
    writeFileSync(join(tmpSource, 'maps', 'prices'), 'price: 100');

    const run = 'test-run-456';
    const project = 'concierge';
    const toolchain = 'digest-def456';

    // Compute original key.
    const originalKey = await A.admissionKey({ run, project, source: tmpSource, toolchain });

    // Change each file by one byte and verify the key differs.
    const filesToTest = [
      'concierge.poly',
      'concierge.policy.poly',
      join('maps', 'prices')
    ];

    for (const file of filesToTest) {
      const path = join(tmpSource, file);
      const originalContent = readFileSync(path, 'utf8');
      const changedContent = originalContent.slice(0, -1) + (originalContent.charCodeAt(originalContent.length - 1) === 48 ? '1' : '0');
      writeFileSync(path, changedContent);

      const changedKey = await A.admissionKey({ run, project, source: tmpSource, toolchain });
      assert.notEqual(changedKey, originalKey, `changing ${file} produces a different key`);

      // Restore the file for the next iteration.
      writeFileSync(path, originalContent);
    }
  } finally {
    rmSync(tmpSource, { recursive: true, force: true });
  }
});

test('DF27 item 9b: different toolchain digests give different keys for the same source', async () => {
  // Test that two digests differing in one byte produce two different keys.
  const tmpSource = join(tmpdir(), 'poly-test-digest-' + Math.random().toString(36).slice(2));
  try {
    mkdirSync(tmpSource, { recursive: true });

    writeFileSync(join(tmpSource, 'concierge.poly'), 'module concierge {}');
    writeFileSync(join(tmpSource, 'concierge.policy.poly'), 'policy {}');
    mkdirSync(join(tmpSource, 'maps'), { recursive: true });
    writeFileSync(join(tmpSource, 'maps', 'data'), 'data');

    const run = 'test-run-digest';
    const project = 'concierge';
    const toolchain1 = 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344';
    const toolchain2 = 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223345'; // Last byte differs.

    const key1 = await A.admissionKey({ run, project, source: tmpSource, toolchain: toolchain1 });
    const key2 = await A.admissionKey({ run, project, source: tmpSource, toolchain: toolchain2 });

    assert.notEqual(key1, key2, 'different toolchain digests produce different keys');
  } finally {
    rmSync(tmpSource, { recursive: true, force: true });
  }
});

test('DF27 item 4: different run ids give different keys', async () => {
  // Test that different run ids produce different keys (item 4: run is part of the key).
  const tmpSource = join(tmpdir(), 'poly-test-run-id-' + Math.random().toString(36).slice(2));
  try {
    mkdirSync(tmpSource, { recursive: true });

    writeFileSync(join(tmpSource, 'concierge.poly'), 'module concierge {}');
    writeFileSync(join(tmpSource, 'concierge.policy.poly'), 'policy {}');

    const project = 'concierge';
    const toolchain = 'digest-ghi789';

    const key1 = await A.admissionKey({ run: 'run-1', project, source: tmpSource, toolchain });
    const key2 = await A.admissionKey({ run: 'run-2', project, source: tmpSource, toolchain });

    assert.notEqual(key1, key2, 'different run ids produce different keys');
  } finally {
    rmSync(tmpSource, { recursive: true, force: true });
  }
});

test('DF27 item 2: POLY_TEST_RUN absent means fresh admission', async () => {
  const mode = await A.admissionMode({ env: {} });
  assert.equal(mode, 'fresh', 'missing POLY_TEST_RUN gives fresh');
});

test('DF27 item 3: POLY_TEST_RUN set means shared admission', async () => {
  const env = { POLY_TEST_RUN: 'test-run-xyz' };
  const mode = await A.admissionMode({ env });
  assert.equal(mode, 'shared', 'POLY_TEST_RUN set gives shared');
});

test('DF27 item 3: POLY_DEMO_ADMISSION=fresh overrides to fresh', async () => {
  const env = { POLY_TEST_RUN: 'test-run-xyz', POLY_DEMO_ADMISSION: 'fresh' };
  const mode = await A.admissionMode({ env });
  assert.equal(mode, 'fresh', 'POLY_DEMO_ADMISSION=fresh overrides to fresh');
});

test('DF27 item 7: explicit admission: "fresh" parameter gives fresh', async () => {
  const env = { POLY_TEST_RUN: 'test-run-xyz' };
  const mode = await A.admissionMode({ admission: 'fresh', env });
  assert.equal(mode, 'fresh', 'admission: "fresh" gives fresh');
});

test('DF27 item 7: admission: "shared" parameter gives shared (default)', async () => {
  const env = { POLY_TEST_RUN: 'test-run-xyz' };
  const mode = await A.admissionMode({ admission: 'shared', env });
  assert.equal(mode, 'shared', 'admission: "shared" gives shared');
});

test('DF27 item 5: storeDir is in os.tmpdir(), not in the repository', async () => {
  const testKey = 'test-key-' + Math.random().toString(36).slice(2);
  const storeDir = await A.storeDir(testKey);

  const tmpDir = tmpdir();
  assert.ok(storeDir.startsWith(tmpDir), `store dir starts with tmpdir: ${tmpDir}`);
  assert.ok(!storeDir.startsWith(ROOT), `store dir is not under repository: ${ROOT}`);
  assert.ok(storeDir.includes('poly-demo-admissions'), 'store dir includes poly-demo-admissions');
  assert.ok(storeDir.includes(testKey), 'store dir includes the key');
});

test('DF27 item 5: folder without ready.json is not read', async () => {
  const testKey = 'test-ready-' + Math.random().toString(36).slice(2);
  const storeDir = await A.storeDir(testKey);

  try {
    // Create the store folder without ready.json.
    mkdirSync(storeDir, { recursive: true });

    const result = await A.storedAdmission(testKey);
    assert.equal(result, null, 'folder without ready.json returns null');

    // Now add ready.json and verify it is read.
    writeFileSync(join(storeDir, 'ready.json'), '{}');

    const result2 = await A.storedAdmission(testKey);
    assert.equal(typeof result2, 'string', 'folder with ready.json returns the store dir');
    assert.equal(result2, storeDir, 'storedAdmission returns the store dir');
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test('DF27 item 3: preload sets POLY_TEST_RUN with ??= (keeps existing value)', async () => {
  // Test that the preload sets POLY_TEST_RUN when not already set (item 3).
  // Keeps an existing value; generates a new id each process.
  const keepValue = 'keep-me-value-' + Math.random().toString(36).slice(2);

  // Spawn with preset POLY_TEST_RUN.
  const env1 = { ...process.env, POLY_TEST_RUN: keepValue };
  const result1 = spawnSync(process.execPath, ['--import', './test/fixtures/home-guard.mjs', '-e', 'console.log(process.env.POLY_TEST_RUN)'], {
    cwd: ROOT,
    env: env1,
    encoding: 'utf8'
  });
  const output1 = result1.stdout.trim();
  assert.equal(output1, keepValue, 'preload keeps preset POLY_TEST_RUN');

  // Spawn without POLY_TEST_RUN.
  const env2 = { ...process.env };
  delete env2.POLY_TEST_RUN;
  const result2 = spawnSync(process.execPath, ['--import', './test/fixtures/home-guard.mjs', '-e', 'console.log(process.env.POLY_TEST_RUN)'], {
    cwd: ROOT,
    env: env2,
    encoding: 'utf8'
  });
  const output2 = result2.stdout.trim();
  assert.ok(output2, 'preload sets a non-empty id when POLY_TEST_RUN is absent');

  // Spawn again to verify the id differs (new process).
  const result3 = spawnSync(process.execPath, ['--import', './test/fixtures/home-guard.mjs', '-e', 'console.log(process.env.POLY_TEST_RUN)'], {
    cwd: ROOT,
    env: env2,
    encoding: 'utf8'
  });
  const output3 = result3.stdout.trim();
  assert.notEqual(output2, output3, 'preload generates a new id for each process');
});

// DF27 items 3, 5, 11 and DAC31: store paths and operations.
// These tests import functions from demo/host/admission-store.mjs (rule 7a: not yet implemented).

test('DF27 item 5: storeRoot() returns os.tmpdir()/poly-demo-admissions', async () => {
  const S = await import('../demo/host/admission-store.mjs');
  const root = S.storeRoot();
  assert.equal(root, join(tmpdir(), 'poly-demo-admissions'));
});

test('DF27 item 5: storeDir(key, run, root) returns root/run/key', async () => {
  const S = await import('../demo/host/admission-store.mjs');
  const root = tmpdir();
  const run = 'test-run-xyz';
  const key = 'abc123def456';
  const path = S.storeDir(key, run, root);
  assert.equal(path, join(root, run, key));
});

test('DF27 item 5: storeDir with defaults uses POLY_TEST_RUN and storeRoot()', async () => {
  const S = await import('../demo/host/admission-store.mjs');
  const orig = process.env.POLY_TEST_RUN;
  try {
    process.env.POLY_TEST_RUN = 'test-run-default';
    const path = S.storeDir('abc123');
    assert.ok(path.includes('test-run-default'), 'storeDir includes POLY_TEST_RUN');
    assert.ok(path.includes('poly-demo-admissions'), 'storeDir includes poly-demo-admissions');
    assert.ok(path.includes('abc123'), 'storeDir includes key');
  } finally {
    if (orig !== undefined) process.env.POLY_TEST_RUN = orig;
    else delete process.env.POLY_TEST_RUN;
  }
});

test('DF27 item 5: settle(staging, target) renames staging to target', async () => {
  const S = await import('../demo/host/admission-store.mjs');
  const tmpRoot = mkdirSync(join(tmpdir(), 'settle-test-' + Math.random().toString(36).slice(2)), { recursive: true });
  try {
    const staging = join(tmpRoot, 'staging');
    const target = join(tmpRoot, 'target');
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'file.txt'), 'content');

    const result = await S.settle(staging, target);
    assert.equal(result, target);
    assert.ok(statSync(target, { throwIfNoEntry: false }), 'target directory exists');
    assert.ok(!statSync(staging, { throwIfNoEntry: false }), 'staging is removed');
    assert.equal(readFileSync(join(target, 'file.txt'), 'utf8'), 'content');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('DF27 item 5: settle returns target when it exists with ready.json and removes staging', async () => {
  const S = await import('../demo/host/admission-store.mjs');
  const tmpRoot = join(tmpdir(), 'settle-exists-' + Math.random().toString(36).slice(2));
  mkdirSync(tmpRoot, { recursive: true });
  try {
    const staging = join(tmpRoot, 'staging');
    const target = join(tmpRoot, 'target');
    mkdirSync(staging, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(staging, 'new-file.txt'), 'staging content');
    writeFileSync(join(target, 'ready.json'), '{}');
    writeFileSync(join(target, 'old-file.txt'), 'target content');

    const result = await S.settle(staging, target);
    assert.equal(result, target);
    assert.ok(!statSync(staging, { throwIfNoEntry: false }), 'staging is removed');
    assert.equal(readFileSync(join(target, 'old-file.txt'), 'utf8'), 'target content', 'target file unchanged');
    assert.ok(!statSync(join(target, 'new-file.txt'), { throwIfNoEntry: false }), 'staging file not in target');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('DF27 item 5: settle throws when target exists without ready.json', async () => {
  const S = await import('../demo/host/admission-store.mjs');
  const tmpRoot = join(tmpdir(), 'settle-throw-' + Math.random().toString(36).slice(2));
  mkdirSync(tmpRoot, { recursive: true });
  try {
    const staging = join(tmpRoot, 'staging');
    const target = join(tmpRoot, 'target');
    mkdirSync(staging, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(staging, 'file.txt'), 'content');
    writeFileSync(join(target, 'marker.txt'), 'exists');

    await assert.rejects(async () => S.settle(staging, target), (e) => /EPERM|ENOTEMPTY|EEXIST/.test(e.code));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('DF27 item 11: endRun counts folders with ready.json and removes the run', async () => {
  const S = await import('../demo/host/admission-store.mjs');
  const tmpRoot = join(tmpdir(), 'endrun-' + Math.random().toString(36).slice(2));
  const run = 'test-run-endrun';
  mkdirSync(tmpRoot, { recursive: true });
  try {
    const runDir = join(tmpRoot, run);
    mkdirSync(runDir, { recursive: true });

    // Create a key folder with ready.json
    const key1 = join(runDir, 'key1');
    mkdirSync(key1, { recursive: true });
    writeFileSync(join(key1, 'ready.json'), '{}');

    // Create another key folder with ready.json
    const key2 = join(runDir, 'key2');
    mkdirSync(key2, { recursive: true });
    writeFileSync(join(key2, 'ready.json'), '{}');

    // Create a staging folder (should not be counted)
    const staging = join(runDir, '.staging-123-abc');
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'ready.json'), '{}');

    // Create a key folder without ready.json (should not be counted)
    const key3 = join(runDir, 'key3');
    mkdirSync(key3, { recursive: true });
    writeFileSync(join(key3, 'data.json'), '{}');

    const count = await S.endRun({ run, root: tmpRoot });
    assert.equal(count, 2, 'counts only key folders with ready.json');
    assert.ok(!statSync(runDir, { throwIfNoEntry: false }), 'run folder is removed');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('DF27 item 11: endRun returns 0 when run folder does not exist', async () => {
  const S = await import('../demo/host/admission-store.mjs');
  const tmpRoot = join(tmpdir(), 'endrun-missing-' + Math.random().toString(36).slice(2));
  mkdirSync(tmpRoot, { recursive: true });
  try {
    const count = await S.endRun({ run: 'nonexistent-run', root: tmpRoot });
    assert.equal(count, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('DF27 item 11: sweepStores removes entries older than maxAgeMs and keeps newer ones', async () => {
  const S = await import('../demo/host/admission-store.mjs');
  const tmpRoot = join(tmpdir(), 'sweep-' + Math.random().toString(36).slice(2));
  mkdirSync(tmpRoot, { recursive: true });
  try {
    const now = 1_800_000_000_000; // Fixed time in milliseconds
    const maxAgeMs = 7 * 24 * 3600 * 1000; // 7 days

    // Create an old entry (older than maxAgeMs)
    const oldRun = join(tmpRoot, 'old-run');
    mkdirSync(oldRun, { recursive: true });
    const oldMtime = now - maxAgeMs - 1000; // 1 second older
    statSync(oldRun); // Force creation before setting mtime
    // Can't set mtime directly on mkdirSync, so we'll create with children first
    const oldChild = join(oldRun, 'child');
    mkdirSync(oldChild, { recursive: true });
    const oldFile = join(oldChild, 'file.txt');
    writeFileSync(oldFile, 'old');
    // Set mtime on the child folder
    const { utimesSync } = await import('node:fs');
    utimesSync(oldChild, oldMtime / 1000, oldMtime / 1000);
    utimesSync(oldRun, oldMtime / 1000, oldMtime / 1000);

    // Create an exact-age entry (exactly maxAgeMs old - should be kept)
    const exactRun = join(tmpRoot, 'exact-run');
    mkdirSync(exactRun, { recursive: true });
    const exactMtime = now - maxAgeMs;
    const exactChild = join(exactRun, 'child');
    mkdirSync(exactChild, { recursive: true });
    const exactFile = join(exactChild, 'file.txt');
    writeFileSync(exactFile, 'exact');
    utimesSync(exactChild, exactMtime / 1000, exactMtime / 1000);
    utimesSync(exactRun, exactMtime / 1000, exactMtime / 1000);

    // Create a new entry (newer than maxAgeMs)
    const newRun = join(tmpRoot, 'new-run');
    mkdirSync(newRun, { recursive: true });
    const newMtime = now - 1000; // 1 second ago
    const newChild = join(newRun, 'child');
    mkdirSync(newChild, { recursive: true });
    const newFile = join(newChild, 'file.txt');
    writeFileSync(newFile, 'new');
    utimesSync(newChild, newMtime / 1000, newMtime / 1000);
    utimesSync(newRun, newMtime / 1000, newMtime / 1000);

    // Create an old flat-layout key folder (pre-run layout, should be removed if old)
    const oldKey = join(tmpRoot, 'oldkey1234567890abcdef1234567890ab');
    mkdirSync(oldKey, { recursive: true });
    const oldKeyChild = join(oldKey, 'file.txt');
    writeFileSync(oldKeyChild, 'oldkey');
    utimesSync(oldKey, oldMtime / 1000, oldMtime / 1000);

    const removed = await S.sweepStores({ root: tmpRoot, now, maxAgeMs });
    const removedSorted = removed.sort();

    assert.ok(removedSorted.includes('old-run'), 'removes old run folder');
    assert.ok(removedSorted.includes('oldkey1234567890abcdef1234567890ab'), 'removes old flat-layout key');
    assert.ok(!removedSorted.includes('exact-run'), 'keeps folder exactly maxAgeMs old');
    assert.ok(!removedSorted.includes('new-run'), 'keeps newer folder');

    assert.ok(!statSync(oldRun, { throwIfNoEntry: false }), 'old run folder is gone');
    assert.ok(statSync(exactRun, { throwIfNoEntry: false }), 'exact-age run exists');
    assert.ok(statSync(newRun, { throwIfNoEntry: false }), 'new run exists');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('DF27 item 11: sweepStores returns empty when root does not exist', async () => {
  const S = await import('../demo/host/admission-store.mjs');
  const tmpRoot = join(tmpdir(), 'sweep-missing-' + Math.random().toString(36).slice(2));
  const removed = await S.sweepStores({ root: tmpRoot, now: Date.now(), maxAgeMs: 7 * 24 * 3600 * 1000 });
  assert.deepEqual(removed, []);
});

test('DF27 item 5: POLY_TEST_RUN must match ^[A-Za-z0-9-]{1,64}$', async () => {
  const orig = process.env.POLY_TEST_RUN;
  const origFresh = process.env.POLY_DEMO_ADMISSION;
  try {
    // Test that an invalid id throws before any admission
    const invalidIds = ['..', 'a/b', 'a\\b', 'a'.repeat(65)];
    for (const badId of invalidIds) {
      process.env.POLY_TEST_RUN = badId;
      delete process.env.POLY_DEMO_ADMISSION;

      // Use a nonexistent source so missing files fail fast, not an admission taking minutes
      const source = join(tmpdir(), 'nonexistent-source-' + Math.random().toString(36).slice(2));
      const workdir = join(tmpdir(), 'workdir-' + Math.random().toString(36).slice(2));

      const countBefore = A.admissionCount();
      await assert.rejects(
        () => A.admitDemoConcierge({ source, workdir }),
        (e) => e.code !== 'ENOENT' // Must not be a file-not-found error
      );
      assert.equal(A.admissionCount(), countBefore, `invalid id ${badId} does not start admission`);
    }
  } finally {
    if (orig !== undefined) process.env.POLY_TEST_RUN = orig;
    else delete process.env.POLY_TEST_RUN;
    if (origFresh !== undefined) process.env.POLY_DEMO_ADMISSION = origFresh;
    else delete process.env.POLY_DEMO_ADMISSION;
  }
});

test('DF27 item 3: scripts/test-run.mjs runs a command with a new POLY_TEST_RUN id', async () => {
  const tmpDir = join(tmpdir(), 'test-run-tiny-' + Math.random().toString(36).slice(2));
  mkdirSync(tmpDir, { recursive: true });
  try {
    const tinyScript = join(tmpDir, 'tiny.mjs');
    const outFile = join(tmpDir, 'out.json');

    // Write a tiny test script that writes its run id and creates a store folder
    // Pass outFile as process.argv[2] to avoid template escaping issues
    const tinyCode = `import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const runId = process.env.POLY_TEST_RUN;
const outFile = process.argv[2];
const keyPath = join(tmpdir(), 'poly-demo-admissions', runId, 'abc123def456', 'ready.json');
mkdirSync(join(tmpdir(), 'poly-demo-admissions', runId, 'abc123def456'), { recursive: true });
writeFileSync(keyPath, JSON.stringify({ created: new Date().toISOString() }));

writeFileSync(outFile, JSON.stringify({
  pid: process.pid,
  run: runId,
  created: keyPath
}));
process.exit(7);
`;
    writeFileSync(tinyScript, tinyCode);

    const result = spawnSync(process.execPath, ['scripts/test-run.mjs', 'node', tinyScript, outFile], {
      cwd: ROOT,
      env: { ...process.env, POLY_TEST_RUN: 'outer-run-id' },
      encoding: 'utf8'
    });

    assert.equal(result.status, 7, 'script exits with command exit status');

    // The child process should have written the output file
    assert.ok(statSync(outFile, { throwIfNoEntry: false }), 'child process ran');
    const output = JSON.parse(readFileSync(outFile, 'utf8'));

    // The run id should be different from outer-run-id (always new)
    assert.notEqual(output.run, 'outer-run-id', 'script sets a new run id even when one is already set');

    // The run id should be a valid UUID-like string
    assert.match(output.run, /^[a-f0-9\-]{36}$/, 'run id is a UUID');

    // Check the script's output line has the correct format: poly-demo-admissions: run <id>, <n> admissions
    const expectedLine = `poly-demo-admissions: run ${output.run}, 1 admissions`;
    assert.match(result.stdout + result.stderr, new RegExp(expectedLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'prints run completion line with id and count');

    // The run folder should be cleaned up after the script ends
    const S = await import('../demo/host/admission-store.mjs');
    const runFolderPath = join(S.storeRoot(), output.run);
    assert.ok(!statSync(runFolderPath, { throwIfNoEntry: false }), 'run folder is removed after script ends');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
