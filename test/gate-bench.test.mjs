// PT9.6, AC4 (M5a step 10): the `poly bench gate` harness, run at small sizes. The measurement itself is
// docs/m5/gate-bench.json, written by `poly bench gate --out docs/m5/gate-bench.json` at sizes 1, 8 and 64.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchGate } from '@poly/check';
import { polyaxionPeer } from '@poly/runtime';
import { ROOT } from './helpers.mjs';

const peer = polyaxionPeer();

test('the gate bench reports latency percentiles and throughput for each size, every effect allowed', async () => {
  const r = await benchGate({ repo: ROOT, sizes: [1, 3] });
  assert.deepEqual(r.sizes, [1, 3]);
  assert.deepEqual(r.throughput.runtime.map((t) => [t.instances, t.effects, t.allowed]), [[1, 2, 2], [3, 6, 6]]);
  assert.ok(r.throughput.runtime.every((t) => t.ms > 0 && t.perSecond > 0));
  assert.equal(r.program.session, 'scope:orders');
  assert.match(r.node, /^v\d+/);
  if (!peer.ok) {
    // No silent clean: without the engine the gated series is listed as not run.
    assert.match(r.throughput.session.notRun, /not available/);
    assert.match(r.latencyMs.notRun, /not available/);
    return;
  }
  assert.deepEqual(r.throughput.session.map((t) => [t.instances, t.effects, t.allowed]), [[1, 2, 2], [3, 6, 6]]);
  for (const k of ['propose', 'settle', 'path']) {
    const p = r.latencyMs[k];
    assert.equal(p.n, 8, k);
    assert.ok(p.p50 > 0 && p.p50 <= p.p99, `${k}: ${JSON.stringify(p)}`);
  }
  assert.ok(r.latencyMs.path.p50 >= r.latencyMs.propose.p50);
});

test('poly bench gate writes the report where --out says', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-bench-out-'));
  try {
    const out = join(dir, 'gate-bench.json');
    const r = spawnSync(process.execPath, [join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js'), 'bench', 'gate', '--sizes', '1', '--out', out], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(j.bench, 'gate');
    assert.deepEqual(j.sizes, [1]);
    assert.match(r.stdout, /throughput/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
