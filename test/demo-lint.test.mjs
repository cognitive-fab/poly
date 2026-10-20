// DF23: Act 1, part 4: what a lint sees and what it does not.
// The lint checks for idempotency keys on Stripe refund calls in TypeScript builds.
// DAC27: asserts on the lint output and exit codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// Run the lint script on a folder
function runLint(folder) {
  const result = spawnSync(process.execPath, [join(ROOT, 'demo', 'lint', 'refund-key.mjs'), folder], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('DF23: lint on ts-kept reports keyed with exit 0', () => {
  const result = runLint(join(ROOT, 'demo', 'baseline', 'runs', 'ts-kept', 'tree'));
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /stripe\.ts:46\s+keyed\s+POST \/v1\/refunds/);
  assert.match(result.stdout, /1 call\(s\) checked, 0 unkeyed, 0 undecided/);
});

test('DF23: lint on ts-kept-nokey reports unkeyed with exit 1', () => {
  const tempDir = join(tmpdir(), `demo-lint-ts-kept-nokey-${Date.now()}`);
  try {
    const srcDir = join(ROOT, 'demo', 'baseline', 'runs', 'ts-kept', 'tree', 'src');
    const tempSrcDir = join(tempDir, 'src');
    cpSync(srcDir, tempSrcDir, { recursive: true });

    // Remove EXACTLY the line whose trim() is "Idempotency-Key": idempotencyKey,
    const stripeFile = join(tempSrcDir, 'stripe.ts');
    const content = readFileSync(stripeFile, 'utf8');
    const lines = content.split('\n');
    const initialLength = lines.length;
    const filtered = lines.filter((line) => line.trim() !== '"Idempotency-Key": idempotencyKey,');
    assert.equal(filtered.length, initialLength - 1, 'Expected to remove exactly one line');
    writeFileSync(stripeFile, filtered.join('\n'));

    const result = runLint(tempDir);
    assert.equal(result.exitCode, 1, `Expected exit 1, got ${result.exitCode}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /stripe\.ts:46\s+unkeyed\s+POST \/v1\/refunds/);
    assert.match(result.stdout, /1 call\(s\) checked, 1 unkeyed, 0 undecided/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('DF23: lint on reissue fixture (fresh keys each call) reports keyed with exit 0', () => {
  const result = runLint(join(ROOT, 'test', 'fixtures', 'lint', 'reissue'));
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}`);
  assert.match(result.stdout, /1 call\(s\) checked, 0 unkeyed, 0 undecided/);
});

test('DF23: lint on headers-variable fixture reports undecided with exit 2', () => {
  const result = runLint(join(ROOT, 'test', 'fixtures', 'lint', 'headers-variable'));
  assert.equal(result.exitCode, 2, `Expected exit 2 (inconclusive), got ${result.exitCode}\nstdout: ${result.stdout}`);
  assert.match(result.stdout, /undecided/);
});

test('DF23: lint on urlforms-keyed fixture (plain, template, concat) reports 4 keyed with exit 0', () => {
  const result = runLint(join(ROOT, 'test', 'fixtures', 'lint', 'urlforms-keyed'));
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}`);
  assert.match(result.stdout, /4 call\(s\) checked, 0 unkeyed, 0 undecided/);
});

test('DF23: lint on urlforms-unkeyed fixture (plain, template, concat) reports 3 unkeyed with exit 1', () => {
  const result = runLint(join(ROOT, 'test', 'fixtures', 'lint', 'urlforms-unkeyed'));
  assert.equal(result.exitCode, 1, `Expected exit 1, got ${result.exitCode}\nstdout: ${result.stdout}`);
  assert.match(result.stdout, /3 call\(s\) checked, 3 unkeyed, 0 undecided/);
});

test('DF23: lint on no-call fixture reports inconclusive with exit 2', () => {
  const tempDir = join(tmpdir(), `demo-lint-no-call-${Date.now()}`);
  try {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'other.ts'), 'export function helper(x: number): number { return x * 2; }');
    const result = runLint(tempDir);
    assert.equal(result.exitCode, 2, `Expected exit 2 (inconclusive), got ${result.exitCode}`);
    assert.match(result.stdout, /0 call\(s\) checked/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('DF23: lint on folder with no .ts files reports inconclusive with exit 2 and not-a-TypeScript-build', () => {
  const tempDir = join(tmpdir(), `demo-lint-no-ts-${Date.now()}`);
  try {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'other.py'), 'print("hello")');
    const result = runLint(tempDir);
    assert.equal(result.exitCode, 2, `Expected exit 2 (inconclusive), got ${result.exitCode}`);
    assert.match(result.stdout, /not a TypeScript build/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
