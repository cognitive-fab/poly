// The gate gives the same answer whatever state the owner's M3 account is in. The M3 runner reads its arms' folder
// from the home directory (`~/.poly-m3/claude`, isolation.mjs), so a test that reached it read the owner's live
// account: on 2 October the account held plugins and skills folders, and the m4 gate failed for that reason alone
// (plan-m5.md section 11). This test runs every test file that loads the runner with the home directory pointed at a
// stand-in folder it creates, once with an account the runner refuses and once with none, and requires each run to
// pass. A test that reaches the live account fails here whatever the live account holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { ROOT } from './helpers.mjs';

/** The test files that load the M3 runner, found by what they import, so a new one is covered too. */
function runnerTests() {
  const dir = join(ROOT, 'test');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.mjs') && f !== 'account-independence.test.mjs')
    .filter((f) => /runner[/'", ]+(run|isolation|agent)\.mjs|runner\/(run|isolation|agent)\.mjs/.test(readFileSync(join(dir, f), 'utf8')))
    .map((f) => join('test', f));
}

/**
 * Runs the files with the home directory at `home`, from a working directory inside the stand-in: with the home moved,
 * PowerShell (which the runner's job objects start) writes its module cache relative to the working directory, and
 * that must not land in the repository. Returns the summary counts and the output.
 */
function runAt(home, files) {
  // Its own temporary directory too: the runner's tests share folders under it, and the gate runs those same files
  // beside this one (measured without it: 3 failures that no run has alone).
  const temp = join(home, 'tmp');
  mkdirSync(temp, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, TMPDIR: temp };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((done) => {
    const p = spawn(process.execPath, ['--test', ...files.map((f) => join(ROOT, f))], { cwd: home, env });
    let out = '';
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { out += b; });
    // Polywatch: a child that hangs is killed, and its run fails, before the test's own timeout.
    const timer = setTimeout(() => { out += '\nkilled: the run did not finish in 10 minutes\n'; p.kill(); }, 600_000);
    p.on('close', (status) => {
      clearTimeout(timer);
      const count = (k) => Number((out.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')) ?? [])[1] ?? NaN);
      done({ status, tests: count('tests'), fail: count('fail'), out });
    });
  });
}

test('the tests that load the M3 runner pass whatever the M3 account holds, or with no account at all', { timeout: 1_200_000 }, async () => {
  const files = runnerTests();
  assert.ok(files.includes(join('test', 'm3-runner.test.mjs')), files.join(', '));
  const base = mkdtempSync(join(tmpdir(), 'poly-account-'));
  try {
    // An account the runner refuses: what the owner's account held on 2 October, and a CLAUDE.md.
    const refused = join(base, 'refused');
    const arms = join(refused, '.poly-m3', 'claude');
    for (const d of ['plugins', 'skills']) mkdirSync(join(arms, d), { recursive: true });
    writeFileSync(join(arms, 'CLAUDE.md'), 'a stand-in the runner must refuse\n');
    // No account at all.
    const none = join(base, 'none');
    mkdirSync(none, { recursive: true });
    // Each run has its own temporary directory, so the two run side by side.
    const results = await Promise.all([refused, none].map((home) => runAt(home, files)));
    for (const [home, r] of [[refused, results[0]], [none, results[1]]]) {
      assert.ok(r.tests > 0, `${home}: no test ran\n${r.out.slice(-2000)}`);
      assert.equal(r.fail, 0, `${home}: ${r.fail} failed\n${r.out.split('\n').filter((l) => /^✖|AssertionError|needs the freeze|isolation:/.test(l)).slice(0, 20).join('\n')}`);
      // Polywatch: a cancelled test or a killed run exits non-zero with no failure counted.
      assert.equal(r.status, 0, `${home}: the run exited ${r.status}\n${r.out.slice(-2000)}`);
    }
    assert.equal(results[0].tests, results[1].tests);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
