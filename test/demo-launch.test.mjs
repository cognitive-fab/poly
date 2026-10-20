// Step 9 (DF6, DF7): the launcher's light parts. A live launch is refused while the price tables are placeholders, before it reads
// a key or opens a socket; the live transport reaches the model provider's host alone; the arguments are strict. The heavy part (the
// demo copy admitted and driven) is the recorded run in test/after/demo-concierge-e2e.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleDemo, LaunchRefused } from '../demo/host/assemble.mjs';
import { liveTransport } from '../demo/host/live-transport.mjs';
import { parseArgs } from '../demo/launch.mjs';

test('DF6: a live launch is refused on placeholder price tables, before a key is looked at or a socket opened', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'demo-launch-'));
  let touched = 0;
  const modelTransport = { async request() { touched++; return { status: 200, headers: {}, body: '{}' }; } };
  try {
    await assert.rejects(assembleDemo({ mode: 'live', workdir, apiKey: 'a-placeholder-key-for-the-test', modelTransport }), (e) => e instanceof LaunchRefused && /placeholder host \(example\.com\)/.test(e.message) && !e.message.includes('a-placeholder-key'));
    assert.equal(touched, 0);
  } finally { rmSync(workdir, { recursive: true, force: true }); }
});

test('DF6: the live transport reaches the model provider alone: any other host is refused before a socket is opened', async () => {
  const t = liveTransport();
  for (const url of ['https://example.com/v1/messages', 'https://api.stripe.com/v1/refunds', 'http://api.anthropic.com/v1/messages', 'not a url', 'https://api.anthropic.com.evil.example/v1/messages']) {
    await assert.rejects(t.request({ method: 'POST', url, headers: {}, body: '{}' }), /no route/, url);
  }
});

test('DF7: the launcher\'s arguments are strict: recorded is the default, live is named, and an unknown flag or a bad port is refused', () => {
  assert.deepEqual(parseArgs([]), { mode: 'recorded', port: 8080, lan: false, size: 40, standInFault: null });
  assert.deepEqual(parseArgs(['--live', '--cap-usd', '5', '--port', '9000', '--lan']), { mode: 'live', port: 9000, lan: true, size: 40, standInFault: null, capUsd: 5 });
  assert.equal(parseArgs(['--recorded']).mode, 'recorded');
  assert.throws(() => parseArgs(['--port', 'abc']), /port/);
  assert.throws(() => parseArgs(['--port', '70000']), /port/);
  assert.throws(() => parseArgs(['--nope']), /unknown/);
  assert.throws(() => parseArgs(['--live', '--recorded']), /either/);
});

// DF26, DAC30: the launcher gives itself 8 GB of heap when it runs with less.
test('DF26: heapArgsFor(4288, {}) returns max-old-space-size=8192', async () => {
  const { heapArgsFor } = await import('../demo/launch.mjs');
  const result = heapArgsFor(4288, {});
  assert.deepEqual(result, ['--max-old-space-size=8192']);
});

test('DF26: heapArgsFor(6999, {}) returns max-old-space-size=8192', async () => {
  const { heapArgsFor } = await import('../demo/launch.mjs');
  const result = heapArgsFor(6999, {});
  assert.deepEqual(result, ['--max-old-space-size=8192']);
});

test('DF26: heapArgsFor(7000, {}) returns empty', async () => {
  const { heapArgsFor } = await import('../demo/launch.mjs');
  const result = heapArgsFor(7000, {});
  assert.deepEqual(result, []);
});

test('DF26: heapArgsFor(8192, {}) returns empty', async () => {
  const { heapArgsFor } = await import('../demo/launch.mjs');
  const result = heapArgsFor(8192, {});
  assert.deepEqual(result, []);
});

test('DF26: heapArgsFor(4288, { POLY_DEMO_HEAP_REEXEC: "1" }) returns empty', async () => {
  const { heapArgsFor } = await import('../demo/launch.mjs');
  const result = heapArgsFor(4288, { POLY_DEMO_HEAP_REEXEC: '1' });
  assert.deepEqual(result, []);
});

// DF26, DAC30: the serial suite runs with 8 GB of heap via env-file.
test('DF26: package.json test script has --env-file for serial tests, parallel tests lack it, and the env file holds NODE_OPTIONS', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const testDir = dirname(fileURLToPath(import.meta.url));
  const packagePath = join(testDir, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
  const testScript = pkg.scripts.test;

  // Find the command with test/after/*.test.mjs
  const afterMatch = testScript.match(/[^&]*test\/after\/\*\.test\.mjs[^&]*/);
  assert(afterMatch, 'test script should contain a command with test/after/*.test.mjs');
  const afterCommand = afterMatch[0];
  assert(afterCommand.includes('--env-file=test/fixtures/serial-heap.env'), 'command with test/after/*.test.mjs should include --env-file=test/fixtures/serial-heap.env');

  // Find the command with "test/*.test.mjs" (exact pattern)
  const parallelMatch = testScript.match(/[^&]*"test\/\*\.test\.mjs"[^&]*/);
  assert(parallelMatch, 'test script should contain a command with "test/*.test.mjs"');
  const parallelCommand = parallelMatch[0];
  assert(!parallelCommand.includes('--env-file'), 'command with "test/*.test.mjs" should not include --env-file');

  // Verify both were found exactly once
  const afterCount = (testScript.match(/test\/after\/\*\.test\.mjs/g) || []).length;
  const parallelCount = (testScript.match(/"test\/\*\.test\.mjs"/g) || []).length;
  assert.equal(afterCount, 1, 'test/after/*.test.mjs should appear exactly once');
  assert.equal(parallelCount, 1, '"test/*.test.mjs" should appear exactly once');

  // Read and verify the env file
  const envPath = join(testDir, '..', 'test', 'fixtures', 'serial-heap.env');
  const envContent = readFileSync(envPath, 'utf-8');
  const envLines = envContent.split('\n').filter(line => line.trim().length > 0);
  assert(envLines.includes('NODE_OPTIONS=--max-old-space-size=8192'), 'serial-heap.env should contain the line NODE_OPTIONS=--max-old-space-size=8192');
});
