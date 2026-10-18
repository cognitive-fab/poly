// DB16: poly workspace includes model folder, smoke test runs runtime check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, copyFileSync, symlinkSync, statSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { makeWorkspace, scaffoldDigest, treeDigest, listFiles } from '../demo/baseline/arms.mjs';
import { smokeTest } from '../demo/baseline/smoke.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// Helper: get amendment 1 scaffolds from committed record
function getAmendment1Scaffolds() {
  const output = execSync('git show 1b9493fc:demo/baseline/PREREGISTRATION.amendment-1.json', { cwd: ROOT, encoding: 'utf8' });
  const amendment = JSON.parse(output);
  return amendment.set.scaffolds;
}

// Helper: walk directory recursively and return sorted relative paths using /
function walkDirectory(dir) {
  const paths = [];
  function walk(subdir, prefix) {
    const entries = readdirSync(subdir);
    for (const entry of entries) {
      const fullPath = join(subdir, entry);
      const relPath = prefix ? `${prefix}/${entry}` : entry;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath, relPath);
      } else {
        paths.push(relPath);
      }
    }
  }
  walk(dir, '');
  return paths.map(p => p.replace(/\\/g, '/')).sort();
}

// ---- DB16.1: poly workspace holds model folder with outbox-intent.poly and MANIFEST.json -------

test('DB16.1: makeWorkspace("poly", tmpdir) creates .harness/poly-runtime/model with outbox-intent.poly and build/MANIFEST.json', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ws-poly-model-'));
  try {
    makeWorkspace('poly', tmp, ROOT);
    const files = listFiles(tmp);
    assert.ok(files.includes('.harness/poly-runtime/model/outbox-intent.poly'), 'includes .harness/poly-runtime/model/outbox-intent.poly');
    assert.ok(files.includes('.harness/poly-runtime/model/build/MANIFEST.json'), 'includes .harness/poly-runtime/model/build/MANIFEST.json');
    assert.ok(existsSync(join(tmp, '.harness/poly-runtime/model/outbox-intent.poly')), 'outbox-intent.poly file exists');
    assert.ok(existsSync(join(tmp, '.harness/poly-runtime/model/build/MANIFEST.json')), 'MANIFEST.json file exists');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('DB16.1: every file under packages/poly-runtime/model is in poly workspace .harness/poly-runtime/model byte for byte', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ws-poly-model-bytes-'));
  try {
    makeWorkspace('poly', tmp, ROOT);
    const sourceBase = join(ROOT, 'packages/poly-runtime/model');
    const workspaceBase = join(tmp, '.harness/poly-runtime/model');
    const sourceFiles = walkDirectory(sourceBase);

    for (const relPath of sourceFiles) {
      const sourcePath = join(sourceBase, ...relPath.split('/'));
      const workspacePath = join(workspaceBase, ...relPath.split('/'));
      assert.ok(existsSync(workspacePath), `workspace has file: ${relPath}`);
      const sourceBytes = readFileSync(sourcePath);
      const workspaceBytes = readFileSync(workspacePath);
      assert.deepEqual(sourceBytes, workspaceBytes, `${relPath} matches byte for byte`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('DB16.1: .harness/poly-runtime has package.json and dist/ folder', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ws-poly-runtime-'));
  try {
    makeWorkspace('poly', tmp, ROOT);
    const files = listFiles(tmp);
    assert.ok(files.includes('.harness/poly-runtime/package.json'), 'includes .harness/poly-runtime/package.json');
    assert.ok(files.some(f => f.startsWith('.harness/poly-runtime/dist/')), 'includes files under .harness/poly-runtime/dist/');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- DB16.2: TypeScript workspace unchanged, only poly has model -------

test('DB16.2: TypeScript workspace scaffoldDigest equals amendment 1 value exactly', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ws-ts-digest-'));
  try {
    makeWorkspace('ts', tmp, ROOT);
    const digest = scaffoldDigest('ts', tmp, ROOT);
    const amendment1 = getAmendment1Scaffolds();
    assert.equal(digest, amendment1.ts, `ts digest matches amendment 1 value: ${digest}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('DB16.2: TypeScript workspace has no path containing "model"', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ws-ts-nomodel-'));
  try {
    makeWorkspace('ts', tmp, ROOT);
    const files = listFiles(tmp);
    const modelFiles = files.filter(f => f.includes('model'));
    assert.deepEqual(modelFiles, [], `no files with "model" in path, found: ${modelFiles.join(', ')}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('DB16.2: only poly-runtime of .harness folders has a model subfolder', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ws-poly-onlyruntime-'));
  try {
    makeWorkspace('poly', tmp, ROOT);
    const files = listFiles(tmp);
    const harnessFiles = files.filter(f => f.startsWith('.harness/'));
    const modelFolders = new Set();
    for (const f of harnessFiles) {
      const parts = f.split('/');
      if (parts.length >= 3 && parts[0] === '.harness' && parts[2] === 'model') {
        modelFolders.add(parts[1]);
      }
    }
    assert.deepEqual(Array.from(modelFolders).sort(), ['poly-runtime'], `only .harness/poly-runtime has model folder, found: ${Array.from(modelFolders).join(', ')}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- DB16.3: poly workspace differs from no-model only by model files -------

test('DB16.3: deleting .harness/poly-runtime/model gives treeDigest equal to amendment 1 poly scaffold', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ws-poly-digest-'));
  try {
    makeWorkspace('poly', tmp, ROOT);
    const allFiles = listFiles(tmp);
    const modelFiles = allFiles.filter(f => f.startsWith('.harness/poly-runtime/model/'));
    assert.ok(modelFiles.length > 0, 'has at least some model files');

    // Delete the model folder
    rmSync(join(tmp, '.harness/poly-runtime/model'), { recursive: true, force: true });

    // Compute treeDigest of workspace without model
    const digester = treeDigest(tmp, { skip: [] });
    const amendment1 = getAmendment1Scaffolds();
    assert.equal(digester, amendment1.poly, `treeDigest without model equals amendment 1 poly scaffold`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- DB16.4: smokeTest poly with new steps -------

let cachedPolyResult;
function getPolyResult() {
  if (!cachedPolyResult) {
    cachedPolyResult = smokeTest('poly', { root: ROOT, timeout: 300000 });
  }
  return cachedPolyResult;
}

test('DB16.4: smokeTest("poly", { root: ROOT, timeout: 300000 }) returns ok with correct step names including admit and runtime', () => {
  const result = getPolyResult();
  assert.ok(result && typeof result === 'object', 'returns an object');
  assert.equal(result.ok, true, 'result.ok === true');
  assert.ok(Array.isArray(result.steps), 'result.steps is an array');
  const stepNames = result.steps.map((s) => s.name);
  assert.deepEqual(stepNames, ['install', 'check-clean', 'check-finding', 'admit', 'runtime', 'install-local', 'check-after'], 'step names match DB16 spec');
  for (const step of result.steps) {
    assert.equal(step.ok, true, `step ${step.name} has ok === true`);
    assert.ok(step.detail && typeof step.detail === 'string' && step.detail.length > 0, `step ${step.name} has non-empty detail string`);
  }
});

test('DB16.4: smokeTest("poly") admit step detail contains "admitted"', () => {
  const result = getPolyResult();
  const admitStep = result.steps.find(s => s.name === 'admit');
  assert.ok(admitStep, 'admit step exists');
  assert.ok(admitStep.detail.includes('admitted'), `admit detail contains "admitted": ${admitStep.detail.substring(0, 200)}`);
});

test('DB16.4: smokeTest("poly") runtime step detail contains "stepKind":"accepted"', () => {
  const result = getPolyResult();
  const runtimeStep = result.steps.find(s => s.name === 'runtime');
  assert.ok(runtimeStep, 'runtime step exists');
  assert.ok(runtimeStep.detail.includes('"stepKind":"accepted"'), `runtime detail contains "stepKind":"accepted": ${runtimeStep.detail.substring(0, 400)}`);
});

// ---- DB16.5: smokeTest TypeScript with new steps -------

test('DB16.5: smokeTest("ts", { root: ROOT, timeout: 300000 }) returns ok with correct step names including node-test', () => {
  const result = smokeTest('ts', { root: ROOT, timeout: 300000 });
  assert.ok(result && typeof result === 'object', 'returns an object');
  assert.equal(result.ok, true, 'result.ok === true');
  assert.ok(Array.isArray(result.steps), 'result.steps is an array');
  const stepNames = result.steps.map((s) => s.name);
  assert.deepEqual(stepNames, ['install', 'tsc-version', 'node-test', 'install-local', 'tsc-after'], 'step names match DB16 spec');
  for (const step of result.steps) {
    assert.equal(step.ok, true, `step ${step.name} has ok === true`);
    assert.ok(step.detail && typeof step.detail === 'string' && step.detail.length > 0, `step ${step.name} has non-empty detail string`);
  }
});

// ---- DB16.6: Failure modes with mirrored root -------

test('DB16.6a: smokeTest("poly") throws when root lacks packages/poly-runtime/model folder', () => {
  const mirrorRoot = mkdtempSync(join(tmpdir(), 'mirror-root-nomodel-'));
  try {
    // Create junction links to all top-level directories except packages, copy top-level files
    const topEntries = readdirSync(ROOT);
    for (const entry of topEntries) {
      if (entry === 'packages') continue;
      const sourcePath = join(ROOT, entry);
      const stat = statSync(sourcePath);
      if (stat.isDirectory()) {
        symlinkSync(sourcePath, join(mirrorRoot, entry), 'junction');
      } else {
        copyFileSync(sourcePath, join(mirrorRoot, entry));
      }
    }

    // Create packages with junctions to each package except poly-runtime
    const packagesDir = join(mirrorRoot, 'packages');
    mkdirSync(packagesDir, { recursive: true });
    const packageEntries = readdirSync(join(ROOT, 'packages'));
    for (const pkgName of packageEntries) {
      if (pkgName === 'poly-runtime') {
        // poly-runtime: copy package.json and dist, but NO model folder
        const pkgSourceDir = join(ROOT, 'packages', 'poly-runtime');
        const pkgDir = join(packagesDir, 'poly-runtime');
        mkdirSync(pkgDir, { recursive: true });
        copyFileSync(join(pkgSourceDir, 'package.json'), join(pkgDir, 'package.json'));
        cpSync(join(pkgSourceDir, 'dist'), join(pkgDir, 'dist'), { recursive: true });
      } else {
        symlinkSync(join(ROOT, 'packages', pkgName), join(packagesDir, pkgName), 'junction');
      }
    }

    // Verify it throws
    assert.throws(
      () => smokeTest('poly', { root: mirrorRoot, timeout: 300000 }),
      /ENOENT|no such file|does not exist|model|MANIFEST/i,
      'smokeTest throws when poly-runtime/model is missing'
    );
  } finally {
    rmSync(mirrorRoot, { recursive: true, force: true });
  }
});

test('DB16.6b: smokeTest("poly") ok false when model lacks build folder, runtime step fails', () => {
  const mirrorRoot = mkdtempSync(join(tmpdir(), 'mirror-root-nomodel-build-'));
  try {
    // Create junction links to all top-level directories except packages, copy top-level files
    const topEntries = readdirSync(ROOT);
    for (const entry of topEntries) {
      if (entry === 'packages') continue;
      const sourcePath = join(ROOT, entry);
      const stat = statSync(sourcePath);
      if (stat.isDirectory()) {
        symlinkSync(sourcePath, join(mirrorRoot, entry), 'junction');
      } else {
        copyFileSync(sourcePath, join(mirrorRoot, entry));
      }
    }

    // Create packages with junctions to each package except poly-runtime
    const packagesDir = join(mirrorRoot, 'packages');
    mkdirSync(packagesDir, { recursive: true });
    const packageEntries = readdirSync(join(ROOT, 'packages'));
    for (const pkgName of packageEntries) {
      if (pkgName === 'poly-runtime') {
        // poly-runtime: copy package.json, dist, and model as real files (not junctions)
        const pkgSourceDir = join(ROOT, 'packages', 'poly-runtime');
        const pkgDir = join(packagesDir, 'poly-runtime');
        mkdirSync(pkgDir, { recursive: true });
        copyFileSync(join(pkgSourceDir, 'package.json'), join(pkgDir, 'package.json'));
        cpSync(join(pkgSourceDir, 'dist'), join(pkgDir, 'dist'), { recursive: true });
        // Create model with only outbox-intent.poly, no build folder
        mkdirSync(join(pkgDir, 'model'), { recursive: true });
        copyFileSync(join(pkgSourceDir, 'model', 'outbox-intent.poly'), join(pkgDir, 'model', 'outbox-intent.poly'));
        // Don't create build folder - runtime will fail
      } else {
        symlinkSync(join(ROOT, 'packages', pkgName), join(packagesDir, pkgName), 'junction');
      }
    }

    // Run smoke test - expect ok false
    const result = smokeTest('poly', { root: mirrorRoot, timeout: 300000 });
    assert.equal(result.ok, false, 'result.ok === false when model build missing');
    assert.ok(Array.isArray(result.steps), 'result.steps is an array');

    // Check that runtime step failed
    const runtimeStep = result.steps.find(s => s.name === 'runtime');
    assert.ok(runtimeStep, 'runtime step exists');
    assert.equal(runtimeStep.ok, false, 'runtime step ok === false');
    assert.ok(runtimeStep.detail && typeof runtimeStep.detail === 'string' && runtimeStep.detail.length > 0, 'runtime step has error detail');
    assert.ok(!runtimeStep.detail.includes('"stepKind":"accepted"'), 'runtime detail does not contain accepted');

    // Check earlier steps passed and are exactly as expected
    const stepsBefore = result.steps.slice(0, result.steps.findIndex(s => s.name === 'runtime'));
    const stepNamesBefore = stepsBefore.map(s => s.name);
    assert.deepEqual(stepNamesBefore, ['install', 'check-clean', 'check-finding', 'admit'], 'steps before runtime are exactly as expected');
    assert.ok(stepsBefore.every(s => s.ok), 'all steps before runtime are ok');

    // Check no steps after runtime
    const runtimeIndex = result.steps.findIndex(s => s.name === 'runtime');
    assert.equal(result.steps.length, runtimeIndex + 1, 'no steps after failed runtime step');
  } finally {
    rmSync(mirrorRoot, { recursive: true, force: true });
  }
});
