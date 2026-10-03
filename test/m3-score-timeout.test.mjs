// A suite that runs into the scorer's timeout is a scoring failure, not an O1 result (ruling after block 39): the run
// is recorded as not scored (timeout), with no scores, and is scored again; a timeout is never counted as a failed
// test, nor skipped silently, as one on a snapshot used to be (it then dropped out of the regressions caught).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { M3 } from '../experiments/m3/lib/task.mjs';
import { runO1, scoreRun } from '../experiments/m3/runner/score.mjs';

const RUN = join(M3, 'runs', 'T1-arm1-run1');

test('a suite stopped by the timeout reports a timeout, not a result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-m3-timeout-'));
  try {
    cpSync(RUN, dir, { recursive: true });
    const impl = join(dir, 'deliveries', 'v0', 'src', 'host.impl.ts');
    const r = runO1('T1', 0, impl, 50);
    assert.equal(r.ran, false);
    assert.equal(r.timeout, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run whose scoring hits the timeout is recorded as not scored (timeout), with no scores', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-m3-timeout-run-'));
  try {
    cpSync(RUN, dir, { recursive: true });
    const record = await scoreRun(dir, { timeoutMs: 50 });
    assert.equal(record.scores, undefined);
    assert.equal(record.notScored?.reason, 'timeout');
    assert.ok(record.notScored.where.length > 0);
    const saved = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    assert.equal(saved.scores, undefined);
    assert.equal(saved.notScored.reason, 'timeout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
