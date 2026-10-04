// The freeze after M3's close (decisions-m3.md, 2026-10-04): a merge into main needs freeze.mjs --check to report no
// change for every evidence part, that is every part but `examples`, `toolchain` and `toolchain build`, which later
// milestones change. This holds for a checkout on Windows too: with core.autocrlf=true, a fresh checkout must give the
// committed bytes. The `* text=auto eol=lf` line of .gitattributes is what pins them.
//
// A confirmation test (de66918): the pin was in place before this test was written (2d91ba1), so it could not fail
// first. Its seeded control removes the eol pin from the checkout's .gitattributes and checks the files out again,
// and the same assertion must then fail on the evidence parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

const EXPECTED_TO_CHANGE = ['examples', 'toolchain', 'toolchain build'];
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=true', ...args], { encoding: 'utf8' });

/** The evidence parts freeze.mjs --check reports changed in a checkout. */
function changedEvidence(dir) {
  const r = spawnSync(process.execPath, [join(dir, 'experiments', 'm3', 'freeze.mjs'), '--check'], { cwd: dir, encoding: 'utf8', timeout: 600_000 });
  const parts = [...r.stdout.matchAll(/^part changed since the freeze: (.+)$/gm)].map((m) => m[1].trim());
  // A completed check exits 0 (no change) or 1 (changes listed); a timeout, a signal or a crash is no answer, and a
  // crash also exits 1, so its stack on stderr refuses the result (polywatch).
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.signal, null);
  assert.ok(r.status === 0 || r.status === 1, `exit ${r.status}: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Error|at .+:\d+:\d+/, r.stderr);
  return parts.filter((p) => !EXPECTED_TO_CHANGE.includes(p));
}

/** A fresh checkout of HEAD with core.autocrlf=true, sharing this repository's node_modules; removed after `f`. */
function withCheckout(f) {
  const dir = join(mkdtempSync(join(tmpdir(), 'poly-eol-')), 'tree');
  execFileSync('git', ['-C', ROOT, '-c', 'core.autocrlf=true', 'worktree', 'add', '--detach', dir, 'HEAD'], { stdio: 'ignore' });
  try {
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
    return f(dir);
  } finally {
    // A junction: unlink removes the link, never the shared node_modules it points to.
    // If the link is still there, nothing is removed: a recursive removal must never reach the shared folder.
    try { unlinkSync(join(dir, 'node_modules')); } catch { /* not created */ }
    if (existsSync(join(dir, 'node_modules'))) throw new Error(`${dir}/node_modules is still linked; the checkout is left in place`);
    execFileSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' });
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
}

test('freeze after close, seeded control: without the eol pin, a Windows checkout changes the evidence parts', { timeout: 1_200_000 }, () => {
  withCheckout((dir) => {
    const attrs = join(dir, '.gitattributes');
    const pinned = readFileSync(attrs, 'utf8');
    assert.match(pinned, /^\* text=auto eol=lf$/m);
    writeFileSync(attrs, pinned.replace(/^\* text=auto eol=lf$/m, '* text=auto'));
    // Check the experiment out again under the unpinned attributes, which git reads from the working tree.
    rmSync(join(dir, 'experiments', 'm3'), { recursive: true, force: true });
    git(dir, 'checkout', '-q', '--', 'experiments/m3');
    const changed = changedEvidence(dir);
    assert.ok(changed.length > 0, 'the unpinned checkout must change an evidence part');
  });
});

test('freeze after close: in a fresh checkout with core.autocrlf=true, every evidence part reports no change (confirmation test)', { timeout: 1_200_000 }, () => {
  withCheckout((dir) => {
    assert.deepEqual(changedEvidence(dir), []);
  });
});
