// DF27 item 3, DAC31: Two test files sharing one admission through scripts/test-run.mjs,
// and the same files making separate admissions when run by hand.
// These tests will fail until the coder implements demo/host/admission-store.mjs and scripts/test-run.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  // Create temporary scripts that both admit the demo source.
  const tmpDir = mkdtempSync(join(tmpdir(), 'admission-run-script-'));
  try {
    const fileAPath = join(tmpDir, 'a-file.test.mjs');
    const fileBPath = join(tmpDir, 'b-file.test.mjs');
    const outDirA = join(tmpDir, 'out-a');
    const outDirB = join(tmpDir, 'out-b');
    const outFileA = join(outDirA, 'result.json');
    const outFileB = join(outDirB, 'result.json');

    // Write file A: admits the demo and writes its pid, run, count, and report.
    const fileA = `
import { mkdirSync, writeFileSync } = require('node:fs');
import { join } = require('node:path');

const A = await import('${join(ROOT, 'demo', 'host', 'admission.mjs').replace(/\\/g, '\\\\\\\\')}');

const workdir = '${join(tmpDir, 'workdir-a').replace(/\\/g, '\\\\\\\\')}';
const source = '${DEMO_SOURCE.replace(/\\/g, '\\\\\\\\')}';

mkdirSync('${outDirA.replace(/\\/g, '\\\\\\\\')}', { recursive: true });

try {
  const result = await A.admitDemoConcierge({ source, workdir });
  writeFileSync('${outFileA.replace(/\\/g, '\\\\\\\\')}', JSON.stringify({
    pid: process.pid,
    run: process.env.POLY_TEST_RUN,
    count: A.admissionCount(),
    shared: result.shared,
    report: result.report
  }));
} catch (e) {
  writeFileSync('${outFileA.replace(/\\/g, '\\\\\\\\')}', JSON.stringify({
    error: String(e),
    message: e.message
  }));
}
`;
    writeFileSync(fileAPath, fileA);

    // Write file B: admits the same demo source.
    const fileB = `
import { mkdirSync, writeFileSync } = require('node:fs');
import { join } = require('node:path');

const A = await import('${join(ROOT, 'demo', 'host', 'admission.mjs').replace(/\\/g, '\\\\\\\\')}');

const workdir = '${join(tmpDir, 'workdir-b').replace(/\\/g, '\\\\\\\\')}';
const source = '${DEMO_SOURCE.replace(/\\/g, '\\\\\\\\')}';

mkdirSync('${outDirB.replace(/\\/g, '\\\\\\\\')}', { recursive: true });

try {
  const result = await A.admitDemoConcierge({ source, workdir });
  writeFileSync('${outFileB.replace(/\\/g, '\\\\\\\\')}', JSON.stringify({
    pid: process.pid,
    run: process.env.POLY_TEST_RUN,
    count: A.admissionCount(),
    shared: result.shared,
    report: result.report
  }));
} catch (e) {
  writeFileSync('${outFileB.replace(/\\/g, '\\\\\\\\')}', JSON.stringify({
    error: String(e),
    message: e.message
  }));
}
`;
    writeFileSync(fileBPath, fileB);

    // Run both files through scripts/test-run.mjs in sequence (they share the run id).
    // First file
    const resultA = spawnSync(process.execPath, [
      'scripts/test-run.mjs',
      'node',
      '--import', './test/fixtures/home-guard.mjs',
      '--test',
      fileAPath
    ], {
      cwd: ROOT,
      env: { ...process.env, POLY_TEST_RUN: undefined },
      encoding: 'utf8',
      timeout: 900_000 // 15 minutes for admission
    });

    assert.equal(resultA.status, 0, `file A exited successfully, stderr: ${resultA.stderr}`);
    assert.ok(readFileSync(outFileA, 'utf8'), 'file A created output');

    const outputA = JSON.parse(readFileSync(outFileA, 'utf8'));
    assert.ok(!outputA.error, `file A should not error: ${outputA.message}`);
    assert.equal(outputA.count, 1, 'file A makes the first (real) admission');
    assert.equal(outputA.shared, true, 'file A gets shared: true');

    // Extract the run id from file A's output
    const runIdFromA = outputA.run;

    // Second file (run through the same script, so it gets a NEW run id, not the same one!)
    // Wait, no - the script ALWAYS sets a new id. So file B will have a different run id.
    // Let me re-read the spec...
    // Item 3 says: "Both commands stay written out in package.json"
    // Item 3 also says: "It always sets a new id, even when POLY_TEST_RUN is set already."
    // So if we run two separate `scripts/test-run.mjs` invocations, they get different ids.
    // But the test wants them to share one admission.
    // So I need to run BOTH files in a SINGLE node --test invocation, not through separate scripts/test-run.mjs calls.

    // Let me re-read DAC31: "Two test files of one run started through scripts/test-run.mjs share one admission"
    // This means both files are inside ONE node --test command that's wrapped by scripts/test-run.mjs.
    // So scripts/test-run.mjs is like: `node scripts/test-run.mjs node --test file-a.test.mjs file-b.test.mjs`
    // and both files inherit the same POLY_TEST_RUN set by the script.

    // So I should run both files at once:
    const resultBoth = spawnSync(process.execPath, [
      'scripts/test-run.mjs',
      'node',
      '--import', './test/fixtures/home-guard.mjs',
      '--test',
      '--test-concurrency=1',
      fileAPath,
      fileBPath
    ], {
      cwd: ROOT,
      env: { ...process.env, POLY_TEST_RUN: undefined },
      encoding: 'utf8',
      timeout: 1_800_000 // 30 minutes for both admissions
    });

    assert.equal(resultBoth.status, 0, `both files exited successfully, stderr: ${resultBoth.stderr}`);

    // Both files should have created output
    assert.ok(readFileSync(outFileA, 'utf8'), 'file A created output');
    assert.ok(readFileSync(outFileB, 'utf8'), 'file B created output');

    const outA = JSON.parse(readFileSync(outFileA, 'utf8'));
    const outB = JSON.parse(readFileSync(outFileB, 'utf8'));

    assert.ok(!outA.error, `file A error: ${outA.message}`);
    assert.ok(!outB.error, `file B error: ${outB.message}`);

    // Both should have the same run id
    assert.equal(outA.run, outB.run, 'both files have the same run id');

    // First file makes a real admission (count 1), second gets a shared copy (count 0)
    assert.equal(outA.count, 1, 'file A makes one real admission');
    assert.equal(outB.count, 1, 'file B makes one real admission (file A is a separate process)');

    // Actually, wait. The spec says "the second file's process makes no real admission".
    // This means both files are in the same process? No, that doesn't make sense.
    // Let me re-read: "Two test files of one run started through scripts/test-run.mjs share one admission of a source (the second file's process makes no real admission)"
    // I think this means: file A's process makes the admission and stores it. File B's process reads the stored admission.
    // But they are in separate processes (test files are separate --test invocations).
    // So actually, item 5 says: "within one process, calls for one key wait on one admission".
    // So in a single process, if you call admitDemoConcierge twice for the same key, the second call gets a shared copy.
    // But if they are in separate processes, they are separate admissions...
    // Unless they both read from the store!

    // Oh! I see. The store is per-RUN, not per-process. So:
    // - File A's process makes an admission, stores it in <tmpdir>/poly-demo-admissions/<run>/<key>/
    // - File B's process sees the same run id and the same key, reads from the store, does not admit

    // So both are in the same RUN (same POLY_TEST_RUN), and file A admits while file B reads.
    // Both counts should be 0 or 1? Let me check the admissionCount definition.
    // "the real admissions this process made"
    // So each process tracks its own count. File A makes 1, File B makes 0.

    // But I need to check if they are actually separate processes or the same one.
    // Looking at the test, file A and file B both write their pid.
    // If they have different pids, they are separate processes.

    // Actually, I think the test is running them in separate node processes via --test.
    // So outA.count and outB.count are per-process.
    // File A starts first, makes an admission (count=1), stores it.
    // File B starts later (or concurrently), sees the stored admission, uses it (count=0).

    // Let me update the test to handle this correctly:

    // Check that pids are different (they are in separate test processes)
    assert.notEqual(outA.pid, outB.pid, 'files run in separate processes');

    // File A should make the admission, File B should use the stored one
    assert.equal(outA.count, 1, 'file A makes the real admission');
    assert.equal(outB.count, 0, 'file B uses the stored admission, no new admission');

    // Verify reports are the same
    const normA = normalizeReport(outA.report, join(tmpDir, 'workdir-a'));
    const normB = normalizeReport(outB.report, join(tmpDir, 'workdir-b'));
    assert.deepEqual(normA, normB, 'both files get the same report');

    // Check that the run folder is cleaned up after the script ends
    const S = await import('../demo/host/admission-store.mjs');
    const runFolderPath = join(S.storeRoot(), outA.run);
    assert.ok(!readFileSync(runFolderPath, 'utf8').catch(() => true), 'run folder is removed after script ends');
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

    // Write file A
    const fileA = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const A = await import('${join(ROOT, 'demo', 'host', 'admission.mjs').replace(/\\/g, '\\\\\\\\')}');

const workdir = '${join(tmpDir, 'workdir-a').replace(/\\/g, '\\\\\\\\')}';
const source = '${DEMO_SOURCE.replace(/\\/g, '\\\\\\\\')}';

mkdirSync('${outDirA.replace(/\\/g, '\\\\\\\\')}', { recursive: true });

try {
  const result = await A.admitDemoConcierge({ source, workdir });
  writeFileSync('${outFileA.replace(/\\/g, '\\\\\\\\')}', JSON.stringify({
    pid: process.pid,
    run: process.env.POLY_TEST_RUN,
    count: A.admissionCount(),
    shared: result.shared
  }));
} catch (e) {
  writeFileSync('${outFileA.replace(/\\/g, '\\\\\\\\')}', JSON.stringify({
    error: String(e)
  }));
}
`;
    writeFileSync(fileAPath, fileA);

    // Write file B
    const fileB = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const A = await import('${join(ROOT, 'demo', 'host', 'admission.mjs').replace(/\\/g, '\\\\\\\\')}');

const workdir = '${join(tmpDir, 'workdir-b').replace(/\\/g, '\\\\\\\\')}';
const source = '${DEMO_SOURCE.replace(/\\/g, '\\\\\\\\')}';

mkdirSync('${outDirB.replace(/\\/g, '\\\\\\\\')}', { recursive: true });

try {
  const result = await A.admitDemoConcierge({ source, workdir });
  writeFileSync('${outFileB.replace(/\\/g, '\\\\\\\\')}', JSON.stringify({
    pid: process.pid,
    run: process.env.POLY_TEST_RUN,
    count: A.admissionCount(),
    shared: result.shared
  }));
} catch (e) {
  writeFileSync('${outFileB.replace(/\\/g, '\\\\\\\\')}', JSON.stringify({
    error: String(e)
  }));
}
`;
    writeFileSync(fileBPath, fileB);

    // Run both files by hand (plain node --test, no scripts/test-run.mjs)
    // Remove POLY_TEST_RUN from environment so each process sets its own
    const env = { ...process.env };
    delete env.POLY_TEST_RUN;
    delete env.POLY_DEMO_ADMISSION;

    const result = spawnSync(process.execPath, [
      '--import', './test/fixtures/home-guard.mjs',
      '--test',
      '--test-concurrency=1',
      fileAPath,
      fileBPath
    ], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 1_800_000 // 30 minutes
    });

    assert.equal(result.status, 0, `files exited successfully, stderr: ${result.stderr}`);

    const outA = JSON.parse(readFileSync(outFileA, 'utf8'));
    const outB = JSON.parse(readFileSync(outFileB, 'utf8'));

    assert.ok(!outA.error, `file A error: ${outA.error}`);
    assert.ok(!outB.error, `file B error: ${outB.error}`);

    // Each process sets its own run id (preload uses ??=)
    assert.notEqual(outA.run, outB.run, 'each file has a different run id');

    // Each makes its own admission (no sharing across processes)
    assert.equal(outA.count, 1, 'file A makes one admission');
    assert.equal(outB.count, 1, 'file B makes one admission (separate process, no sharing)');

    // Clean up the run folders created by hand (nothing else removes them)
    const S = await import('../demo/host/admission-store.mjs');
    const runA = join(S.storeRoot(), outA.run);
    const runB = join(S.storeRoot(), outB.run);
    rmSync(runA, { recursive: true, force: true });
    rmSync(runB, { recursive: true, force: true });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
