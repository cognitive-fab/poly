// The pre-registration amendments (DB13), built without being written. `preregister.mjs --amend <n>` writes the file and prints the commit
// command; the tests and the owner can read the same object here. Nothing in this file commits, runs an agent or writes a file.
import { DISALLOWED_TOOLS, READ_ONLY_BASH, READ_ONLY_EXACT, ROOT, TOOLS } from './arms.mjs';
import { IMMUTABLE_KEYS, buildRecord, effectiveRecord, totalCap } from './procedure.mjs';
import { isDeepStrictEqual } from 'node:util';

/** The harness findings that amendment 1 answers (DB10 to DB12), as they were found in the two pilots. */
export const FINDINGS_1 = {
  H1: 'The poly workspace held its packages in node_modules without declaring them in package.json, and typescript was missing, so npm run poly check failed before the agent changed anything and the allowed npm install pruned all eight packages.',
  H2: 'Read, Glob and Grep reached outside the workspace (the owner\'s home, the owner\'s own checkout, the global npm folder and the other arm\'s run), read-only Bash reached outside too, and the Agent tool was used although it is in neither tool list.',
  H3: 'RECORD.json said stopped: success for a run that wrote no file of its own. That field is the agent\'s result subtype, not a task outcome.',
  H4: 'Bash permission depended on the shape of a command. The first Bash call of ts-pilot-1 (a cd into the workspace, ls, cat piped to head, node --version, npm --version) was denied command by command under dontAsk, and the agent took Bash to be blocked and never ran its tests.',
};
/** The harness findings that amendment 2 answers (DB16, DB17), as they were found in the second pilots. */
export const FINDINGS_2 = {
  H5: 'The poly workspace declared @poly/runtime from its package.json and dist only. The runtime reads a model folder of its own at load, so load threw for want of it, and poly-pilot-2 rebuilt the folder into node_modules from the specification text with a script of its own. The smoke test ran poly check and never load.',
  H6: 'The audit marked poly-pilot-2 escaped for a pipe into grep -v inside its workspace. The label means leaving the workspace or using a tool that is not allowed, so the audit now lists refused calls (guard or tool list) apart from escaped ones.',
};
/** What the record cannot show (DB14, DB11 item 6, DB15). */
const LIMITS_1 = [
  'The guard sees tool inputs, not what an agent\'s own program does at run time.',
  'The hook and the audit were tested on the recorded inputs of both pilots and by child process, and have not been seen to run inside the live agent until a pilot has run under this amendment.',
  'The turn limit is recorded as a setting; whether the agent enforces it is shown by the first pilot.',
  'The guard applies each .. after a link to the real path of what precedes it on systems that follow links first. That ordering is not tested on Windows, which is the run platform, where the system folds .. by text before it looks at a link.',
];
const LIMITS_2 = [
  ...LIMITS_1,
  'The smoke test now starts the runtime on the hello example (admit, load, create, one dispatch). It does not exercise handlers, effects, a store or the channel adapters, so another file that the runtime reads at run time could still be missing.',
  'The poly tool list allows npm run poly check, witness, fix, fmt and edit-check. The reference also names poly admit and poly lint handlers, which the list refuses in the npm run form (DB16 item 6). This amendment does not change the list: poly-pilot-3 runs under the list that poly-pilot-2 had.',
  'ts-pilot-2 met two refusals of the tool list (a mkdir inside a compound command, and an npm run typecheck script of its own). They are listed in the audit as refused and do not mark the run. It stands as the TypeScript pilot.',
];
const EXCLUDED_1 = [
  { arm: 'ts', run: 'pilot-1', findings: ['H3', 'H4'], note: 'Excluded from results as a finding of the harness. RECORD.json called the run a success (H3), and the agent wrote its files but never ran its tests, because its first Bash call was denied by the shape of the command and it took Bash to be blocked (H4).' },
  { arm: 'poly', run: 'pilot-1', findings: ['H1', 'H2', 'H3'], note: 'Excluded from results as a finding of the harness. The toolchain was broken by the harness before the agent acted, the agent left the workspace, and the record called the run a success.' },
];
const EXCLUDED_2 = [
  { arm: 'poly', run: 'pilot-2', findings: ['H5'], note: 'Excluded from results as a finding of the harness. The runtime package was installed without its model folder, so the runtime refused to start, and the agent rebuilt the folder into node_modules from the specification text. The audit called the run escaped for a pipe into grep inside the workspace (H6); the run never left it.' },
];

/** What the TypeScript arm meets at run time (DB13 item 6): an amendment that would change any of these refuses itself. */
const KEPT_AT_RUN = ['allowedTools', 'disallowedTools', 'tools', 'settings', 'hook', 'readOnlyBash', 'readOnlyExact'];

/** The commit that added a run's RECORD.json, and the hash of its tree: what an exclusion cites. */
function excludedEntries(list, git) {
  return list.map((e) => {
    const runFile = `demo/baseline/runs/${e.arm}-${e.run}/RECORD.json`;
    const commit = git(['log', '--diff-filter=A', '--format=%H', '--', runFile]).split('\n').filter(Boolean).at(-1);
    if (!commit) throw new Error(`${runFile} is not committed`);
    return { arm: e.arm, run: e.run, commit, tree: git(['rev-parse', `${commit}:demo/baseline/runs/${e.arm}-${e.run}/tree`]), findings: e.findings, note: e.note };
  });
}

/** Amendment `n` as an object. It writes nothing: `git` is a function from an argument list to the trimmed output of git in `root`. */
export function buildAmendment(n, { root = ROOT, git }) {
  // The record as it stood before amendment n: the files numbered n and above are not read, so the answer does not depend on whether n's own file exists (DB13 item 6).
  const eff = effectiveRecord({ root, git, upTo: n - 1 });
  if (eff.problems.length) throw new Error(`the amendments so far are not fit:\n- ${eff.problems.join('\n- ')}`);
  if (eff.amendments.length !== n - 1) throw new Error(`amendment ${n} follows ${eff.amendments.length} amendment(s)`);
  if (n !== 1 && n !== 2) throw new Error(`there is no definition of amendment ${n}`);

  if (n === 1) {
    const pilots = { ts: eff.record.pilots.ts + 1, poly: eff.record.pilots.poly + 1 };
    const now = buildRecord({ version: eff.record.claudeCode.version, pilots: eff.record.pilots });
    return {
      v: 1,
      amendment: 1,
      reason: 'The two pilots showed four faults of the harness (H1 to H4). This amendment records the rules that remove them (DB10 to DB15): a declared toolchain, a hook that confines every tool call to the workspace, disallowed tools, a record that says what happened, and one read-only set of Bash commands for both arms. The prompt, the arm texts, the cleaned reference, the model, the agent, the caps and the turn limit are unchanged. One new pilot per arm is allowed.',
      findings: FINDINGS_1,
      limits: LIMITS_1,
      // The caps of the runs are kept (capsUsd is one of the nine), and so is the approved total they make with the pilots below: 150 USD.
      keeps: { ...Object.fromEntries(IMMUTABLE_KEYS.map((k) => [k, eff.record[k]])), totalCapUsd: totalCap(pilots) },
      set: {
        allowedTools: now.allowedTools,
        disallowedTools: DISALLOWED_TOOLS,
        tools: TOOLS,
        readOnlyBash: READ_ONLY_BASH,
        readOnlyExact: READ_ONLY_EXACT,
        settings: now.settings,
        hook: now.hook,
        scaffolds: now.scaffolds,
        pilots,
      },
      excluded: excludedEntries(EXCLUDED_1, git),
    };
  }

  // Amendment 2 (DB13 item 6): the poly scaffold and one more poly pilot. Everything the TypeScript arm meets at run time is kept.
  const now = buildRecord({ version: eff.record.claudeCode.version, pilots: eff.record.pilots });
  for (const key of KEPT_AT_RUN) {
    if (!isDeepStrictEqual(now[key], eff.record[key])) throw new Error(`${key} is not what the record says: the TypeScript arm would meet something new, so ts-pilot-2 would not stand`);
  }
  if (now.scaffolds.ts !== eff.record.scaffolds.ts) throw new Error('the TypeScript scaffold digest is not what the record says: ts-pilot-2 would not stand');
  const pilots = { ts: eff.record.pilots.ts, poly: eff.record.pilots.poly + 1 };
  return {
    v: 1,
    amendment: 2,
    reason: 'The second pilots showed two more faults of the harness. The poly workspace lacked the runtime\'s model folder, so the runtime could not start (H5, DB16), and the audit called a run that never left its workspace escaped (H6, DB17). This amendment records the new poly scaffold, excludes poly-pilot-2, lets ts-pilot-2 stand as the TypeScript pilot, and allows one new poly pilot, pilot-3. Nothing that the TypeScript arm sees at run time changes: its scaffold, tool list, settings, hook and guard are kept. The prompt, the arm texts, the cleaned reference, the model, the agent, the caps and the turn limit are unchanged.',
    findings: FINDINGS_2,
    limits: LIMITS_2,
    keeps: {
      ...Object.fromEntries(IMMUTABLE_KEYS.map((k) => [k, eff.record[k]])),
      ...Object.fromEntries(KEPT_AT_RUN.map((k) => [k, eff.record[k]])),
      totalCapUsd: totalCap(pilots),
    },
    set: { scaffolds: now.scaffolds, pilots },
    excluded: excludedEntries(EXCLUDED_2, git),
  };
}
