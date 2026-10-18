// DB16: poly workspace includes model folder, smoke test runs runtime check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, copyFileSync, symlinkSync, statSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
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

test('DB16.3: deleting .harness/poly-runtime/model and .harness/std, removing std from devDependencies, gives treeDigest equal to amendment 1 poly scaffold', () => {
  // DB16 item 2: the poly workspace differs from amendment 1 only by those folders and the std entry.
  const tmp = mkdtempSync(join(tmpdir(), 'ws-poly-digest-'));
  try {
    makeWorkspace('poly', tmp, ROOT);
    const allFiles = listFiles(tmp);
    const modelFiles = allFiles.filter(f => f.startsWith('.harness/poly-runtime/model/'));
    const stdFiles = allFiles.filter(f => f.startsWith('.harness/std/'));
    assert.ok(modelFiles.length > 0, 'has at least some model files');
    assert.ok(stdFiles.length > 0, 'has at least some std files');

    // Verify std folder and devDependency exist before removing
    const pkg = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8'));
    assert.equal(pkg.devDependencies.std, 'file:.harness/std', 'devDependencies.std equals file:.harness/std');

    // Delete the model folder and std folder
    rmSync(join(tmp, '.harness/poly-runtime/model'), { recursive: true, force: true });
    rmSync(join(tmp, '.harness/std'), { recursive: true, force: true });

    // Remove std from devDependencies and write package.json back
    delete pkg.devDependencies.std;
    writeFileSync(join(tmp, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');

    // Compute treeDigest of workspace without model and std
    const digester = treeDigest(tmp, { skip: [] });
    const amendment1 = getAmendment1Scaffolds();
    assert.equal(digester, amendment1.poly, `treeDigest without model and std equals amendment 1 poly scaffold`);
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

test('DB16.4: smokeTest("poly", { root: ROOT, timeout: 300000 }) returns ok with correct step names including admit, runtime and std', () => {
  const result = getPolyResult();
  assert.ok(result && typeof result === 'object', 'returns an object');
  assert.equal(result.ok, true, 'result.ok === true');
  assert.ok(Array.isArray(result.steps), 'result.steps is an array');
  const stepNames = result.steps.map((s) => s.name);
  assert.deepEqual(stepNames, ['install', 'check-clean', 'check-finding', 'admit', 'runtime', 'std', 'install-local', 'check-after'], 'step names match DB16 spec');
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
    // Create junction links to top-level directories except packages and std, copy top-level files.
    // DB16 item 7: std must be a real copy, not a junction. cpSync with a junction as the last path component
    // on Windows makes a symlink, which fails EPERM. Copying from paths under a junction is fine.
    const topEntries = readdirSync(ROOT);
    for (const entry of topEntries) {
      if (entry === 'packages' || entry === 'std') continue;
      const sourcePath = join(ROOT, entry);
      const stat = statSync(sourcePath);
      if (stat.isDirectory()) {
        symlinkSync(sourcePath, join(mirrorRoot, entry), 'junction');
      } else {
        copyFileSync(sourcePath, join(mirrorRoot, entry));
      }
    }
    // Copy std as real files
    cpSync(join(ROOT, 'std'), join(mirrorRoot, 'std'), { recursive: true });

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
    // Create junction links to top-level directories except packages and std, copy top-level files.
    // DB16 item 7: std must be a real copy, not a junction. cpSync with a junction as the last path component
    // on Windows makes a symlink, which fails EPERM. Copying from paths under a junction is fine.
    const topEntries = readdirSync(ROOT);
    for (const entry of topEntries) {
      if (entry === 'packages' || entry === 'std') continue;
      const sourcePath = join(ROOT, entry);
      const stat = statSync(sourcePath);
      if (stat.isDirectory()) {
        symlinkSync(sourcePath, join(mirrorRoot, entry), 'junction');
      } else {
        copyFileSync(sourcePath, join(mirrorRoot, entry));
      }
    }
    // Copy std as real files
    cpSync(join(ROOT, 'std'), join(mirrorRoot, 'std'), { recursive: true });

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

// ---- DB16.7: std folder, std devDependency, std smoke step -------

test('DB16.7: makeWorkspace("poly", tmpdir) holds every file of ROOT/std under .harness/std/ byte for byte', () => {
  // DB16 item 7: the workspace copies the repository std folder wholly into .harness/std.
  const tmp = mkdtempSync(join(tmpdir(), 'ws-poly-std-files-'));
  try {
    makeWorkspace('poly', tmp, ROOT);
    const sourceBase = join(ROOT, 'std');
    const workspaceBase = join(tmp, '.harness/std');
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

test('DB16.7: .harness/std/package.json has exact content { name: std, version: 0.0.0, private: true } with final newline', () => {
  // DB16 item 7: the harness writes the std package.json with exact structure and a final newline.
  const tmp = mkdtempSync(join(tmpdir(), 'ws-poly-std-pkg-'));
  try {
    makeWorkspace('poly', tmp, ROOT);
    const pkgPath = join(tmp, '.harness/std/package.json');
    assert.ok(existsSync(pkgPath), '.harness/std/package.json exists');
    const content = readFileSync(pkgPath, 'utf8');
    assert.ok(content.endsWith('\n'), 'package.json ends with newline');
    const pkg = JSON.parse(content);
    assert.equal(pkg.name, 'std', 'name is std');
    assert.equal(pkg.version, '0.0.0', 'version is 0.0.0');
    assert.equal(pkg.private, true, 'private is true');
    const keys = Object.keys(pkg).sort();
    assert.deepEqual(keys, ['name', 'private', 'version'].sort(), 'exactly three keys');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('DB16.7: poly workspace devDependencies has std: file:.harness/std', () => {
  // DB16 item 7: the workspace declares std as a devDependency.
  const tmp = mkdtempSync(join(tmpdir(), 'ws-poly-std-dep-'));
  try {
    makeWorkspace('poly', tmp, ROOT);
    const pkg = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8'));
    assert.equal(pkg.devDependencies.std, 'file:.harness/std', 'devDependencies.std is file:.harness/std');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('DB16.7: TypeScript workspace has no path containing "std" and no std dependency', () => {
  // DB16 item 7: the TypeScript workspace is unchanged and has no std.
  const tmp = mkdtempSync(join(tmpdir(), 'ws-ts-nostd-'));
  try {
    makeWorkspace('ts', tmp, ROOT);
    const files = listFiles(tmp);
    const stdFiles = files.filter(f => f.includes('std'));
    assert.deepEqual(stdFiles, [], `no files with "std" in path, found: ${stdFiles.join(', ')}`);
    const pkg = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8'));
    assert.equal(pkg.devDependencies.std, undefined, 'no std devDependency');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('DB16.7: smokeTest("poly") includes std step after runtime and before install-local with correct details', () => {
  // DB16 item 7: the smoke step std tests that the poly workspace can check a module using a std channel kind.
  const result = getPolyResult();
  const steps = result.steps.map(s => s.name);
  const runtimeIdx = steps.indexOf('runtime');
  const stdIdx = steps.indexOf('std');
  const installLocalIdx = steps.indexOf('install-local');
  assert.ok(runtimeIdx >= 0, 'runtime step exists');
  assert.ok(stdIdx >= 0, 'std step exists');
  assert.ok(installLocalIdx >= 0, 'install-local step exists');
  assert.ok(runtimeIdx < stdIdx && stdIdx < installLocalIdx, 'std step is between runtime and install-local');

  const stdStep = result.steps.find(s => s.name === 'std');
  assert.equal(stdStep.ok, true, 'std step ok === true');
  assert.ok(stdStep.detail.includes('configuration support: configuration CLEAN'), 'detail contains configuration support: configuration CLEAN');
  assert.ok(!stdStep.detail.includes('PL6811'), 'detail does not contain PL6811');
});

test('DB16.7: smokeTest("poly") root without .harness/std throws', () => {
  // DB16 item 5: a root whose std folder is missing makes the build throw. The spec is silent on this,
  // so by analogy with DB10.9, a root without a needed top-level folder throws.
  const mirrorRoot = mkdtempSync(join(tmpdir(), 'mirror-root-nolib-'));
  try {
    // Create junction links to all top-level directories except packages and std, copy top-level files
    const topEntries = readdirSync(ROOT);
    for (const entry of topEntries) {
      if (entry === 'packages' || entry === 'std') continue;
      const sourcePath = join(ROOT, entry);
      const stat = statSync(sourcePath);
      if (stat.isDirectory()) {
        symlinkSync(sourcePath, join(mirrorRoot, entry), 'junction');
      } else {
        copyFileSync(sourcePath, join(mirrorRoot, entry));
      }
    }

    // Create packages with junctions to each package
    const packagesDir = join(mirrorRoot, 'packages');
    mkdirSync(packagesDir, { recursive: true });
    const packageEntries = readdirSync(join(ROOT, 'packages'));
    for (const pkgName of packageEntries) {
      symlinkSync(join(ROOT, 'packages', pkgName), join(packagesDir, pkgName), 'junction');
    }

    // Note: do not create std folder - it is intentionally missing.
    // This test shows the builder throws, not the std smoke step's check.

    assert.throws(
      () => smokeTest('poly', { root: mirrorRoot, timeout: 300000 }),
      /ENOENT|no such file|does not exist/,
      'smokeTest throws when std is missing'
    );
  } finally {
    rmSync(mirrorRoot, { recursive: true, force: true });
  }
});

test('DB16.7: after smokeTest("poly") succeeds, offline npm install --save-dev keeps node_modules/std intact', () => {
  // DB16 item 7: a proof that std is installed and persists through a second npm install.
  // The smoke test runs offline; we replicate that and add a second install.
  const tmp = mkdtempSync(join(tmpdir(), 'ws-poly-install-proof-'));
  try {
    makeWorkspace('poly', tmp, ROOT);

    // Run npm install offline
    const npmCache = mkdtempSync(join(tmpdir(), 'npm-cache-'));
    try {
      const env = {
        ...process.env,
        npm_config_offline: 'true',
        npm_config_cache: npmCache,
        npm_config_registry: 'http://127.0.0.1:9/',
      };
      delete env.NODE_TEST_CONTEXT;

      execSync('npm install', { cwd: tmp, env, timeout: 300000, shell: true });
      assert.ok(existsSync(join(tmp, 'node_modules/std/package.json')), 'node_modules/std/package.json exists after first install');
      assert.ok(existsSync(join(tmp, 'node_modules/std/PINS.json')), 'node_modules/std/PINS.json exists after first install');

      // Create a tiny local package and install it
      const unrelatedDir = join(tmp, 'unrelated');
      mkdirSync(unrelatedDir, { recursive: true });
      writeFileSync(join(unrelatedDir, 'package.json'), JSON.stringify({
        name: 'unrelated-local',
        version: '1.0.0',
      }, null, 2) + '\n', 'utf8');

      // Run npm install --save-dev with the local package
      execSync('npm install --save-dev ./unrelated', { cwd: tmp, env, timeout: 300000, shell: true });

      // Verify std is still there
      assert.ok(existsSync(join(tmp, 'node_modules/std/package.json')), 'node_modules/std/package.json exists after second install');
      assert.ok(existsSync(join(tmp, 'node_modules/unrelated-local/package.json')), 'node_modules/unrelated-local/package.json exists');
    } finally {
      rmSync(npmCache, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
