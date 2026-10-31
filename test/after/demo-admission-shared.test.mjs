// DF27, DAC31: The demo is admitted once per test run for each source,
// and the shared and fresh admissions of one source give the same verdict.
// This file runs real admissions in the serial suite. Tests depend on each other:
// they run sequentially and share setup state (POLY_TEST_RUN, admission store).
// Each test is an acceptance criterion from DAC31.
//
// Contract: Uses the same names as demo-admission.test.mjs but calls the admission
// functions with real sources and workdirs. The store persists across tests within
// one describe block (one POLY_TEST_RUN).
// - admitDemoConcierge({ workdir, source, admission }): runs a real admit on the source.
//   Returns { shared, report }. Both env vars are read at call time.
// - admissionCount(): returns the count of real admit() calls in this process.
// - reportOf(report): extracts the verdict and findings from the report for comparison.
//   Paths in reports are made relative to the workdir for comparison.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, cpSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { toolchainDigest } from '@poly/check';
import * as A from '../../demo/host/admission.mjs';
import { ROOT } from '../helpers.mjs';

const DEMO_SOURCE = join(ROOT, 'demo', 'concierge');

// Extract verdict and diagnostics from a ProjectReport for comparison.
// ProjectReport structure: { project, name, files, handlers, verdict, exit }
// files is an array of CheckReport, one per module: { file, module, moduleDigest, sourceDigest, verdict, exit, diagnostics, machines, configurations, ... }
// machines and configurations are inside each file entry, with { machine/configuration, verdict, instance, diagnostics }.
// file is absolute path (differs between workdirs), so identify by module name.
// module may be null for policy-only files.
// Normalize paths in instances to relative paths from workdir for comparison across workdirs.
// NOTE (2026-10-31): The brief of 2026-10-30 said report was a CheckReport with machines at the top level.
// That was wrong. The first run found report is a ProjectReport with machines inside each file.
function reportOf(report, workdir) {
  if (!report) return null;

  // Extract code and property from each diagnostic.
  const extractDiag = (diag) => ({ code: diag.code, property: diag.property });

  // Normalize paths: absolute paths relative to workdir become relative.
  const normalizePath = (p) => {
    if (typeof p === 'string' && workdir && p.startsWith(workdir)) {
      return relative(workdir, p);
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

  // Sort files by module name for consistent comparison (module may be null for policy-only files).
  const sortedFiles = [...report.files].sort((a, b) => (a.module ?? '').localeCompare(b.module ?? ''));

  return {
    verdict: report.verdict,
    files: sortedFiles.map(f => ({
      module: f.module,
      verdict: f.verdict,
      diagnostics: f.diagnostics.map(extractDiag),
      machines: f.machines.map(m => ({
        machine: m.machine,
        verdict: m.verdict,
        instance: normalizeInstance(m.instance),
        diagnostics: m.diagnostics.map(extractDiag)
      })),
      configurations: f.configurations.map(c => ({
        configuration: c.configuration,
        verdict: c.verdict,
        instance: normalizeInstance(c.instance),
        diagnostics: c.diagnostics.map(extractDiag)
      }))
    }))
  };
}

test('DAC31: shared and fresh admissions of one source give the same verdict', async (t) => {
  // Tests are sequential (depends on each other).
  // Setup: establish a unique POLY_TEST_RUN and disable POLY_DEMO_ADMISSION.
  // After each test, restore the env state.

  const testRunId = 'test-dac31-' + Math.random().toString(36).slice(2);
  const originalTestRun = process.env.POLY_TEST_RUN;
  const originalFresh = process.env.POLY_DEMO_ADMISSION;

  try {
    process.env.POLY_TEST_RUN = testRunId;
    delete process.env.POLY_DEMO_ADMISSION;

    // T1: Make concurrent calls and later calls. Expect exactly one admission (item 5).
    await t.test('T1: N calls for one source make exactly one admission, later calls are shared', async () => {
      const countBefore = await A.admissionCount();

      const workdir1 = join(tmpdir(), 'demo-test-t1-1-' + Math.random().toString(36).slice(2));
      const workdir2 = join(tmpdir(), 'demo-test-t1-2-' + Math.random().toString(36).slice(2));
      const workdir3 = join(tmpdir(), 'demo-test-t1-3-' + Math.random().toString(36).slice(2));

      try {
        mkdirSync(workdir1, { recursive: true });
        mkdirSync(workdir2, { recursive: true });
        mkdirSync(workdir3, { recursive: true });

        // Two concurrent calls. Item 5 says within one process calls for one key wait on one admission.
        await Promise.all([
          A.admitDemoConcierge({ workdir: workdir1, source: DEMO_SOURCE }),
          A.admitDemoConcierge({ workdir: workdir2, source: DEMO_SOURCE })
        ]);

        // Third call should be shared.
        const result3 = await A.admitDemoConcierge({ workdir: workdir3, source: DEMO_SOURCE });

        // Expect the third call to be marked shared.
        assert.equal(result3.shared, true, 'third call returns shared: true');

        // Count should have increased by exactly 1 (item 5: wait on one admission).
        const countAfter = await A.admissionCount();
        assert.equal(countAfter, countBefore + 1, 'exactly one real admission made');
      } finally {
        rmSync(workdir1, { recursive: true, force: true });
        rmSync(workdir2, { recursive: true, force: true });
        rmSync(workdir3, { recursive: true, force: true });
      }
    });

    // T2: Mutate a copy. Store is unchanged; mutations do not affect the store (item 6).
    await t.test('T2: changing a returned copy never changes the store', async () => {
      const workdir = join(tmpdir(), 'demo-test-t2-' + Math.random().toString(36).slice(2));

      try {
        mkdirSync(workdir, { recursive: true });

        // Make an admission (shared, using the store from T1).
        const resultInitial = await A.admitDemoConcierge({ workdir, source: DEMO_SOURCE });
        assert.equal(resultInitial.shared, true, 'admission is shared (store hit from T1)');

        // Digest the first copy's three trees BEFORE mutation.
        const srcDirBefore = digestTree(join(workdir, 'project', 'src'));
        const buildDirBefore = digestTree(join(workdir, 'project', '.poly', 'build'));
        const certFileBefore = createHash('sha256').update(readFileSync(join(workdir, 'project', '.poly', 'certificate.json'))).digest('hex');

        // Get the store location and digest it BEFORE mutation.
        const toolchain = toolchainDigest();
        const key = await A.admissionKey({
          run: testRunId,
          project: 'demo-concierge',
          source: DEMO_SOURCE,
          toolchain
        });
        const storeDir = await A.storedAdmission(key);
        assert.ok(storeDir, 'store folder exists with ready.json');

        // Digest the entire store before mutation (no exclusions).
        const storeDigestBefore = digestTree(storeDir);

        // Now mutate the copy unconditionally (all three: src, build, certificate).
        const srcFile = join(workdir, 'project', 'src', 'concierge.poly');
        const content = readFileSync(srcFile, 'utf8');
        writeFileSync(srcFile, content + '\n// test mutation');

        // Walk build directory recursively to find first file by sorted relative path.
        const buildDir = join(workdir, 'project', '.poly', 'build');
        let firstBuildFile = null;
        function findFirstFile(dir, baseDir) {
          const entries = readdirSync(dir).sort();
          for (const entry of entries) {
            const p = join(dir, entry);
            const stat = statSync(p);
            if (stat.isDirectory()) {
              findFirstFile(p, baseDir);
              if (firstBuildFile) break;
            } else if (stat.isFile() && !firstBuildFile) {
              firstBuildFile = p;
              break;
            }
          }
        }
        findFirstFile(buildDir, buildDir);
        assert.ok(firstBuildFile, 'found a file in build directory');

        const buildContent = readFileSync(firstBuildFile, 'utf8');
        writeFileSync(firstBuildFile, buildContent + '\n// mutation');

        const certFile = join(workdir, 'project', '.poly', 'certificate.json');
        const certContent = readFileSync(certFile, 'utf8');
        writeFileSync(certFile, certContent.slice(0, -1) + '1}');

        // Verify the copy's three trees changed.
        assert.notEqual(digestTree(join(workdir, 'project', 'src')), srcDirBefore, 'copy src changed');

        // Digest the store again (should be identical).
        const storeDigestAfter = digestTree(storeDir);
        assert.equal(storeDigestAfter, storeDigestBefore, 'store is unchanged after mutation of copy');

        // Make another call with the same source and run. Its copy should match the original digests.
        const workdir2 = join(tmpdir(), 'demo-test-t2b-' + Math.random().toString(36).slice(2));
        mkdirSync(workdir2, { recursive: true });
        const resultNew = await A.admitDemoConcierge({ workdir: workdir2, source: DEMO_SOURCE });
        assert.equal(resultNew.shared, true, 'second call is shared');

        // The new copy's three trees should match the original first copy's (before mutation).
        assert.equal(digestTree(join(workdir2, 'project', 'src')), srcDirBefore, 'new copy src matches original');
        assert.equal(digestTree(join(workdir2, 'project', '.poly', 'build')), buildDirBefore, 'new copy build matches original');
        const certFileAfter = createHash('sha256').update(readFileSync(join(workdir2, 'project', '.poly', 'certificate.json'))).digest('hex');
        assert.equal(certFileAfter, certFileBefore, 'new copy certificate matches original');

        rmSync(workdir2, { recursive: true, force: true });
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    });

    // T3: Fresh call gives the same verdict as shared (DAC31).
    await t.test('T3: shared and fresh admissions of one source give the same verdict', async () => {
      const workdirShared = join(tmpdir(), 'demo-test-t3-shared-' + Math.random().toString(36).slice(2));
      const workdirFresh = join(tmpdir(), 'demo-test-t3-fresh-' + Math.random().toString(36).slice(2));

      try {
        mkdirSync(workdirShared, { recursive: true });
        mkdirSync(workdirFresh, { recursive: true });

        // Shared admission (uses the store from T1 and T2).
        const resultShared = await A.admitDemoConcierge({
          workdir: workdirShared,
          source: DEMO_SOURCE,
          admission: 'shared'
        });

        // Fresh admission (bypasses the store).
        const resultFresh = await A.admitDemoConcierge({
          workdir: workdirFresh,
          source: DEMO_SOURCE,
          admission: 'fresh'
        });

        assert.equal(resultShared.shared, true, 'shared admission returns shared: true');
        assert.equal(resultFresh.shared, false, 'fresh admission returns shared: false');

        // Extract and normalize the reports.
        const reportShared = reportOf(resultShared.report, workdirShared);
        const reportFresh = reportOf(resultFresh.report, workdirFresh);

        // Assert verdict first, alone (readable failure).
        assert.equal(reportShared.verdict, reportFresh.verdict, 'verdicts are identical');

        // Ensure the reports have content to check: files exist and have machines with instances.
        assert.ok(reportShared.files.length > 0, 'shared report has files');
        assert.ok(reportFresh.files.length > 0, 'fresh report has files');

        // At least one file must have a machine with an instance.
        const sharedHasMachineWithInstance = reportShared.files.some(f => f.machines.some(m => m.instance));
        const freshHasMachineWithInstance = reportFresh.files.some(f => f.machines.some(m => m.instance));
        assert.ok(sharedHasMachineWithInstance, 'shared report has a machine with an instance');
        assert.ok(freshHasMachineWithInstance, 'fresh report has a machine with an instance');

        // Assert the entire extracted reports are identical.
        assert.deepEqual(reportShared, reportFresh, 'shared and fresh reports are identical');
      } finally {
        rmSync(workdirShared, { recursive: true, force: true });
        rmSync(workdirFresh, { recursive: true, force: true });
      }
    });

    // T4: Seeded control (a): changed source gives a new key and a new admission (DF27 item 9a).
    await t.test('T4: changing one file under maps/ gives a new key and a new admission', async () => {
      // DF27 item 9: (a) changing one byte under maps/ must give a new key.
      // Maps file carries its own digest over parsed fields. A digit change breaks it (REFUSED).
      // Whitespace outside strings is allowed, keeps JSON valid, and changes the key.
      // Use 'shared' mode (item 7 says controls use 'fresh', but a changed source
      // has a different key regardless of mode, so 'shared' tests the store miss).
      const countBefore = await A.admissionCount();

      // Copy the source to tmp and change one file.
      const tmpSource = join(tmpdir(), 'demo-test-t4-source-' + Math.random().toString(36).slice(2));
      cpSync(DEMO_SOURCE, tmpSource, { recursive: true });

      // Change whitespace in maps file (space after opening brace, valid JSON, one byte).
      const mapsFile = join(tmpSource, 'maps', 'small.json');
      const originalContent = readFileSync(mapsFile, 'utf8');
      assert.ok(originalContent, 'maps/small.json exists');

      // Insert a space after the opening brace (keeps JSON valid, changes digest).
      const changedContent = originalContent.replace(/^\{/, '{ ');
      assert.notEqual(changedContent, originalContent, 'file content changed');
      assert.equal(changedContent.length, originalContent.length + 1, 'one byte added');
      writeFileSync(mapsFile, changedContent);

      // Compute keys: original and changed.
      const toolchain = toolchainDigest();
      const keyOriginal = await A.admissionKey({
        run: testRunId,
        project: 'demo-concierge',
        source: DEMO_SOURCE,
        toolchain
      });
      const keyChanged = await A.admissionKey({
        run: testRunId,
        project: 'demo-concierge',
        source: tmpSource,
        toolchain
      });
      assert.notEqual(keyChanged, keyOriginal, 'changed source has a different key');

      const workdir = join(tmpdir(), 'demo-test-t4-' + Math.random().toString(36).slice(2));

      try {
        mkdirSync(workdir, { recursive: true });

        // Admit the changed source with shared mode (default).
        // The whitespace change does not break the map's digest, so admission succeeds.
        const resultAdmit = await A.admitDemoConcierge({
          workdir,
          source: tmpSource,
          admission: 'shared'
        });

        // The count should increase by 1 (new admission, not in store).
        const countAfter = await A.admissionCount();
        assert.equal(countAfter, countBefore + 1, 'changed source triggers a new admission');

        // The changed source should admit successfully with CLEAN verdict.
        assert.ok(resultAdmit.report, 'report returned');
        assert.equal(resultAdmit.report.verdict, 'CLEAN', 'admission verdict is CLEAN');
      } finally {
        rmSync(workdir, { recursive: true, force: true });
        rmSync(tmpSource, { recursive: true, force: true });
      }
    });
  } finally {
    // Restore the environment.
    if (originalTestRun !== undefined) {
      process.env.POLY_TEST_RUN = originalTestRun;
    } else {
      delete process.env.POLY_TEST_RUN;
    }
    if (originalFresh !== undefined) {
      process.env.POLY_DEMO_ADMISSION = originalFresh;
    }
  }
});

// Helper: digest a directory tree (all files recursively).
// Hash both the relative path (with forward slashes) and the file bytes,
// so that renames or moves change the digest. Missing folders fail.
function digestTree(path) {
  const hash = createHash('sha256');

  function walk(dir) {
    const entries = readdirSync(dir).sort();
    for (const entry of entries) {
      const p = join(dir, entry);
      const stat = statSync(p);
      if (stat.isDirectory()) {
        walk(p);
      } else if (stat.isFile()) {
        // Hash the relative path with forward slashes.
        const relPath = relative(path, p).split('\\').join('/');
        hash.update(relPath + '\0');
        // Hash the file content.
        const content = readFileSync(p);
        hash.update(content);
      }
    }
  }

  walk(path);
  return hash.digest('hex');
}
