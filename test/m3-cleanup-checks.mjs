// The three confirmation checks of the runner's job (polywatch on 37beede), written after their fixes. Each takes the
// runner directory to test, so the same check runs on the runner and on a mutant of it that reverts the fix
// (test/m3-cleanup-mutants.test.mjs): a check that passes on the runner and fails on its mutant tests the fix.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RUNNER = fileURLToPath(new URL('../experiments/m3/runner/', import.meta.url));
const FAKE = fileURLToPath(new URL('fixtures/m3-fake-claude.mjs', import.meta.url));
const load = (dir, file) => import(pathToFileURL(join(dir, file)).href);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Fails a check that has not settled within `ms`: a hang is a failure, not a wait. */
const within = (ms, p) => { let timer; return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer)); };

/** A job host that cannot start fails at once, naming the job host, instead of leaving the run waiting. */
export async function hostFailsFast(dir = RUNNER) {
  const { openJob } = await load(dir, 'jobs.mjs');
  await within(30_000, assert.rejects(openJob({ host: join(tmpdir(), 'no-such-jobhost.ps1') }), /job host/));
}

/** Ending a job twice ends it once: the second call waits for the same ending and gets the same list. */
export async function endsOnce(dir = RUNNER) {
  const { openJob } = await load(dir, 'jobs.mjs');
  const job = await openJob();
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    assert.equal(await job.assign(p.pid), true);
    const [a, b] = await Promise.all([job.end(), job.end()]);
    assert.equal(a, b);
    assert.deepEqual(a.map((x) => x.pid), [p.pid]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(alive(p.pid), false);
  } finally {
    if (alive(p.pid)) p.kill();
    job.close();
  }
}

/** A CLI the job cannot hold is never started; the run stops as `job` and is recorded unscored, to be rerun. */
// `run` keeps the workspace apart from that of a concurrent test file, and from a leftover of an earlier mutant.
export async function unheldNeverStarts(dir = RUNNER, run = 904) {
  const { runOne } = await load(dir, 'run.mjs');
  const out = mkdtempSync(join(tmpdir(), 'poly-m3-cleanup-nojob-'));
  try {
    const jobs = async () => ({ windows: true, assign: async () => false, end: async () => [], close: () => {} });
    const { record } = await runOne({ arm: 1, task: 'T1', run, model: 'stub', tokens: 1_000_000, wallMs: 600_000, out, agent: { kind: 'claude', bin: process.execPath, prefix: [FAKE] }, jobs, retryMs: 2_000 });
    assert.equal(record.versions[0].stopped, 'job');
    assert.equal(record.unscored, "the run's job could not hold its CLI");
    assert.equal(record.versions[1].attempted, false);
    // The CLI never ran: the journal holds no event of its stream.
    const journal = readFileSync(join(out, `T1-arm1-run${run}`, 'journal.jsonl'), 'utf8');
    assert.equal(journal.split(/\r?\n/).filter((l) => l.includes('"type":"stream"')).length, 0, 'the CLI was started');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
