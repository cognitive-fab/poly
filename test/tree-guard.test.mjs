// The tree guard (M4-0): an M4 script that writes files refuses to run in the experiment's tree or on `main`.
// Both conditions are tested: the path through `treeProblem`, the branch through a real clone checked out on
// `main` in a temporary directory, which is not the experiment's path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treeProblem, assertNotExperimentTree, ExperimentTreeError, EXPERIMENT_TREE } from '../scripts/tree-guard.mjs';
import { ROOT } from './helpers.mjs';

test('the experiment path is refused on any branch, however it is spelled', () => {
  for (const topLevel of [EXPERIMENT_TREE, 'C:\\Users\\jjdub\\code\\poly', 'c:/users/jjdub/code/poly/', 'C:\\Users\\jjdub\\code\\poly\\']) {
    assert.match(treeProblem({ topLevel, branch: 'm4' }) ?? '', /experiment's tree/, topLevel);
  }
});

test('the m4 worktree is allowed, and a path that only starts like the experiment is not mistaken for it', () => {
  assert.equal(treeProblem({ topLevel: 'C:/Users/jjdub/code/poly-m4', branch: 'm4' }), null);
  assert.equal(treeProblem({ topLevel: 'C:/Users/jjdub/code/poly/sub', branch: 'm4' }), null);
});

test('the branch main is refused at any path', () => {
  assert.match(treeProblem({ topLevel: 'C:/Users/jjdub/code/poly-m4', branch: 'main' }) ?? '', /branch is main/);
});

test('a real checkout on main is refused, and this checkout is allowed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-guard-'));
  try {
    execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', '--branch', 'main', ROOT, join(dir, 'clone')]);
    assert.throws(() => assertNotExperimentTree(join(dir, 'clone')), ExperimentTreeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.doesNotThrow(() => assertNotExperimentTree(ROOT));
});

// Scripts that wrote files before M4 are listed; every newer script under scripts/ that writes calls the guard.
const BEFORE_M4 = new Set(['record-oms-corpus.mjs', 'sync-corpora.mjs']);

test('every M4 script that writes files calls the guard', () => {
  const dir = join(ROOT, 'scripts');
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'tree-guard.mjs' && !BEFORE_M4.has(f))) {
    const text = readFileSync(join(dir, name), 'utf8');
    if (/\b(writeFileSync|writeFile|mkdirSync|rmSync|copyFileSync|appendFileSync|renameSync)\b/.test(text)) {
      assert.match(text, /assertNotExperimentTree\(/, `${name} writes files without the tree guard`);
    }
  }
});
