#!/usr/bin/env node
// Writes the pre-registration record (demo/baseline/PREREGISTRATION.json) for the owner to read, and prints the commit command, or, with
// --amend <n>, writes an amendment (demo/baseline/PREREGISTRATION.amendment-<n>.json, DB13). It runs nothing against a model, costs
// nothing, and does not commit: the owner approves the prompt first (DB2), reads the file, and commits it in the owner's own terminal.
// The record is never rewritten once it is committed; a change to the tools, the hook, the workspaces or the pilots is an amendment, made
// before any run that it governs. The amendments themselves are built in amendments.mjs.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './arms.mjs';
import { buildAmendment } from './amendments.mjs';
import { RECORD, buildRecord } from './procedure.mjs';

const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const pilot = (name) => { const v = flag(`pilots-${name}`); return v === null ? 1 : Number(v); };
const git = (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The commit titles the owner is offered, by amendment. */
const TITLES = {
  1: 'Baseline pre-registration amendment 1: harness findings H1 to H4, the hook, the declared toolchain and the read-only Bash set, one new pilot per arm',
  2: 'Baseline pre-registration amendment 2: harness findings H5 and H6, the poly runtime model folder, poly-pilot-2 excluded, ts-pilot-2 stands, one new poly pilot',
};

const n = flag('amend');
if (n !== null) {
  const file = `demo/baseline/PREREGISTRATION.amendment-${Number(n)}.json`;
  if (existsSync(join(ROOT, file))) throw new Error(`${file} exists: an amendment is written once`);
  const record = buildAmendment(Number(n), { root: ROOT, git });
  writeFileSync(join(ROOT, file), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, (k, v) => (k === 'allowedTools' ? '(see arms.mjs)' : v), 2));
  console.log(`\nWritten to ${file}. Read it, then commit it before any run that it governs:\n`);
  console.log(`  git add ${file}`);
  console.log(`  git commit -m "${TITLES[Number(n)] ?? `Baseline pre-registration amendment ${n}`}"`);
} else {
  // The record is never rewritten once it is committed (DB13): a change is an amendment.
  if (git(['log', '--diff-filter=A', '--format=%H', '--', RECORD]) !== '') {
    console.error(`${RECORD} is committed: it is never rewritten. A change is an amendment: preregister.mjs --amend <n>.`);
    process.exit(1);
  }
  const record = buildRecord({ pilots: { ts: pilot('ts'), poly: pilot('poly') } });
  writeFileSync(join(ROOT, RECORD), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, (k, v) => (k === 'allowedTools' ? '(see arms.mjs)' : v), 2));
  console.log('\nWritten to demo/baseline/PREREGISTRATION.json. Read PROMPT.md and this record, then commit both:\n');
  console.log('  git add demo/baseline/PROMPT.md demo/baseline/PREREGISTRATION.json');
  console.log(`  git commit -m "Baseline pre-registration: prompt ${record.prompt.sha256.slice(0, 19)}, ${record.model}, Claude Code ${record.claudeCode.version}, ${record.pilots.ts}+${record.pilots.poly} pilot(s)"`);
}
