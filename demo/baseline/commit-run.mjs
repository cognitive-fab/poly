#!/usr/bin/env node
// Prepares the commit of one finished run: copies its tree (not node_modules or .harness) and session into demo/baseline/runs/<arm>-<run>/,
// writes the record of the tree's digest and of what happened (the files the agent made, its final message, the audit of its tool calls),
// and prints the commands to type. It commits nothing. After the commit nothing is edited (DB4).
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { ROOT } from './arms.mjs';
import { prepareCommit, summaryLine } from './procedure.mjs';

const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const arm = flag('arm');
const run = flag('run');
if (!arm || !run) {
  console.error('usage: commit-run.mjs --arm ts|poly --run pilot-1|kept');
  process.exit(2);
}
try {
  const commands = prepareCommit({ arm, run });
  const record = JSON.parse(readFileSync(join(ROOT, 'demo', 'baseline', 'runs', `${arm}-${run}`, 'RECORD.json'), 'utf8'));
  console.log(`Prepared demo/baseline/runs/${arm}-${run}.`);
  console.log(summaryLine({ sdkResult: record.sdkResult, agentFiles: record.agentFiles, audit: record.audit.status, costUsd: record.costUsd }));
  for (const c of record.audit.calls) console.log(`  escaped: ${c.tool}: ${c.reason}`);
  console.log(`final message: ${String(record.finalMessage ?? '(none)').slice(0, 300)}`);
  console.log('\nCommit it before anything is run against it:\n');
  for (const c of commands) console.log(`  ${c}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
