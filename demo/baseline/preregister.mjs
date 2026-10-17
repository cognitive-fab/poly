#!/usr/bin/env node
// Writes the pre-registration record (demo/baseline/PREREGISTRATION.json) for the owner to read, and prints the commit command, or, with
// --amend <n>, writes an amendment (demo/baseline/PREREGISTRATION.amendment-<n>.json, DB13). It runs nothing against a model, costs
// nothing, and does not commit: the owner approves the prompt first (DB2), reads the file, and commits it in the owner's own terminal.
// The record is never rewritten once it is committed; a change to the tools, the hook, the workspaces or the pilots is an amendment, made
// before any run that it governs.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DISALLOWED_TOOLS, READ_ONLY_BASH, ROOT, TOOLS } from './arms.mjs';
import { IMMUTABLE_KEYS, RECORD, amendmentFile, buildRecord, effectiveRecord } from './procedure.mjs';

const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const pilot = (name) => { const v = flag(`pilots-${name}`); return v === null ? 1 : Number(v); };
const git = (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The harness findings that amendment 1 answers (DB10 to DB12), as they were found in the two pilots. */
const FINDINGS = {
  H1: 'The poly workspace held its packages in node_modules without declaring them in package.json, and typescript was missing, so npm run poly check failed before the agent changed anything and the allowed npm install pruned all eight packages.',
  H2: 'Read, Glob and Grep reached outside the workspace (the owner\'s home, the owner\'s own checkout, the global npm folder and the other arm\'s run), read-only Bash reached outside too, and the Agent tool was used although it is in neither tool list.',
  H3: 'RECORD.json said stopped: success for a run that wrote no file of its own. That field is the agent\'s result subtype, not a task outcome.',
  H4: 'Bash permission depended on the shape of a command. The first Bash call of ts-pilot-1 (a cd into the workspace, ls, cat piped to head, node --version, npm --version) was denied command by command under dontAsk, and the agent took Bash to be blocked and never ran its tests.',
};
/** What the record cannot show (DB14, DB11 item 6, DB15). */
const LIMITS = [
  'The guard sees tool inputs, not what an agent\'s own program does at run time.',
  'The hook and the audit were tested on the recorded inputs of both pilots and by child process, and have not been seen to run inside the live agent until a pilot has run under this amendment.',
  'The turn limit is recorded as a setting; whether the agent enforces it is shown by the first pilot.',
  'The guard applies each .. after a link to the real path of what precedes it on systems that follow links first. That ordering is not tested on Windows, which is the run platform, where the system folds .. by text before it looks at a link.',
];
const EXCLUDED = [
  { arm: 'ts', run: 'pilot-1', findings: ['H3', 'H4'], note: 'Excluded from results as a finding of the harness. RECORD.json called the run a success (H3), and the agent wrote its files but never ran its tests, because its first Bash call was denied by the shape of the command and it took Bash to be blocked (H4).' },
  { arm: 'poly', run: 'pilot-1', findings: ['H1', 'H2', 'H3'], note: 'Excluded from results as a finding of the harness. The toolchain was broken by the harness before the agent acted, the agent left the workspace, and the record called the run a success.' },
];

function amendment(n) {
  const eff = effectiveRecord({ root: ROOT, git });
  if (eff.problems.length) throw new Error(`the amendments so far are not fit:\n- ${eff.problems.join('\n- ')}`);
  if (eff.amendments.length !== n - 1) throw new Error(`amendment ${n} follows ${eff.amendments.length} amendment(s)`);
  if (existsSync(join(ROOT, amendmentFile(n)))) throw new Error(`${amendmentFile(n)} exists: an amendment is written once`);
  const now = buildRecord({ version: eff.record.claudeCode.version, pilots: eff.record.pilots });
  const excluded = EXCLUDED.map((e) => {
    const runFile = `demo/baseline/runs/${e.arm}-${e.run}/RECORD.json`;
    const commit = git(['log', '--diff-filter=A', '--format=%H', '--', runFile]).split('\n').filter(Boolean).at(-1);
    if (!commit) throw new Error(`${runFile} is not committed`);
    return { arm: e.arm, run: e.run, commit, tree: git(['rev-parse', `${commit}:demo/baseline/runs/${e.arm}-${e.run}/tree`]), findings: e.findings, note: e.note };
  });
  return {
    v: 1,
    amendment: n,
    reason: 'The two pilots showed four faults of the harness (H1 to H4). This amendment records the rules that remove them (DB10 to DB15): a declared toolchain, a hook that confines every tool call to the workspace, disallowed tools, a record that says what happened, and one read-only set of Bash commands for both arms. The prompt, the arm texts, the cleaned reference, the model, the agent, the caps and the turn limit are unchanged. One new pilot per arm is allowed.',
    findings: FINDINGS,
    limits: LIMITS,
    keeps: Object.fromEntries(IMMUTABLE_KEYS.map((k) => [k, eff.record[k]])),
    set: {
      allowedTools: now.allowedTools,
      disallowedTools: DISALLOWED_TOOLS,
      tools: TOOLS,
      readOnlyBash: READ_ONLY_BASH,
      settings: now.settings,
      hook: now.hook,
      scaffolds: now.scaffolds,
      pilots: { ts: eff.record.pilots.ts + 1, poly: eff.record.pilots.poly + 1 },
    },
    excluded,
  };
}

const n = flag('amend');
if (n !== null) {
  const record = amendment(Number(n));
  const file = amendmentFile(Number(n));
  writeFileSync(join(ROOT, file), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, (k, v) => (k === 'allowedTools' ? '(see arms.mjs)' : v), 2));
  console.log(`\nWritten to ${file}. Read it, then commit it before any run that it governs:\n`);
  console.log(`  git add ${file}`);
  console.log(`  git commit -m "Baseline pre-registration amendment ${n}: harness findings H1 to H4, the hook, the declared toolchain and the read-only Bash set, one new pilot per arm"`);
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
