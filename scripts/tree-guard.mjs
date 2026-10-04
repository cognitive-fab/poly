// The tree guard (M4-0). M4 and M5 are built in the worktree `poly-m4` on branch `m4`, while M3's runs use the
// experiment's tree, `C:\Users\jjdub\code\poly` on `main`, whose toolchain is frozen by digest (S100, S114).
// Every M4 script that writes files calls `assertNotExperimentTree()` first, so a script run from the wrong
// tree stops before it writes anything. The test is `test/tree-guard.test.mjs`.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export const EXPERIMENT_TREE = 'C:/Users/jjdub/code/poly';
export const EXPERIMENT_BRANCH = 'main';

/** A path in one comparable form: forward slashes, no trailing slash, lower case (Windows paths are case-blind). */
function normal(path) {
  return String(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Why `{ topLevel, branch }` is the experiment's tree, or null when it is not. Pure, so both conditions are tested. */
export function treeProblem({ topLevel, branch }) {
  if (normal(topLevel) === normal(EXPERIMENT_TREE)) return `the repository top level ${topLevel} is the experiment's tree (M4-0)`;
  if (branch === EXPERIMENT_BRANCH) return `the branch is ${EXPERIMENT_BRANCH}, which takes only M3 work (M4-0)`;
  return null;
}

/** The top level and branch of the git checkout that holds `dir`. */
export function treeOf(dir = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const topLevel = git('rev-parse', '--show-toplevel');
  let real = topLevel;
  try { real = realpathSync(topLevel); } catch { /* the path git printed is used as it is */ }
  return { topLevel: real, branch: git('rev-parse', '--abbrev-ref', 'HEAD') };
}

export class ExperimentTreeError extends Error {
  constructor(message) { super(message); this.name = 'ExperimentTreeError'; }
}

/** Throws unless `dir` is in a checkout that is neither the experiment's tree nor on its branch. */
export function assertNotExperimentTree(dir = process.cwd()) {
  const problem = treeProblem(treeOf(dir));
  if (problem) throw new ExperimentTreeError(`refusing to write files: ${problem}`);
}
