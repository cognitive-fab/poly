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
