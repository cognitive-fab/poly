// The runner's cleanup after block 39 (37beede), a reported deviation from the frozen runner. Every process an arm's
// CLI starts is held in the run's job; when the run ends, and never between turns, those still running are listed as
// leftovers and ended with their trees; the workspace is deleted with retries, and a deletion that still fails is
// recorded instead of crashing the runner. A stand-in CLI leaves a process running in the workspace after each turn,
// as arm 2's backgrounded commands did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runOne } from '../experiments/m3/runner/run.mjs';
import * as checks from './m3-cleanup-checks.mjs';

const FAKE = fileURLToPath(new URL('fixtures/m3-fake-claude.mjs', import.meta.url));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Each test runs its own run number, so its workspace (poly-m3-ws/T1-arm1-run<n>) is apart from every other test file's:
// node --test runs the files at once, and the dry run uses run 0 (measured: an EPERM and an ENOENT in the full suite).
const agent = () => ({ kind: 'claude', bin: process.execPath, prefix: [FAKE] });

test('the processes an arm leaves running are ended when the run ends, listed as leftovers, and the workspace is deleted', { skip: process.platform !== 'win32' && 'Windows jobs only' }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'poly-m3-cleanup-'));
  try {
    const { record } = await runOne({ arm: 1, task: 'T1', run: 901, model: 'stub', tokens: 1_000_000, wallMs: 600_000, out, agent: agent() });
    // One leftover per turn: the four turns' backgrounded processes all ran until the run ended.
    assert.equal(record.leftovers.length, 4, JSON.stringify(record.leftovers));
    for (const p of record.leftovers) assert.equal(alive(p.pid), false, `leftover ${p.pid} is still running`);
    assert.deepEqual(record.cleanup, { ok: true });
    assert.equal(existsSync(join(tmpdir(), 'poly-m3-ws', 'T1-arm1-run901')), false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a workspace that cannot be deleted is recorded as a failed cleanup, and the runner does not crash', async () => {
  const out = mkdtempSync(join(tmpdir(), 'poly-m3-cleanup-fail-'));
  try {
    const remove = () => { const e = new Error('EPERM: operation not permitted, rmdir'); e.code = 'EPERM'; throw e; };
    const { record } = await runOne({ arm: 1, task: 'T1', run: 902, model: 'stub', tokens: 1_000_000, wallMs: 600_000, out, agent: { kind: 'stub', turns: [] }, remove, retryMs: 50 });
    assert.equal(record.cleanup.ok, false);
    assert.match(record.cleanup.error, /EPERM/);
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(join(tmpdir(), 'poly-m3-ws', 'T1-arm1-run902'), { recursive: true, force: true });
  }
});

/**
 * Runs `f` with the cap's clock started only once the stand-in CLI has signalled that it is ready (decisions-m6.md, a
 * test defect found under gate load): the runner reads Date.now for its wall cap, and until the stand-in writes its
 * marker the clock stands still, so a cap measures the CLI's run and never fires before the CLI has started. The
 * runner is frozen and untouched; the clock is the test's.
 */
async function withCapClockFromReady(f) {
  const marker = join(mkdtempSync(join(tmpdir(), 'poly-m3-ready-')), 'ready');
  const real = Date.now;
  const base = real();
  let readyAt = null;
  Date.now = () => {
    if (readyAt === null && existsSync(marker)) readyAt = real();
    return readyAt === null ? base : base + (real() - readyAt);
  };
  process.env.M3_FAKE_READY = marker;
  try {
    return await f();
  } finally {
    Date.now = real;
    delete process.env.M3_FAKE_READY;
    rmSync(dirname(marker), { recursive: true, force: true });
  }
}

test('a run a cap stops ends the CLI and everything under it, at once, and lists them as leftovers', { skip: process.platform !== 'win32' && 'Windows jobs only' }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'poly-m3-cleanup-cap-'));
  process.env.M3_FAKE_HANG = '1';
  try {
    const { record } = await withCapClockFromReady(() => runOne({ arm: 1, task: 'T1', run: 903, model: 'stub', tokens: 1_000_000, wallMs: 4_000, out, agent: agent() }));
    assert.equal(record.versions[0].stopped, 'wall');
    assert.equal(record.versions[1].attempted, false);
    // The CLI itself, its launcher and the process it left: all ended, all listed.
    assert.ok(record.leftovers.length >= 2, JSON.stringify(record.leftovers));
    for (const p of record.leftovers) assert.equal(alive(p.pid), false, `leftover ${p.pid} is still running`);
    assert.deepEqual(record.cleanup, { ok: true });
  } finally {
    delete process.env.M3_FAKE_HANG;
    rmSync(out, { recursive: true, force: true });
  }
});

// Confirmation tests for the three polywatch fixes, written after them; each has a mutant control that fails it
// (test/m3-cleanup-mutants.test.mjs).
test('a job host that cannot start fails at once, instead of leaving the run waiting', { skip: process.platform !== 'win32' && 'Windows jobs only' }, () => checks.hostFailsFast());

test('ending a job twice ends it once, and the second call waits for the same ending', { skip: process.platform !== 'win32' && 'Windows jobs only' }, () => checks.endsOnce());

test('a CLI the job cannot hold is never started, and the run is unscored, to be rerun', () => checks.unheldNeverStarts());

// Reproduction of the gate failure of 4 October (decisions-m6.md): under the gate's load the launcher had not started
// the stand-in CLI when the 4-second cap fired, so only the launcher was listed. Holding the launcher suspended for 6
// seconds once the job holds it does the same every time: it cannot start the CLI before the cap.
const SUSPEND = fileURLToPath(new URL('fixtures/suspend.ps1', import.meta.url));
const ps = (pid, action) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SUSPEND, '-ProcessId', String(pid), '-Action', action], { stdio: 'ignore' });
const slowLauncher = (ms) => async () => {
  const { openJob } = await import('../experiments/m3/runner/jobs.mjs');
  const job = await openJob();
  return { ...job, windows: job.windows, assign: async (pid) => { const ok = await job.assign(pid); ps(pid, 'suspend'); setTimeout(() => { try { ps(pid, 'resume'); } catch { /* ended by the cap */ } }, ms).unref?.(); return ok; }, leftovers: (...a) => job.leftovers(...a), end: (...a) => job.end(...a), close: (...a) => job.close(...a) };
};

test('a run a cap stops lists the CLI and what it left, even when the CLI starts after the cap would have fired', { skip: process.platform !== 'win32' && 'Windows jobs only' }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'poly-m3-cleanup-cap-slow-'));
  process.env.M3_FAKE_HANG = '1';
  try {
    const { record } = await withCapClockFromReady(() => runOne({ arm: 1, task: 'T1', run: 905, model: 'stub', tokens: 1_000_000, wallMs: 4_000, out, agent: agent(), jobs: slowLauncher(6_000) }));
    assert.equal(record.versions[0].stopped, 'wall');
    assert.ok(record.leftovers.length >= 2, JSON.stringify(record.leftovers));
    for (const p of record.leftovers) assert.equal(alive(p.pid), false, `leftover ${p.pid} is still running`);
  } finally {
    delete process.env.M3_FAKE_HANG;
    rmSync(out, { recursive: true, force: true });
  }
});
