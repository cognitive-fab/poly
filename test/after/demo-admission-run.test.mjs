// DF27 item 3, DAC31: Two test files sharing one admission through scripts/test-run.mjs,
// and the same files making separate admissions when run by hand.
// These tests will fail until the coder implements demo/host/admission-store.mjs and scripts/test-run.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../helpers.mjs';

const DEMO_SOURCE = join(ROOT, 'demo', 'concierge');

// Normalize a report by replacing workdir paths to make cross-workdir comparison possible.
function normalizeReport(report, workdir) {
  if (!report) return null;

  const normalizePath = (p) => {
    if (typeof p === 'string' && workdir && p.startsWith(workdir)) {
      return '<workdir>' + p.slice(workdir.length);
    }
    return p;
  };

  const normalizeInstance = (obj) => {
    if (typeof obj === 'string') return normalizePath(obj);
    if (Array.isArray(obj)) return obj.map(normalizeInstance);
    if (obj && typeof obj === 'object') {
      const result = {};
      for (const key in obj) {
        result[key] = normalizeInstance(obj[key]);
      }
      return result;
    }
    return obj;
  };

  const sortedFiles = [...report.files].sort((a, b) => (a.module ?? '').localeCompare(b.module ?? ''));

  return {
    verdict: report.verdict,
    files: sortedFiles.map(f => ({
      module: f.module,
      verdict: f.verdict,
      diagnostics: f.diagnostics.map(d => ({ code: d.code, property: d.property })),
      machines: f.machines.map(m => ({
        machine: m.machine,
        verdict: m.verdict,
        instance: normalizeInstance(m.instance),
        diagnostics: m.diagnostics.map(d => ({ code: d.code, property: d.property }))
      })),
      configurations: f.configurations.map(c => ({
        configuration: c.configuration,
        verdict: c.verdict,
        instance: normalizeInstance(c.instance),
        diagnostics: c.diagnostics.map(d => ({ code: d.code, property: d.property }))
      }))
    }))
  };
}

test('DF27 item 3, DAC31: two files through scripts/test-run.mjs share one admission', async (t) => {
  // Create temporary scripts that both admit the demo source in one run.
  const tmpDir = mkdtempSync(join(tmpdir(), 'admission-run-script-'));
  try {
    const fileAPath = join(tmpDir, 'a-file.test.mjs');
    const fileBPath = join(tmpDir, 'b-file.test.mjs');
    const outDirA = join(tmpDir, 'out-a');
    const outDirB = join(tmpDir, 'out-b');
    const outFileA = join(outDirA, 'result.json');
    const outFileB = join(outDirB, 'result.json');

    // Write file A: admits the demo and writes its pid, run, count, shared flag and report.
    const fileA = `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as A from ${JSON.stringify(pathToFileURL(join(ROOT, 'demo', 'host', 'admission.mjs')).href)};

const workdir = ${JSON.stringify(join(tmpDir, 'workdir-a'))};
const source = ${JSON.stringify(DEMO_SOURCE)};

mkdirSync(${JSON.stringify(outDirA)}, { recursive: true });

try {
  const result = await A.admitDemoConcierge({ source, workdir });
  writeFileSync(${JSON.stringify(outFileA)}, JSON.stringify({
    pid: process.pid,
    run: process.env.POLY_TEST_RUN,
    count: A.admissionCount(),
    shared: result.shared,
    report: result.report
  }));
} catch (e) {
  writeFileSync(${JSON.stringify(outFileA)}, JSON.stringify({
    error: String(e),
    message: e.message
  }));
}
`;
    writeFileSync(fileAPath, fileA);

    // Write file B: admits the same demo source.
    const fileB = `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as A from ${JSON.stringify(pathToFileURL(join(ROOT, 'demo', 'host', 'admission.mjs')).href)};

const workdir = ${JSON.stringify(join(tmpDir, 'workdir-b'))};
const source = ${JSON.stringify(DEMO_SOURCE)};

mkdirSync(${JSON.stringify(outDirB)}, { recursive: true });

try {
  const result = await A.admitDemoConcierge({ source, workdir });
  writeFileSync(${JSON.stringify(outFileB)}, JSON.stringify({
    pid: process.pid,
    run: process.env.POLY_TEST_RUN,
    count: A.admissionCount(),
    shared: result.shared,
    report: result.report
  }));
} catch (e) {
  writeFileSync(${JSON.stringify(outFileB)}, JSON.stringify({
    error: String(e),
    message: e.message
  }));
}
`;
    writeFileSync(fileBPath, fileB);

    // Run both files through scripts/test-run.mjs in one command.
    // Both files are arguments to the same node --test invocation, so they share POLY_TEST_RUN.
    const result = spawnSync(process.execPath, [
      'scripts/test-run.mjs',
      'node',
      '--import', './test/fixtures/home-guard.mjs',
      '--test',
      '--env-file=test/fixtures/serial-heap.env',
      '--test-concurrency=1',
      fileAPath,
      fileBPath
    ], {
      cwd: ROOT,
      env: (() => {
        const e = { ...process.env };
        delete e.POLY_TEST_RUN;
        delete e.POLY_DEMO_ADMISSION;
        return e;
      })(),
      encoding: 'utf8',
      timeout: 1_800_000 // 30 minutes for both admissions
    });

    // Read results first, before asserting exit status (so errors are visible).
    assert.ok(existsSync(outFileA), 'file A created output');
    assert.ok(existsSync(outFileB), 'file B created output');

    const outA = JSON.parse(readFileSync(outFileA, 'utf8'));
    const outB = JSON.parse(readFileSync(outFileB, 'utf8'));

    assert.ok(!outA.error, `file A error: ${outA.message}`);
    assert.ok(!outB.error, `file B error: ${outB.message}`);

    assert.equal(result.status, 0, `both files exited successfully, stderr: ${result.stderr}`);

    // Both files have the same run id (from the single scripts/test-run.mjs invocation).
    assert.equal(outA.run, outB.run, 'both files have the same run id');

    // Both are in separate processes (different pids).
    assert.notEqual(outA.pid, outB.pid, 'files run in separate processes');

    // First file to acquire the lock makes the admission (count=1), second reads stored (count=0).
    // Spec item 5 says within one process calls wait on one admission; across processes
    // the first rename wins. So one process admits (count=1), the other uses the store (count=0).
    const countFirst = Math.max(outA.count, outB.count);
    const countSecond = Math.min(outA.count, outB.count);
    assert.equal(countFirst, 1, 'first process makes one real admission');
    assert.equal(countSecond, 0, 'second process uses the stored admission, makes none');

    // Verify reports are the same.
    const normA = normalizeReport(outA.report, join(tmpDir, 'workdir-a'));
    const normB = normalizeReport(outB.report, join(tmpDir, 'workdir-b'));
    assert.deepEqual(normA, normB, 'both files get the same report');

    // Check the script's output line format (DF27 item 11): poly-demo-admissions: run <id>, <n> admissions
    const expectedLine = `poly-demo-admissions: run ${outA.run}, 1 admissions`;
    assert.match(result.stdout, new RegExp(expectedLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'script prints run completion line with id and count');

    // Check that the run folder is cleaned up after the script ends.
    const S = await import('../demo/host/admission-store.mjs');
    const runFolderPath = join(S.storeRoot(), outA.run);
    assert.ok(!existsSync(runFolderPath), 'run folder is removed after script ends');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DF27 item 3: two files by hand (without scripts/test-run.mjs) each make separate admissions', async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'admission-run-hand-'));
  try {
    const fileAPath = join(tmpDir, 'a-hand.test.mjs');
    const fileBPath = join(tmpDir, 'b-hand.test.mjs');
    const outDirA = join(tmpDir, 'out-a');
    const outDirB = join(tmpDir, 'out-b');
    const outFileA = join(outDirA, 'result.json');
    const outFileB = join(outDirB, 'result.json');

    // Write file A.
    const fileA = `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as A from ${JSON.stringify(pathToFileURL(join(ROOT, 'demo', 'host', 'admission.mjs')).href)};

const workdir = ${JSON.stringify(join(tmpDir, 'workdir-a'))};
const source = ${JSON.stringify(DEMO_SOURCE)};

mkdirSync(${JSON.stringify(outDirA)}, { recursive: true });

try {
  const result = await A.admitDemoConcierge({ source, workdir });
  writeFileSync(${JSON.stringify(outFileA)}, JSON.stringify({
    pid: process.pid,
    run: process.env.POLY_TEST_RUN,
    count: A.admissionCount(),
    shared: result.shared
  }));
} catch (e) {
  writeFileSync(${JSON.stringify(outFileA)}, JSON.stringify({
    error: String(e)
  }));
}
`;
    writeFileSync(fileAPath, fileA);

    // Write file B.
    const fileB = `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as A from ${JSON.stringify(pathToFileURL(join(ROOT, 'demo', 'host', 'admission.mjs')).href)};

const workdir = ${JSON.stringify(join(tmpDir, 'workdir-b'))};
const source = ${JSON.stringify(DEMO_SOURCE)};

mkdirSync(${JSON.stringify(outDirB)}, { recursive: true });

try {
  const result = await A.admitDemoConcierge({ source, workdir });
  writeFileSync(${JSON.stringify(outFileB)}, JSON.stringify({
    pid: process.pid,
    run: process.env.POLY_TEST_RUN,
    count: A.admissionCount(),
    shared: result.shared
  }));
} catch (e) {
  writeFileSync(${JSON.stringify(outFileB)}, JSON.stringify({
    error: String(e)
  }));
}
`;
    writeFileSync(fileBPath, fileB);

    // Run both files by hand (plain node --test, no scripts/test-run.mjs).
    // Remove POLY_TEST_RUN so each process sets its own (preload uses ??=).
    const env = { ...process.env };
    delete env.POLY_TEST_RUN;
    delete env.POLY_DEMO_ADMISSION;

    const result = spawnSync(process.execPath, [
      '--import', './test/fixtures/home-guard.mjs',
      '--test',
      '--env-file=test/fixtures/serial-heap.env',
      '--test-concurrency=1',
      fileAPath,
      fileBPath
    ], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 1_800_000 // 30 minutes
    });

    assert.ok(existsSync(outFileA), 'file A created output');
    assert.ok(existsSync(outFileB), 'file B created output');

    const outA = JSON.parse(readFileSync(outFileA, 'utf8'));
    const outB = JSON.parse(readFileSync(outFileB, 'utf8'));

    assert.ok(!outA.error, `file A error: ${outA.error}`);
    assert.ok(!outB.error, `file B error: ${outB.error}`);

    assert.equal(result.status, 0, `files exited successfully, stderr: ${result.stderr}`);

    // Each process sets its own run id (preload uses ??=).
    assert.notEqual(outA.run, outB.run, 'each file has a different run id');

    // Each makes its own admission (no sharing across processes).
    assert.equal(outA.count, 1, 'file A makes one admission');
    assert.equal(outB.count, 1, 'file B makes one admission (separate process, no sharing)');

    // Clean up the run folders created by hand (nothing else removes them).
    const S = await import('../demo/host/admission-store.mjs');
    const runA = join(S.storeRoot(), outA.run);
    const runB = join(S.storeRoot(), outB.run);
    rmSync(runA, { recursive: true, force: true });
    rmSync(runB, { recursive: true, force: true });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
