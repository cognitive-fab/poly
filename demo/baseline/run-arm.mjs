#!/usr/bin/env node
// Runs one arm of the baseline once, in the owner's terminal, after the pre-registration commit (this is the step that costs money):
//
//   node demo/baseline/run-arm.mjs --arm ts|poly --run pilot-1|kept [--check]
//
// --check runs every check and the smoke test of the arm's workspace (DB10 item 4), and starts nothing.
//
// It refuses to start unless every check of procedure.mjs passes. The agent runs in a workspace of its own outside the repository, on the
// owner's own login, with the model and the per-run cap the record names, behind the hook that confines every tool call to the workspace
// (DB11); the session is saved as it ran. Nothing here runs the build, and nothing is committed: commit-run.mjs prepares the run's commit.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { auditRun } from './audit.mjs';
import { smokeTest } from './smoke.mjs';
import { agentFilesIn, preflight, runArm, summaryLine } from './procedure.mjs';

const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const arm = flag('arm');
const run = flag('run');
if (!arm || !run) {
  console.error('usage: run-arm.mjs --arm ts|poly --run pilot-1|kept [--check]');
  process.exit(2);
}
if (process.argv.includes('--check')) {
  // Every check, the smoke test, and nothing started: costs nothing. The smoke test is run here even when another check failed, so that one
  // look shows everything that is wrong.
  const problems = preflight({ arm, run, deps: { smoke: () => ({ ok: true, steps: [] }) } });
  const smoke = smokeTest(arm);
  for (const s of smoke.steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'} smoke ${s.name}: ${s.detail}`);
  if (!smoke.ok) problems.push(`the smoke test of the ${arm} workspace failed`);
  console.log(problems.length ? `not ready:\n- ${problems.join('\n- ')}` : `ready: ${arm}-${run} would start`);
  process.exit(problems.length ? 1 : 0);
}
try {
  const { dir, workspace, summary } = await runArm({ arm, run });
  const initial = JSON.parse(readFileSync(join(dir, 'initial.json'), 'utf8'));
  const audit = auditRun(join(dir, 'session.jsonl'), workspace);
  console.log(`run ${arm}-${run} finished (exit ${summary.exit}${summary.error ? `, ${summary.error}` : ''})`);
  console.log(summaryLine({ sdkResult: summary.sdkResult, agentFiles: agentFilesIn(workspace, initial).length, audit: audit.status, costUsd: summary.costUsd }));
  if (audit.refused.length) console.log(`the audit lists ${audit.refused.length} refused call(s) inside the workspace (not marked)`);
  if (audit.status === 'escaped') console.log(`the audit found ${audit.calls.length} call(s) outside the workspace or of a disallowed tool; see the record after commit-run.mjs`);
  console.log(`final message: ${String(summary.finalMessage ?? '(none)').slice(0, 300)}`);
  console.log(`run folder: ${dir}\nworkspace: ${workspace}`);
  console.log(`next: node demo/baseline/commit-run.mjs --arm ${arm} --run ${run}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
