// DF23 item 4: Mutation (c) - RefundUnknown goes to Idle.
// DAC27: asserts that the mutation script produces correct outputs and state counts.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const COMMITTED_TREE = join(ROOT, 'demo', 'baseline', 'runs', 'poly-kept', 'tree');
const COMMITTED_SUPPORT = join(COMMITTED_TREE, 'src', 'support.poly');

let outDir;
let scriptOutput = { stdout: '', stderr: '', exitCode: null };
let committedTreeHashBefore;

// Compute hash of committed tree: sorted list of relative paths and file bytes, excluding node_modules.
function hashCommittedTree() {
  const hash = createHash('sha256');

  function walk(dir, relative = '') {
    const entries = readdirSync(dir).sort();
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.poly') continue; // .poly is the checker's own build output, rewritten by the checks of the other tests
      const fullPath = join(dir, entry);
      const relPath = relative ? join(relative, entry) : entry;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath, relPath);
      } else {
        hash.update(relPath);
        hash.update(readFileSync(fullPath));
      }
    }
  }

  walk(COMMITTED_TREE);
  return hash.digest('hex');
}

// Derive the property text by exact string substitutions.
export function withNoReissueProperty(text) {
  let result = text;
  let subCount = 0;

  // Insert issued field after phase field
  const phaseLineAnchor = '    phase    : Phase           = New';
  const issuedLine = '    issued   : map<0..3, bool> = [false, false, false, false]';
  if (result.includes(phaseLineAnchor)) {
    subCount++;
    result = result.replace(phaseLineAnchor, phaseLineAnchor + '\n' + issuedLine);
  } else {
    throw new Error('Anchor for issued field not found exactly once');
  }

  // In Confirm handler, after phase' = Refunding, insert issued' update
  const confirmAnchor = 'require phase == Confirming else reject "nothing-to-confirm"\n    phase\' = Refunding\n    emit refund(';
  if (result.includes(confirmAnchor)) {
    subCount++;
    const replacement = confirmAnchor.replace(
      '    phase\' = Refunding\n    emit refund(',
      '    phase\' = Refunding\n    issued\' = [issued[0] || want[0], issued[1] || want[1], issued[2] || want[2], issued[3] || want[3]]\n    emit refund('
    );
    result = result.replace(confirmAnchor, replacement);
  } else {
    throw new Error('Anchor for Confirm issued update not found exactly once');
  }

  // In RefundFailed, after phase' = Idle, insert issued' update
  const refundFailedAnchor = '  on RefundFailed {\n    require phase == Refunding else reject "not-refunding"\n    phase\' = Idle';
  if (result.includes(refundFailedAnchor)) {
    subCount++;
    result = result.replace(
      refundFailedAnchor,
      refundFailedAnchor + '\n    issued\' = [issued[0] && !want[0], issued[1] && !want[1], issued[2] && !want[2], issued[3] && !want[3]]'
    );
  } else {
    throw new Error('Anchor for RefundFailed issued update not found exactly once');
  }

  // In Resolve's else branch, after phase' = Idle, insert issued' update
  const resolveAnchor = '    } else {\n      phase\' = Idle\n      emit say(msg: RefundFailed';
  if (result.includes(resolveAnchor)) {
    subCount++;
    result = result.replace(
      resolveAnchor,
      '    } else {\n      phase\' = Idle\n      issued\' = [issued[0] && !want[0], issued[1] && !want[1], issued[2] && !want[2], issued[3] && !want[3]]\n      emit say(msg: RefundFailed'
    );
  } else {
    throw new Error('Anchor for Resolve else issued update not found exactly once');
  }

  // Before "// No line is ever refunded twice.", insert the four never clauses
  const neverAnchor = '  // No line is ever refunded twice.';
  if (result.includes(neverAnchor)) {
    subCount++;
    const neverClauses = '  never no-reissue-0: emit refund(l0: true) while issued[0]\n  never no-reissue-1: emit refund(l1: true) while issued[1]\n  never no-reissue-2: emit refund(l2: true) while issued[2]\n  never no-reissue-3: emit refund(l3: true) while issued[3]\n\n';
    result = result.replace(neverAnchor, neverClauses + neverAnchor);
  } else {
    throw new Error('Anchor for never clauses not found exactly once');
  }

  if (subCount !== 5) {
    throw new Error(`Expected 5 substitutions, made ${subCount}`);
  }

  return result;
}

// Setup: run the mutation script once before all tests
before(() => {
  // Hash committed tree BEFORE running script
  committedTreeHashBefore = hashCommittedTree();

  outDir = join(tmpdir(), `demo-mutation-c-${Date.now()}`);
  const result = spawnSync(process.execPath, [
    join(ROOT, 'demo', 'scripts', 'make-mutation-c.mjs'),
    outDir,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  scriptOutput = { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status };
});

function runChecker(folder) {
  const result = spawnSync(process.execPath, [
    join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js'),
    'check',
    'src/support.poly',
  ], {
    cwd: folder,
    encoding: 'utf8',
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('DF23 item 4: make-mutation-c.mjs leaves the committed tree unchanged', () => {
  // Assert script exited 0
  assert.equal(scriptOutput.exitCode, 0, `script exited ${scriptOutput.exitCode}\nstderr: ${scriptOutput.stderr}`);

  // Hash committed tree AFTER running script
  const committedTreeHashAfter = hashCommittedTree();
  assert.equal(committedTreeHashAfter, committedTreeHashBefore, 'committed tree must be unchanged');
});

test('DF23 item 4: poly-kept-reissue checks CLEAN with 161 states', () => {
  const folder = join(outDir, 'poly-kept-reissue');
  const result = runChecker(folder);
  assert.equal(result.exitCode, 0, `checker failed with exit ${result.exitCode}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /verdict: CLEAN/, 'verdict should be CLEAN');
  // Assert (161 states explored) on Ticket line specifically
  assert.match(result.stdout, /^Ticket:.*model-check CLEAN \(161 states explored\)/m, 'Ticket line should have 161 states');
});

test('DF23 item 4: poly-kept-reissue-checked has four PL3002 no-reissue findings with 6-step witnesses', () => {
  const folder = join(outDir, 'poly-kept-reissue-checked');
  const result = runChecker(folder);
  assert.equal(result.exitCode, 1, `checker should exit 1 for FINDINGS, got ${result.exitCode}`);
  assert.match(result.stdout, /verdict: FINDINGS/, 'verdict should be FINDINGS');

  const lines = result.stdout.split('\n');

  // Find each finding and verify its witness
  for (let i = 0; i < 4; i++) {
    const findingIdx = lines.findIndex((l) => l.includes(`PL3002`) && l.includes(`no-reissue-${i}`));
    assert.ok(findingIdx >= 0, `no-reissue-${i} finding should exist`);

    // Assert the violated clause line in the next few lines
    const violatedFound = lines.slice(findingIdx, findingIdx + 3).some((l) => l.includes(`never no-reissue-${i} is violated by Confirm`));
    assert.ok(violatedFound, `no-reissue-${i} should have violated by Confirm line`);

    // Find the witness block (starting after witness (6 steps) line)
    let witnessBlockStart = -1;
    for (let j = findingIdx; j < Math.min(findingIdx + 10, lines.length); j++) {
      if (/witness \(6 steps\)/.test(lines[j])) {
        witnessBlockStart = j + 1;
        break;
      }
    }
    assert.ok(witnessBlockStart >= 0, `no-reissue-${i} should have witness (6 steps) line`);

    // Read the 6 witness lines (all indented)
    const expectedActions = ['Open', 'RequestAll', 'Confirm', 'RefundUnknown', 'RequestAll', 'Confirm'];
    for (let j = 0; j < 6; j++) {
      const witnessLine = lines[witnessBlockStart + j];
      assert.ok(witnessLine && witnessLine.startsWith('    '), `witness line ${j} should be indented`);

      // Extract first word from witness line (trim, then split on space or paren)
      const trimmed = witnessLine.trim();
      const firstWord = trimmed.split(/[\s(]/)[0];
      assert.equal(firstWord, expectedActions[j], `step ${j} should start with ${expectedActions[j]}`);
    }
  }
});

test('DF23 item 4: unchanged tree plus property checks CLEAN with 226 states', () => {
  const tempDir = join(tmpdir(), `demo-mutation-c-prop-${Date.now()}`);
  try {
    mkdirSync(join(tempDir, 'src'), { recursive: true });

    // Read committed source
    const committedSource = readFileSync(COMMITTED_SUPPORT, 'utf8');
    const committedJson = readFileSync(join(COMMITTED_TREE, 'poly.json'), 'utf8');

    // Write committed tree files to temp
    writeFileSync(join(tempDir, 'src', 'support.poly'), committedSource);
    writeFileSync(join(tempDir, 'poly.json'), committedJson);

    // Copy any existing src/*.js files
    const srcDir = join(COMMITTED_TREE, 'src');
    for (const file of readdirSync(srcDir)) {
      if (file.endsWith('.js')) {
        const srcPath = join(srcDir, file);
        if (statSync(srcPath).isFile()) {
          writeFileSync(join(tempDir, 'src', file), readFileSync(srcPath));
        }
      }
    }

    // Apply property text
    const textWithProperty = withNoReissueProperty(committedSource);
    writeFileSync(join(tempDir, 'src', 'support.poly'), textWithProperty);

    // Run checker
    const result = runChecker(tempDir);
    assert.equal(result.exitCode, 0, `checker failed with exit ${result.exitCode}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /verdict: CLEAN/, 'verdict should be CLEAN');
    assert.match(result.stdout, /model-check CLEAN \(226 states explored\)/, 'should have 226 states');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('DF23 item 4: poly-kept-reissue/src/support.poly is RefundUnknown mutation exactly', () => {
  const committedSource = readFileSync(COMMITTED_SUPPORT, 'utf8');

  // Derive expected mutated text: replace phase' = Review with phase' = Idle and want' cleared
  const refundUnknownAnchor = 'on RefundUnknown {\n    require phase == Refunding else reject "not-refunding"\n    phase\' = Review';
  if (!committedSource.includes(refundUnknownAnchor)) {
    throw new Error('RefundUnknown anchor for mutation not found exactly once');
  }

  const expectedMutated = committedSource.replace(
    refundUnknownAnchor,
    'on RefundUnknown {\n    require phase == Refunding else reject "not-refunding"\n    phase\' = Idle\n    want\' = [false, false, false, false]'
  );

  // Count occurrences to ensure exactly one
  const anchorCount = (committedSource.match(/phase' = Review/g) || []).length;
  assert.equal(anchorCount, 1, 'RefundUnknown should have exactly one phase = Review to mutate');

  // Read actual mutated file
  const mutatedPath = join(outDir, 'poly-kept-reissue', 'src', 'support.poly');
  const actual = readFileSync(mutatedPath, 'utf8');

  assert.equal(actual, expectedMutated, 'poly-kept-reissue/src/support.poly should equal mutated text exactly');
});

test('DF23 item 4: poly-kept-reissue-checked/src/support.poly is mutation plus property exactly', () => {
  const committedSource = readFileSync(COMMITTED_SUPPORT, 'utf8');

  // Derive RefundUnknown mutation
  const refundUnknownAnchor = 'on RefundUnknown {\n    require phase == Refunding else reject "not-refunding"\n    phase\' = Review';
  const mutated = committedSource.replace(
    refundUnknownAnchor,
    'on RefundUnknown {\n    require phase == Refunding else reject "not-refunding"\n    phase\' = Idle\n    want\' = [false, false, false, false]'
  );

  // Apply property to mutated text
  const expectedChecked = withNoReissueProperty(mutated);

  // Read actual file
  const checkedPath = join(outDir, 'poly-kept-reissue-checked', 'src', 'support.poly');
  const actual = readFileSync(checkedPath, 'utf8');

  assert.equal(actual, expectedChecked, 'poly-kept-reissue-checked/src/support.poly should equal mutation + property exactly');
});

test('DF23 item 4: all other files in mutations are byte-identical to committed', () => {
  const mutations = [
    join(outDir, 'poly-kept-reissue'),
    join(outDir, 'poly-kept-reissue-checked'),
  ];

  for (const mutationPath of mutations) {
    // Walk the committed tree (skip src/support.poly)
    function walkAndCompare(dir, relative = '') {
      const entries = readdirSync(dir).sort();
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === '.poly') continue; // .poly is the checker's own build output, rewritten by the checks of the other tests
        const fullCommitted = join(dir, entry);
        const fullMutation = join(mutationPath, relative, entry);
        const relPath = relative ? join(relative, entry) : entry;

        const stat = statSync(fullCommitted);
        if (stat.isDirectory()) {
          walkAndCompare(fullCommitted, relPath);
        } else {
          // Skip src/support.poly (tested separately)
          if (relPath === join('src', 'support.poly')) continue;

          const committedBytes = readFileSync(fullCommitted);
          const mutationBytes = readFileSync(fullMutation);
          assert.deepEqual(mutationBytes, committedBytes, `${relPath} should be byte-identical`);
        }
      }
    }

    walkAndCompare(COMMITTED_TREE);

    // Assert no extra files in mutation
    function walkMutation(dir, relative = '') {
      const entries = readdirSync(dir).sort();
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === '.poly') continue; // .poly is the checker's own build output, rewritten by the checks of the other tests
        const fullMutation = join(dir, entry);
        const fullCommitted = join(COMMITTED_TREE, relative, entry);
        const relPath = relative ? join(relative, entry) : entry;

        const stat = statSync(fullMutation);
        if (stat.isDirectory()) {
          walkMutation(fullMutation, relPath);
        } else {
          // Check committed tree has this file
          assert.ok(statSync(fullCommitted, { throwIfNoEntry: false })?.isFile(), `${relPath} should exist in committed tree`);
        }
      }
    }

    walkMutation(mutationPath);
  }
});
