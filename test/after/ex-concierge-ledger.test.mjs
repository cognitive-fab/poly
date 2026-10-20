// DF19, DAC24: a refund ledger in the Desk prevents re-emission; the property no-reissue checks it
// (PS23.3, PT33.11, item 9 first paragraph): the concierge example checks CLEAN with the property
// no-reissue, not vacuous; the variant that keeps the ledger and does not consult it gives PL3002
// with a 10-step witness; the retry-safe line for payments.refund is unchanged.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from '../helpers.mjs';

const EX = join(ROOT, 'examples', 'concierge');
const POLY_CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');

/** Derives the variant by finding the `if refund == None {` line and removing the guard. */
export function deriveAmountedUnguarded(src) {
  const lines = src.split('\n');
  let ifLineIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'if refund == None {') {
      ifLineIdx = i;
      break;
    }
  }
  assert.notEqual(ifLineIdx, -1, 'Could not find "if refund == None {" in source');

  // Find the matching closing brace of the entire if-else block
  let braceDepth = 0;
  let elseLineIdx = -1;
  let endLineIdx = -1;

  for (let i = ifLineIdx; i < lines.length; i++) {
    const line = lines[i];
    for (const char of line) {
      if (char === '{') braceDepth++;
      if (char === '}') braceDepth--;
    }
    if (braceDepth === 0 && i > ifLineIdx) {
      endLineIdx = i;
      break;
    }
    if (braceDepth === 1 && !elseLineIdx && line.trim().startsWith('} else {')) {
      elseLineIdx = i;
    }
  }

  assert.notEqual(endLineIdx, -1, 'Could not find closing brace of if-else block');

  const indentMatch = lines[ifLineIdx].match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '';
  const unguardedLines = [
    `${indent}phase' = Refunding`,
    `${indent}large' = value > 100`,
    `${indent}refund' = Unknown`,
    `${indent}emit refund(amount: value, customer: customer, order: cites)`,
  ];

  const newLines = [...lines.slice(0, ifLineIdx), ...unguardedLines, ...lines.slice(endLineIdx + 1)];
  return newLines.join('\n');
}

/** Runs the checker CLI in a child process and returns the stdout. */
function runChecker(tmpDir) {
  const result = spawnSync(process.execPath, ['--max-old-space-size=8192', POLY_CLI, 'check', 'concierge.poly'], {
    cwd: tmpDir,
    encoding: 'utf8',
    timeout: 600_000,
  });
  if (result.status === null) throw new Error(`Check timed out in ${tmpDir}`);
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** Sets up a temporary directory with concierge source and supporting files. */
function setupDir(src) {
  const tmpDir = join(tmpdir(), `ledger-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'concierge.poly'), src);
  writeFileSync(join(tmpDir, 'concierge.policy.poly'), require('node:fs').readFileSync(join(EX, 'concierge.policy.poly'), 'utf8'));
  cpSync(join(EX, 'maps'), join(tmpDir, 'maps'), { recursive: true });
  cpSync(join(EX, 'prices'), join(tmpDir, 'prices'), { recursive: true });
  return tmpDir;
}

test('DF19 item 9 first paragraph: example checks CLEAN with no-reissue property (not vacuous), instance pinned', { timeout: 600_000 }, async () => {
  const src = require('node:fs').readFileSync(join(EX, 'concierge.poly'), 'utf8');
  const tmpDir = setupDir(src);
  try {
    const { stdout, status } = runChecker(tmpDir);
    assert.equal(status, 0, `Exit status is ${status}, expected 0`);

    assert.match(stdout, /verdict: CLEAN/, 'verdict is CLEAN');
    assert.match(stdout, /Desk:.*model-check CLEAN \(5762 states explored\)/, 'Desk has 5762 states');
    assert.match(stdout, /configuration support:.*81443 global states/, 'support configuration has 81443 states');
    assert.match(stdout, /retry-safe  payments\.refund  irreversible, attempts 5, keyed Idempotency-Key within 24h/, 'retry-safe line unchanged');
    assert.doesNotMatch(stdout, /vacuous: no-reissue/, 'no-reissue is not vacuous');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DF19 item 6: variant with ledger kept but not consulted gives PL3002 no-reissue with 10-step witness', { timeout: 600_000 }, async () => {
  const src = require('node:fs').readFileSync(join(EX, 'concierge.poly'), 'utf8');
  const variant = deriveAmountedUnguarded(src);
  const tmpDir = setupDir(variant);
  try {
    const { stdout, status } = runChecker(tmpDir);
    assert.equal(status, 1, `Exit status is ${status}, expected 1 (FINDINGS)`);

    assert.match(stdout, /verdict: FINDINGS/, 'verdict is FINDINGS');
    assert.match(stdout, /PL3002 STEP_PROPERTY  no-reissue/, 'PL3002 for no-reissue property found');
    assert.match(stdout, /witness \(10 steps\)/, 'witness has 10 steps');

    // Extract the witness lines to check the last action
    const witnessMatch = stdout.match(/witness \(10 steps\):([\s\S]*?)(?=\n  [a-zA-Z]|$)/);
    assert.ok(witnessMatch, 'witness section found');
    const witnessText = witnessMatch[1];
    const witnessLines = witnessText.trim().split('\n');
    assert.equal(witnessLines.length, 10, `witness has ${witnessLines.length} lines (expected 10)`);

    const lastLine = witnessLines[witnessLines.length - 1].trim();
    assert.match(lastLine, /Amounted/, 'last action is Amounted');
    assert.match(lastLine, /emits payments\.refund/, 'last step emits payments.refund');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
