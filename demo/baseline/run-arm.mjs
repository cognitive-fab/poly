#!/usr/bin/env node
// Runs one arm of the baseline once, in the owner's terminal, after the pre-registration commit (this is the step that costs money):
//
//   node demo/baseline/run-arm.mjs --arm ts|poly --run pilot-1|kept [--check]
//
// --check runs every check and starts nothing.
//
// It refuses to start unless every check of procedure.mjs passes. The agent runs in a workspace outside the repository, on the owner's own
// login, with the model and the per-run cap the record names; the session is saved as it ran. Nothing here runs the build, and nothing
// is committed: commit-run.mjs prepares the run's commit.
import { preflight, runArm } from './procedure.mjs';

const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const arm = flag('arm');
const run = flag('run');
if (!arm || !run) {
  console.error('usage: run-arm.mjs --arm ts|poly --run pilot-1|kept [--check]');
  process.exit(2);
}
if (process.argv.includes('--check')) {
  // Every check, and nothing started: costs nothing.
  const problems = preflight({ arm, run });
  console.log(problems.length ? `not ready:\n- ${problems.join('\n- ')}` : `ready: ${arm}-${run} would start`);
  process.exit(problems.length ? 1 : 0);
}
try {
  const { dir, summary } = await runArm({ arm, run });
  console.log(`run ${arm}-${run} finished (exit ${summary.exit}, stopped: ${summary.stopped ?? 'n/a'}, cost ${summary.costUsd ?? 'unknown'} USD)`);
  console.log(`session and workspace: ${dir}`);
  console.log(`next: node demo/baseline/commit-run.mjs --arm ${arm} --run ${run}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
