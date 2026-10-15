#!/usr/bin/env node
// Prepares the commit of one finished run: copies its tree (not node_modules) and session into demo/baseline/runs/<arm>-<run>/, writes
// the record of the tree's digest, and prints the commands to type. It commits nothing. After the commit nothing is edited (DB4).
import { prepareCommit } from './procedure.mjs';

const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const arm = flag('arm');
const run = flag('run');
if (!arm || !run) {
  console.error('usage: commit-run.mjs --arm ts|poly --run pilot-1|kept');
  process.exit(2);
}
try {
  const commands = prepareCommit({ arm, run });
  console.log(`Prepared demo/baseline/runs/${arm}-${run}. Commit it before anything is run against it:\n`);
  for (const c of commands) console.log(`  ${c}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
