// M6 step 1 (the M5 memory finding): checking the same unchanged file again keeps no memory. Measured before the fix:
// conformance/m5/refund.poly checked 200 times in one process kept about 23 KB per check after a full collection
// (36.8 MB after 25 checks, 40.8 MB after 200), because each check imported its lowered ES modules under a new
// cache-busting URL, and an ES module is never unloaded. The test checks the file 60 times in a child process and
// requires the collected heap to stay flat after a warm-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

test('M6 step 1: checking one unchanged file 60 times keeps no memory per check', { timeout: 600_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-memory-'));
  try {
    const out = join(dir, 'repeat.ndjson');
    const r = spawnSync(process.execPath, ['--expose-gc', join(ROOT, 'scripts', 'measure-check-repeat.mjs'), join(ROOT, 'conformance', 'm5', 'refund.poly'), '60', out], { cwd: ROOT, encoding: 'utf8', timeout: 540_000 });
    assert.equal(r.status, 0, r.stderr);
    const rows = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const grew = rows[60].heapMB - rows[10].heapMB;
    // 50 checks at the measured 23 KB each would keep about 1.1 MB.
    assert.ok(grew < 0.3, `the collected heap grew ${grew.toFixed(1)} MB over checks 10 to 60`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
