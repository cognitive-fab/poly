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
