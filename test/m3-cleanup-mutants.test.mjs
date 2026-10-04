// Mutant controls for the three confirmation tests of the runner's job (polywatch on 37beede). Each mutant is a copy
// of experiments/m3/runner with one fix reverted, beside the runner so its imports resolve; the confirmation check
// that passes on the runner must fail on its mutant. The copy is removed afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as checks from './m3-cleanup-checks.mjs';

/** A copy of the runner beside it, with `edits` ([file, before, after]) applied; each `before` must occur once. */
function mutant(name, edits) {
  const dir = join(checks.RUNNER, '..', `runner-mutant-${name}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(checks.RUNNER, dir, { recursive: true });
  for (const [file, before, after] of edits) {
    const p = join(dir, file);
    const s = readFileSync(p, 'utf8');
    assert.equal(s.split(before).length, 2, `${name}: ${file} does not hold the line the mutant reverts`);
    writeFileSync(p, s.split(before).join(after));
  }
  return dir;
}

const windows = { skip: process.platform !== 'win32' && 'Windows jobs only' };

test('mutant control: without the host failure handling, a job host that cannot start does not fail as a job host', windows, async () => {
  const dir = mutant('host', [['jobs.mjs',
    "lines.on('line', (l) => { try { JSON.parse(l); } catch { fail(`the job host said: ${l.slice(0, 200)}`); host.kill(); return; } queue.shift()?.(l); });",
    "lines.on('line', (l) => queue.shift()?.(l));"]]);
  try {
    // The mutant fails by an exception thrown in its event handler, outside the check's promise, so the check runs in
    // its own process: it passes there only by exiting 0.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const code = `import(${JSON.stringify(pathToFileURL(join(checks.RUNNER, '..', '..', '..', 'test', 'm3-cleanup-checks.mjs')).href)}).then((c) => c.hostFailsFast(${JSON.stringify(dir)})).then(() => process.exit(0), (e) => { console.error(String(e)); process.exit(1); });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env, timeout: 120_000 });
    assert.equal(r.status, 1, `the check passed on the mutant, or did not run: ${r.stdout}${r.stderr}`);
    // It fails for the reverted fix: the host's own words reach the JSON parser.
    assert.match(r.stdout + r.stderr, /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mutant control: without the cached ending, a second end does not wait for the same ending', windows, async () => {
  const dir = mutant('end', [['jobs.mjs', 'end: () => (ending ??= (async () => {', 'end: () => ((async () => {']]);
  try {
    // It fails for the reverted fix: the two calls do not share one ending.
    await assert.rejects(checks.endsOnce(dir), { code: 'ERR_ASSERTION' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mutant control: starting the CLI although the job could not hold it fails the check', async () => {
  const dir = mutant('assign', [['agent.mjs', "        } else child.stdin.end('go\\n');", "        }\n        child.stdin.end('go\\n');"], ['agent.mjs', "          state.stopped = 'job';\n          child.kill();", "          state.stopped = 'job';"]]);
  try {
    // It fails for the reverted fix: the stop is still recorded, but the CLI is started.
    await assert.rejects(checks.unheldNeverStarts(dir, 1000 + process.pid), /the CLI was started/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
