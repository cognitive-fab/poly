// DB10 to DB14: the workspace holds its own toolchain, declared; confinement and audit (abbreviated); the record;
// pre-registration amendment; and caveats. Tests of the protocol that removes H1, H2 and H3 (DB10 to DB13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, WORK_DIR, workDir, listFiles } from '../demo/baseline/arms.mjs';
import { smokeTest } from '../demo/baseline/smoke.mjs';
import { RUNS_DIR } from '../demo/baseline/procedure.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// ---- DB10.1: makeWorkspace returns sorted relative paths using '/', includes declared files -------

test('DB10.1: makeWorkspace(arm, dir, root) returns sorted array of relative paths using / that includes package.json, .npmrc, orders.json and .harness folders', () => {
  // Catches implementation that does not write .harness/ folders or does not include them in the result.
  for (const arm of ['ts', 'poly']) {
    const tmp = mkdtempSync(join(tmpdir(), `ws-${arm}-`));
    try {
      const files = makeWorkspace(arm, tmp, ROOT);
      assert.ok(Array.isArray(files), `${arm}: result is an array`);
      assert.ok(files.length > 0, `${arm}: result is not empty`);
      assert.deepEqual(files, [...files].sort(), `${arm}: result is sorted`);
      assert.ok(files.every((f) => typeof f === 'string' && !f.includes(String.fromCharCode(92)) && !f.startsWith('/')), `${arm}: every entry is a relative path with forward slashes`);
      assert.ok(files.includes('package.json'), `${arm}: includes package.json`);
      assert.ok(files.includes('.npmrc'), `${arm}: includes .npmrc`);
      assert.ok(files.includes('orders.json'), `${arm}: includes orders.json`);
      const actualFiles = listFiles(tmp);
      assert.deepEqual(files, actualFiles, `${arm}: result deep-equals files actually present`);
      assert.ok(files.some((f) => f.startsWith('.harness/')), `${arm}: includes files under .harness/`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
});

test('DB10.1: .harness/typescript folder exists with package.json for the TypeScript arm', () => {
  // Catches implementation that does not create .harness folders with correct names.
  const tmp = mkdtempSync(join(tmpdir(), 'ws-ts-harness-'));
  try {
    const files = makeWorkspace('ts', tmp, ROOT);
    assert.ok(files.some((f) => f === '.harness/typescript/package.json'), 'includes .harness/typescript/package.json');
    assert.ok(existsSync(join(tmp, '.harness', 'typescript', 'package.json')), 'folder exists');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- DB10.2: devDependencies are declared with exact keys and file: values -------

test('DB10.2: TypeScript arm package.json devDependencies has exactly typescript, @types/node, undici-types', () => {
  // Catches implementation that uses node_modules instead of declaring packages.
  const tmp = mkdtempSync(join(tmpdir(), 'ws-ts-deps-'));
  try {
    makeWorkspace('ts', tmp, ROOT);
    const pkg = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8'));
    const keys = Object.keys(pkg.devDependencies ?? {});
    assert.deepEqual(keys.sort(), ['@types/node', 'typescript', 'undici-types'].sort(), 'exactly three devDependencies');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('DB10.2: poly arm package.json devDependencies has exactly 14 keys: @poly/*, @cognitive-fab/*, typescript, @types/node, undici-types', () => {
  // Catches implementation that does not declare all packages or declares wrong names.
  const tmp = mkdtempSync(join(tmpdir(), 'ws-poly-deps-'));
  try {
    makeWorkspace('poly', tmp, ROOT);
    const pkg = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8'));
    const keys = Object.keys(pkg.devDependencies ?? {}).sort();
    const expected = [
      '@cognitive-fab/polyflow-kernel', '@cognitive-fab/polyflow-verify', '@cognitive-fab/polygraph', '@cognitive-fab/sam-pattern',
      '@poly/check', '@poly/core', '@poly/embed', '@poly/lang', '@poly/lower', '@poly/ref', '@poly/runtime',
      '@types/node', 'typescript', 'undici-types',
    ].sort();
    assert.deepEqual(keys, expected, 'exactly 14 devDependencies with correct names');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('DB10.2: every devDependencies entry matches /^file:\\.harness\\/[A-Za-z0-9._-]+$/ and its folder exists with package.json', () => {
  // Catches implementation that uses version ranges or does not create harness folders.
  for (const arm of ['ts', 'poly']) {
    const tmp = mkdtempSync(join(tmpdir(), `ws-${arm}-pattern-`));
    try {
      makeWorkspace(arm, tmp, ROOT);
      const pkg = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8'));
      for (const [name, value] of Object.entries(pkg.devDependencies ?? {})) {
        assert.match(value, /^file:\.harness\/[A-Za-z0-9._-]+$/, `${arm}: ${name} value matches pattern`);
        const folder = join(tmp, value.slice('file:'.length));
        assert.ok(existsSync(folder), `${arm}: folder exists for ${name}: ${value}`);
        assert.ok(existsSync(join(folder, 'package.json')), `${arm}: ${name} folder has package.json`);
      }
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
});

// ---- DB10.3: dependency closure -------

test('DB10.3: every declared package\'s dependencies are satisfied by workspace devDependencies, versions match ranges (a minimum of edges checked per arm)', () => {
  // Catches implementation that does not include transitive dependencies or versions do not satisfy.
  function satisfies(version, range) {
    if (range.match(/^\d+\.\d+\.\d+$/)) return version === range;
    const m = range.match(/^[\^~]?(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const [, major, minor, patch] = m.map(Number);
    const [v1, v2, v3] = version.split('.').map(Number);
    if (range.startsWith('^')) return v1 === major && (v2 > minor || (v2 === minor && v3 >= patch));
    if (range.startsWith('~')) return v1 === major && v2 === minor && v3 >= patch;
    return v1 === major && v2 === minor && v3 === patch;
  }
  for (const arm of ['ts', 'poly']) {
    const tmp = mkdtempSync(join(tmpdir(), `ws-${arm}-closure-`));
    try {
      makeWorkspace(arm, tmp, ROOT);
      const pkg = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8'));
      const topLevelDeps = Object.keys(pkg.devDependencies ?? {});
      let edgesChecked = 0;
      for (const [pkgName, fileValue] of Object.entries(pkg.devDependencies ?? {})) {
        const pkgFolder = join(tmp, fileValue.slice('file:'.length));
        const pkgJson = JSON.parse(readFileSync(join(pkgFolder, 'package.json'), 'utf8'));
        const declaredName = pkgJson.name;
        assert.equal(declaredName, pkgName, `${arm}: ${pkgName} folder package.json name matches key`);
        for (const [depName, depRange] of Object.entries(pkgJson.dependencies ?? {})) {
          edgesChecked++;
          assert.ok(topLevelDeps.includes(depName), `${arm}: ${pkgName} depends on ${depName}, which is declared at top level`);
          const depVersion = JSON.parse(readFileSync(join(tmp, pkg.devDependencies[depName].slice('file:'.length), 'package.json'), 'utf8')).version;
          assert.ok(satisfies(depVersion, depRange), `${arm}: ${depName} version ${depVersion} satisfies ${depRange}`);
        }
      }
      // The TypeScript arm has one edge (@types/node needs undici-types); the poly arm has many. An empty loop must fail in both.
      const least = arm === 'poly' ? 8 : 1;
      assert.ok(edgesChecked >= least, `${arm}: checked at least ${least} dependency edge(s) (checked: ${edgesChecked})`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
});

// ---- DB10.4: .npmrc and no node_modules -------

test('DB10.4: .npmrc contains the exact line install-links=true (on its own line)', () => {
  // Catches implementation that does not write .npmrc or writes it incorrectly.
  for (const arm of ['ts', 'poly']) {
    const tmp = mkdtempSync(join(tmpdir(), `ws-${arm}-npmrc-`));
    try {
      makeWorkspace(arm, tmp, ROOT);
      const npmrc = readFileSync(join(tmp, '.npmrc'), 'utf8');
      const lines = npmrc.split('\n');
      assert.ok(lines.includes('install-links=true'), `${arm}: .npmrc contains the exact line install-links=true`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
});

test('DB10.4: no node_modules directory exists and no file path starts with node_modules/', () => {
  // Catches implementation that copies packages into node_modules.
  for (const arm of ['ts', 'poly']) {
    const tmp = mkdtempSync(join(tmpdir(), `ws-${arm}-nomodules-`));
    try {
      makeWorkspace(arm, tmp, ROOT);
      assert.ok(!existsSync(join(tmp, 'node_modules')), `${arm}: no node_modules directory`);
      const files = listFiles(tmp);
      assert.ok(!files.some((f) => f.startsWith('node_modules/')), `${arm}: no file starts with node_modules/`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
});

// ---- DB10.5: scripts and metadata -------

test('DB10.5: both arms have scripts.test === "node --test" and both package.json have name "support-agent", private true, type "module"', () => {
  // Catches implementation with wrong script or metadata.
  for (const arm of ['ts', 'poly']) {
    const tmp = mkdtempSync(join(tmpdir(), `ws-${arm}-scripts-`));
    try {
      makeWorkspace(arm, tmp, ROOT);
      const pkg = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8'));
      assert.equal(pkg.scripts.test, 'node --test', `${arm}: scripts.test`);
      assert.equal(pkg.name, 'support-agent', `${arm}: name`);
      assert.equal(pkg.private, true, `${arm}: private`);
      assert.equal(pkg.type, 'module', `${arm}: type`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
});

test('DB10.5: TypeScript arm has no scripts.poly', () => {
  // Catches implementation that adds poly script to TypeScript arm.
  const tmp = mkdtempSync(join(tmpdir(), 'ws-ts-nopoly-'));
  try {
    makeWorkspace('ts', tmp, ROOT);
    const pkg = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.poly, undefined, 'no scripts.poly');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('DB10.5: poly arm has scripts.poly === "node node_modules/@poly/check/dist/src/cli.js"', () => {
  // Catches implementation with wrong poly script.
  const tmp = mkdtempSync(join(tmpdir(), 'ws-poly-poly-'));
  try {
    makeWorkspace('poly', tmp, ROOT);
    const pkg = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.poly, 'node node_modules/@poly/check/dist/src/cli.js', 'scripts.poly');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- DB10.6: orders.json and tools/poly -------

test('DB10.6: orders.json in each workspace equals demo/baseline/orders.json byte for byte', () => {
  // Catches implementation that modifies orders.json.
  const expected = readFileSync(join(ROOT, 'demo', 'baseline', 'orders.json'));
  for (const arm of ['ts', 'poly']) {
    const tmp = mkdtempSync(join(tmpdir(), `ws-${arm}-orders-`));
    try {
      makeWorkspace(arm, tmp, ROOT);
      const actual = readFileSync(join(tmp, 'orders.json'));
      assert.deepEqual(actual, expected, `${arm}: orders.json matches byte for byte`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
});

test('DB10.6: poly workspace lists exactly 13 files under tools/poly/', () => {
  // Catches implementation that adds or removes reference files.
  const tmp = mkdtempSync(join(tmpdir(), 'ws-poly-toolspoly-'));
  try {
    makeWorkspace('poly', tmp, ROOT);
    const files = listFiles(tmp);
    const toolsPolyFiles = files.filter((f) => f.startsWith('tools/poly/'));
    assert.equal(toolsPolyFiles.length, 13, `exactly 13 files under tools/poly/, got ${toolsPolyFiles.length}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('DB10.6: tools/poly/README.md in poly workspace contains "What poly does not express"', () => {
  // Catches implementation that modifies or does not include the reference.
  const tmp = mkdtempSync(join(tmpdir(), 'ws-poly-readme-'));
  try {
    makeWorkspace('poly', tmp, ROOT);
    const readme = readFileSync(join(tmp, 'tools', 'poly', 'README.md'), 'utf8');
    assert.ok(readme.includes('What poly does not express'), 'README contains required text');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- DB10.7: placement of WORK_DIR and workDir -------

test('DB10.7: WORK_DIR ends with ".poly-demo/work" (normalised separators)', () => {
  // Catches implementation with wrong WORK_DIR.
  assert.ok(WORK_DIR.endsWith('.poly-demo/work') || WORK_DIR.endsWith('.poly-demo\\work'), `WORK_DIR ends with .poly-demo/work, got ${WORK_DIR}`);
});

test('DB10.7: workDir(arm, run) returns path.join(WORK_DIR, `${arm}-${run}`)', () => {
  // Catches implementation that returns wrong path structure.
  for (const [arm, run] of [['ts', 'pilot-1'], ['ts', 'pilot-2'], ['poly', 'pilot-1']]) {
    const result = workDir(arm, run);
    const expected = join(WORK_DIR, `${arm}-${run}`);
    assert.equal(result, expected, `workDir(${arm}, ${run}) equals path.join(WORK_DIR, "${arm}-${run}")`);
  }
});

test('DB10.7: WORK_DIR is not inside RUNS_DIR and RUNS_DIR is not inside WORK_DIR', () => {
  // Catches implementation where directories are nested when they should not be.
  const workNorm = WORK_DIR.toLowerCase().replace(/\\/g, '/');
  const runsNorm = RUNS_DIR.toLowerCase().replace(/\\/g, '/');
  assert.ok(!workNorm.startsWith(runsNorm), 'WORK_DIR is not inside RUNS_DIR');
  assert.ok(!runsNorm.startsWith(workNorm), 'RUNS_DIR is not inside WORK_DIR');
});

test('DB10.7: workDir("ts", "pilot-2") and workDir("poly", "pilot-2") are not inside each other and neither is inside RUNS_DIR', () => {
  // Catches implementation where workspace directories overlap.
  const tsDir = workDir('ts', 'pilot-2').toLowerCase().replace(/\\/g, '/');
  const polyDir = workDir('poly', 'pilot-2').toLowerCase().replace(/\\/g, '/');
  const runsNorm = RUNS_DIR.toLowerCase().replace(/\\/g, '/');
  assert.ok(!tsDir.startsWith(polyDir) && !polyDir.startsWith(tsDir), 'ts and poly workspace dirs are not nested');
  assert.ok(!tsDir.startsWith(runsNorm) && !runsNorm.startsWith(tsDir), 'ts workspace not in RUNS_DIR');
  assert.ok(!polyDir.startsWith(runsNorm) && !runsNorm.startsWith(polyDir), 'poly workspace not in RUNS_DIR');
});

// ---- DB10.8: smokeTest execution and structure -------

test('DB10.8: smokeTest("poly", { root }) with timeout 300000 returns ok true with correct step names and all ok', () => {
  // Catches implementation that does not run, returns wrong structure, or steps fail.
  const result = smokeTest('poly', { root: ROOT, timeout: 300000 });
  assert.ok(result && typeof result === 'object', 'returns an object');
  assert.equal(result.ok, true, 'result.ok === true');
  assert.ok(Array.isArray(result.steps), 'result.steps is an array');
  const stepNames = result.steps.map((s) => s.name);
  assert.deepEqual(stepNames, ['install', 'check-clean', 'check-finding', 'admit', 'runtime', 'install-local', 'check-after'], 'step names match spec');
  for (const step of result.steps) {
    assert.equal(step.ok, true, `step ${step.name} has ok === true`);
    assert.ok(step.detail && typeof step.detail === 'string' && step.detail.length > 0, `step ${step.name} has non-empty detail string`);
  }
});

test('DB10.8: smokeTest("ts", { root }) with timeout 300000 returns ok true with correct step names and all ok', () => {
  // Catches implementation that does not run, returns wrong structure, or steps fail.
  const result = smokeTest('ts', { root: ROOT, timeout: 300000 });
  assert.ok(result && typeof result === 'object', 'returns an object');
  assert.equal(result.ok, true, 'result.ok === true');
  assert.ok(Array.isArray(result.steps), 'result.steps is an array');
  const stepNames = result.steps.map((s) => s.name);
  assert.deepEqual(stepNames, ['install', 'tsc-version', 'node-test', 'install-local', 'tsc-after'], 'step names match spec');
  for (const step of result.steps) {
    assert.equal(step.ok, true, `step ${step.name} has ok === true`);
    assert.ok(step.detail && typeof step.detail === 'string' && step.detail.length > 0, `step ${step.name} has non-empty detail string`);
  }
});

test('DB10.8: smokeTest leaves no workspace behind (no new temp entries with "smoke" or "poly-demo" in name)', () => {
  // Catches implementation that does not clean up temporary directories.
  const beforeNames = new Set(readdirSync(tmpdir()));
  smokeTest('ts', { root: ROOT, timeout: 300000 });
  const afterNames = new Set(readdirSync(tmpdir()));
  const gained = [...afterNames].filter((n) => !beforeNames.has(n) && (n.includes('smoke') || n.includes('poly-demo')));
  assert.deepEqual(gained, [], `no new temp entries with "smoke" or "poly-demo", gained: ${gained.join(', ')}`);
});

// ---- DB10.9: smokeTest failure path -------

// Assumption (the spec is silent): a root that lacks the package sources makes the workspace build fail, and smokeTest lets that error out
// instead of returning ok true. Catches a smoke test that reports success for a toolchain it could not build.
test('DB10.9: smokeTest on a root without the package sources throws and leaves no workspace behind', () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), 'empty-root-'));
  const before = new Set(readdirSync(tmpdir()));
  try {
    assert.throws(() => smokeTest('ts', { root: emptyRoot, timeout: 300000 }), /ENOENT|no such file|does not exist/i);
    const gained = readdirSync(tmpdir()).filter((n) => !before.has(n) && (n.includes('smoke') || n.includes('poly-demo')));
    assert.deepEqual(gained, []);
  } finally { rmSync(emptyRoot, { recursive: true, force: true }); }
});
