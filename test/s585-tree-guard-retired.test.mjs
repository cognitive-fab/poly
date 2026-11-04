// S585 (decisions-m4.md, owner, 2026-11-03): M4-0 is retired and the tree guard with it. No path is the experiment's
// tree, `main` takes every kind of work, `scripts/tree-guard.mjs` is deleted, and no script under `scripts/` imports it,
// calls `assertNotExperimentTree`, or refuses to run because of the path or the branch of its checkout. This file
// replaces `test/tree-guard.test.mjs`, which tested the retired rule. Written under rule 7a by a separate writer, from
// the ruling alone.
//
// What these tests do not prove: that a checkout whose top level is `C:\Users\jjdub\code\poly` runs the scripts. That
// path cannot be built in a temporary folder. The static scan and the absence of `tree-guard.mjs` cover it structurally,
// and the in-place run below exercises it only when the suite itself runs from that checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

const SCRIPTS = join(ROOT, 'scripts');
// The strings the retired guard refused with, as the brief of this test names them.
const REFUSAL = /experiment's tree|which takes only M3 work/;
// S585 ruling 2: each script that called the guard is otherwise unchanged, so each one still exists.
const FORMER_CALLERS = ['bench-check-speed', 'build-outbox-models', 'ex-gmail-traffic', 'measure-check-memory', 'measure-check-repeat', 'measure-check-stages', 'measure-verdicts', 'pin-model-digests', 'pin-polycheck', 'pin-std-digests', 'publish-schemas', 'suite-summary', 'vendor-polyaxion'];

function mjsUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...mjsUnder(p));
    else if (p.endsWith('.mjs')) out.push(p);
  }
  return out.sort();
}

// The parent's environment without any GIT_* variable, so git in the child acts on the folder it is given; POLY_NO_CACHE
// from the home-guard preload still reaches the child.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV, timeout: 60_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A checkout outside ROOT whose current branch is `branch`, born (it has a commit), holding a copy of this tree's
 * `scripts/` and a junction to ROOT's `node_modules`. The scripts resolve their root from their own location, so a
 * copy run from here is judged by this checkout's path and branch, not by ROOT's. A shared clone without a checkout
 * gives a real branch with no commit made in a fixture.
 */
function withCheckout(branch, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'poly-s585-'));
  const repo = join(dir, 'repo');
  const link = join(repo, 'node_modules');
  try {
    git(dir, 'clone', '--quiet', '--shared', '--no-checkout', ROOT, repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', `refs/heads/${branch}`, head);
    git(repo, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
    assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), branch);
    cpSync(SCRIPTS, join(repo, 'scripts'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules'), link, 'junction');
    return fn(repo, dir);
  } finally {
    // The junction is removed first so the cleanup never reaches ROOT's node_modules through it.
    if (existsSync(link)) unlinkSync(link);
    rmSync(dir, { recursive: true, force: true });
  }
}

function node(args, cwd) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: ENV, timeout: 120_000 });
}

test('S585 ruling 2: scripts/tree-guard.mjs is deleted', () => {
  assert.equal(existsSync(join(SCRIPTS, 'tree-guard.mjs')), false, 'scripts/tree-guard.mjs still exists');
});

test('S585 ruling 2: no script under scripts/ imports the guard, calls assertNotExperimentTree, or carries its refusal', () => {
  const found = [];
  for (const f of mjsUnder(SCRIPTS)) {
    const text = readFileSync(f, 'utf8');
    const name = relative(ROOT, f).replace(/\\/g, '/');
    if (/tree-guard/.test(text)) found.push(`${name} names tree-guard`);
    if (/assertNotExperimentTree/.test(text)) found.push(`${name} names assertNotExperimentTree`);
    if (REFUSAL.test(text)) found.push(`${name} carries the refusal text`);
  }
  assert.deepEqual(found, []);
});

// A regression guard, not a test of the change: it passes on the old tree. Ruling 2 removes the guard from these
// scripts and leaves each of them otherwise in place.
test('S585 ruling 2: every script that called the guard is still there', () => {
  const missing = FORMER_CALLERS.filter((s) => !existsSync(join(SCRIPTS, `${s}.mjs`)));
  assert.deepEqual(missing, []);
});

// Proves the branch half of ruling 1: a checkout on `main` outside ROOT gets past the point where the guard stood. The
// script exits at its own usage line (64), which it reaches only after the line that called the guard. Does not prove
// anything about the path `C:\Users\jjdub\code\poly`.
test('S585 ruling 1: on a checkout whose branch is main, two former callers reach their usage line', () => {
  withCheckout('main', (repo) => {
    for (const [script, usage] of [
      ['measure-check-stages.mjs', /usage: node scripts\/measure-check-stages\.mjs <file\.poly>/],
      ['measure-check-repeat.mjs', /usage: node --expose-gc scripts\/measure-check-repeat\.mjs/],
    ]) {
      const r = node(['--expose-gc', join(repo, 'scripts', script)], repo);
      assert.doesNotMatch(r.stderr, REFUSAL, `${script} refused on main: ${r.stderr}`);
      assert.equal(r.status, 64, `${script} on main: status ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, usage);
    }
  });
});

// Proves that a script which writes files runs to its end on `main` and writes them: one check of a conformance source,
// its row written to a file in the temporary folder. This is what M4-0 forbade on `main`.
test('S585 ruling 1: on a checkout whose branch is main, measure-check-repeat runs and writes its rows', () => {
  withCheckout('main', (repo, dir) => {
    const out = join(dir, 'repeat.ndjson');
    const r = node(['--expose-gc', join(repo, 'scripts', 'measure-check-repeat.mjs'), join(ROOT, 'conformance', 'm5', 'refund.poly'), '1', out], repo);
    assert.doesNotMatch(r.stderr, REFUSAL, `refused on main: ${r.stderr}`);
    assert.equal(r.status, 0, r.stderr);
    const rows = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(rows.length >= 1, 'no row was written');
  });
});

// The harness control: the same copy and the same run on a branch that is not `main`. It passes on the old tree as on
// the new one, so a failure of the two tests above on the old tree is the guard, not the junction, module resolution or
// the conformance source.
test('S585 control: on a checkout whose branch is not main, the same harness runs measure-check-repeat', () => {
  withCheckout('s585-control', (repo, dir) => {
    const out = join(dir, 'repeat.ndjson');
    const r = node(['--expose-gc', join(repo, 'scripts', 'measure-check-repeat.mjs'), join(ROOT, 'conformance', 'm5', 'refund.poly'), '1', out], repo);
    assert.equal(r.status, 0, r.stderr);
    const rows = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(rows.length >= 1, 'no row was written');
  });
});

// The checkout this suite runs in is allowed, whatever its path and branch. In a worktree off `main` this passes on the
// old tree too; it bites when the suite runs from the `main` checkout at `C:\Users\jjdub\code\poly`, which is where the
// v1.5.1 release run failed (S585, "What was found").
test('S585 ruling 1: the checkout this suite runs in reaches a former caller\'s usage line', () => {
  const r = node([join(SCRIPTS, 'measure-check-stages.mjs')], ROOT);
  assert.doesNotMatch(r.stderr, REFUSAL, `refused in ${ROOT}: ${r.stderr}`);
  assert.equal(r.status, 64, r.stderr);
  assert.match(r.stderr, /usage: node scripts\/measure-check-stages\.mjs <file\.poly>/);
});
