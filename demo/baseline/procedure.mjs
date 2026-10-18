// The baseline's procedure (DB2 to DB5 and DB10 to DB13, plan step 10), as code that refuses: the pre-registration record and its
// amendments, the checks that must pass before an agent is started, one run of an arm, and the preparation of a run's commit. The owner
// runs it in the owner's own terminal; nothing here is run by the toolchain or the tests against a real agent, and nothing here makes a
// pre-registration commit.
//
// The order the protocol fixes (DB2, DB4, DB13):
//   1. PROMPT.md is approved by the owner and committed with PREREGISTRATION.json, which holds its SHA-256, the model, the agent's
//      version, the pilots and the per-run caps. That commit is the pre-registration commit, and nothing has run before it. The record is
//      never edited: a change is an amendment file, committed before any run that it governs.
//   2. Each pilot and each kept run: preflight (the record and its amendments are committed and unchanged, the prompt hashes as recorded,
//      the agent is the recorded version, the login is clean, the workspace installs with no network), then the agent runs in a workspace
//      outside the repository, then the run is committed verbatim (the tree, the session, a record of its hash) before anything is run
//      against it.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { apiKeyProblems, armEnv, configProblems } from '../../experiments/m3/runner/isolation.mjs';
import { ARMS, ALLOWED_TOOLS, BILLING, DISALLOWED_TOOLS, GUARD_FILE, HOOK_FILE, MAX_TURNS, READ_ONLY_BASH, READ_ONLY_EXACT, MODEL, NETWORK, ROOT, TOOLS, WORK_DIR, armText, claudeArgs, hookSettings, listFiles, makeWorkspace, polyReferenceRecord, promptText, scaffoldDigest, sha256, treeDigest } from './arms.mjs';
import { auditRun } from './audit.mjs';
import { smokeTest } from './smoke.mjs';

export const RECORD = 'demo/baseline/PREREGISTRATION.json';
export const amendmentFile = (n) => `demo/baseline/PREREGISTRATION.amendment-${n}.json`;
/** What no amendment may set (DB13 item 3): the prompt, the arm texts, the model, the agent, the terms and the reference. */
export const IMMUTABLE_KEYS = ['prompt', 'armTexts', 'model', 'claudeCode', 'billing', 'network', 'maxTurns', 'capsUsd', 'polyReference'];
/** The login and settings folder of the baseline's agent, outside the repository, kept clean the way the M3 arms' is. */
export const CONFIG_DIR = join(homedir(), '.poly-demo', 'claude');
/** Where a run's own files (session, result, initial manifest) are written while it runs: outside the repository, beside the workspaces and not around them. */
export const RUNS_DIR = join(homedir(), '.poly-demo', 'runs');
export const RUN_NAME = /^(pilot-[1-9]|kept)$/;

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const claudeVersion = (bin = 'claude') => /(\d+\.\d+\.\d+)/.exec(execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))?.[1] ?? null;

/** The most the baseline can cost: every pilot and every kept run at its arm's cap. */
export const totalCap = (pilots) => Object.entries(ARMS).reduce((sum, [arm, a]) => sum + (pilots[arm] + 1) * a.capUsd, 0);

/** The settings that install the hook, with the path left out: the same on every machine, so the record can hash it. */
export const settingsDigest = () => sha256(JSON.stringify(hookSettings('<hook>')));
export const hookDigest = () => ({ hookSha256: sha256(readFileSync(HOOK_FILE)), guardSha256: sha256(readFileSync(GUARD_FILE)) });

/** The pre-registration record, from the facts of the day: written by preregister.mjs, reviewed by the owner, then committed with PROMPT.md. */
export function buildRecord({ root = ROOT, version = claudeVersion(), pilots = { ts: 1, poly: 1 }, scaffolds, reference } = {}) {
  const scratch = join(tmpdir(), `poly-demo-scaffold-${process.pid}`);
  return {
    v: 1,
    prompt: { file: 'demo/baseline/PROMPT.md', sha256: sha256(readFileSync(join(root, 'demo', 'baseline', 'PROMPT.md'))) },
    model: MODEL,
    claudeCode: { version },
    pilots,
    capsUsd: { ts: ARMS.ts.capUsd, poly: ARMS.poly.capUsd },
    maxTurns: MAX_TURNS,
    // The baseline runs are on the subscription, outside the API ceiling of plan section 5; their total is the sum of the caps.
    billing: BILLING,
    totalCapUsd: totalCap(pilots),
    network: NETWORK,
    armTexts: { ts: sha256(readFileSync(join(root, 'demo', 'baseline', 'arm-ts.md'))), poly: sha256(readFileSync(join(root, 'demo', 'baseline', 'arm-poly.md'))) },
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DISALLOWED_TOOLS,
    tools: TOOLS,
    readOnlyBash: READ_ONLY_BASH,
    readOnlyExact: READ_ONLY_EXACT,
    settings: { sha256: settingsDigest() },
    hook: hookDigest(),
    polyReference: reference ?? polyReferenceRecord(join(tmpdir(), `poly-demo-reference-${process.pid}`), root),
    scaffolds: scaffolds ?? { ts: scaffoldDigest('ts', scratch, root), poly: scaffoldDigest('poly', scratch, root) },
    excluded: [],
  };
}

/** The commit that introduced a file: the oldest one that added it. '' if there is none. */
const introducedBy = (g, file) => {
  try { return g(['log', '--diff-filter=A', '--format=%H', '--', file]).split('\n').filter(Boolean).at(-1) ?? ''; } catch { return ''; }
};

/**
 * The record that governs a run (DB13 item 2): the base record with each amendment's `set` laid over it, in order. `base` is the commit that
 * introduced the base record, `amendments` lists `{ n, commit }`, and `problems` lists everything that makes the amendments unfit: one that is
 * not committed, that changed after its commit, that sets a key no amendment may set, or whose keeps differ from the record. `upTo` limits it to
 * the amendment files numbered 1 to `upTo` (DB13 item 6): the record as it stood before a later amendment, whatever state that amendment's file is in.
 */
export function effectiveRecord({ root = ROOT, git: g = (args) => git(root, args), upTo = Infinity } = {}) {
  const problems = [];
  let record = JSON.parse(readFileSync(join(root, RECORD), 'utf8'));
  const base = introducedBy(g, RECORD);
  const found = readdirSync(join(root, 'demo', 'baseline')).map((n) => /^PREREGISTRATION\.amendment-(\d+)\.json$/.exec(n)).filter(Boolean).map((m) => Number(m[1])).filter((n) => n <= upTo).sort((a, b) => a - b);
  const amendments = [];
  let excluded = [...(record.excluded ?? [])];
  for (const [i, n] of found.entries()) {
    if (n !== i + 1) { problems.push(`amendment ${n} follows a gap: amendment ${i + 1} is missing`); break; }
    const rel = amendmentFile(n);
    const am = JSON.parse(readFileSync(join(root, rel), 'utf8'));
    const commit = introducedBy(g, rel);
    if (!commit) problems.push(`${rel} is not committed: amendment ${n} has not been made`);
    else {
      amendments.push({ n, commit });
      try { g(['merge-base', '--is-ancestor', commit, 'HEAD']); } catch { problems.push(`the commit ${commit.slice(0, 8)} of amendment ${n} is not an ancestor of HEAD`); }
      if (g(['diff', '--name-only', commit, 'HEAD', '--', rel]) !== '') problems.push(`${rel} has changed since its commit ${commit.slice(0, 8)}: amendment ${n} is not as it was made`);
    }
    if (am.amendment !== n) problems.push(`${rel} declares amendment ${am.amendment}, not ${n}`);
    for (const key of IMMUTABLE_KEYS) if (am.set && key in am.set) problems.push(`amendment ${n} sets ${key}, which no amendment may change`);
    record = { ...record, ...(am.set ?? {}) };
    // The total of the caps follows the pilots the amendment allows, so an amendment that raises the pilots does not leave it behind.
    if (record.pilots) record = { ...record, totalCapUsd: totalCap(record.pilots) };
    // What an amendment keeps is read against the record as it leaves it (DB13 item 3): for the keys it cannot set, the record before it.
    for (const [key, value] of Object.entries(am.keeps ?? {})) {
      if (!isDeepStrictEqual(value, record[key])) problems.push(`amendment ${n} keeps ${key} as ${JSON.stringify(value)}, but the record has ${JSON.stringify(record[key])}`);
    }
    excluded = [...excluded, ...(am.excluded ?? [])];
  }
  return { record: { ...record, excluded }, base, amendments, problems };
}

/** What stops a run: [] when the run may start. `deps` lets a test give the facts instead of the machine's. */
export function preflight({ arm, run, root = ROOT, env = process.env, configDir = CONFIG_DIR, runsDir = join(root, 'demo', 'baseline', 'runs'), localRunsDir = RUNS_DIR, deps = {} }) {
  const out = [];
  const g = deps.git ?? ((args) => git(root, args));
  const version = deps.claudeVersion ?? (() => claudeVersion());
  if (!ARMS[arm]) return [`no arm ${arm}`];
  if (!RUN_NAME.test(run)) return [`${run} is not a run name: pilot-1 to pilot-9, or kept`];
  const file = join(root, RECORD);
  if (!existsSync(file)) return [`${RECORD} does not exist: the pre-registration commit has not been made, and nothing may run before it`];
  // The pre-registration commit is the one that introduced the record, and the record and the prompt are as that commit left them: a
  // later commit that rewrites either does not re-register. A change is an amendment, committed before the run it governs (DB13).
  const eff = effectiveRecord({ root, git: g });
  const record = eff.record;
  out.push(...eff.problems);
  const commit = eff.base;
  if (!commit) out.push(`${RECORD} is not committed: the pre-registration commit has not been made`);
  else {
    try { g(['merge-base', '--is-ancestor', commit, 'HEAD']); } catch { out.push(`the pre-registration commit ${commit.slice(0, 8)} is not an ancestor of HEAD`); }
    for (const f of [RECORD, 'demo/baseline/PROMPT.md', 'demo/baseline/arm-ts.md', 'demo/baseline/arm-poly.md']) if (g(['diff', '--name-only', commit, 'HEAD', '--', f]) !== '') out.push(`${f} has changed since the pre-registration commit ${commit.slice(0, 8)}`);
  }
  if (g(['status', '--porcelain', '--', 'demo/baseline']) !== '') out.push('demo/baseline has uncommitted changes: the prompt, the record, the amendments and the scaffolds must be as committed');
  const bytes = readFileSync(join(root, 'demo', 'baseline', 'PROMPT.md'));
  if (sha256(bytes) !== record.prompt?.sha256) out.push(`PROMPT.md hashes to ${sha256(bytes)}, not the recorded ${record.prompt?.sha256}`);
  if (record.model !== MODEL) out.push(`the recorded model is ${record.model}, not ${MODEL}`);
  if (record.capsUsd?.[arm] !== ARMS[arm].capUsd) out.push(`the recorded cap of the ${arm} arm is ${record.capsUsd?.[arm]}, not ${ARMS[arm].capUsd}`);
  if (!isDeepStrictEqual(record.allowedTools?.[arm], ALLOWED_TOOLS[arm])) out.push(`the tools of the ${arm} arm are not the recorded ones`);
  if (!isDeepStrictEqual(record.disallowedTools, DISALLOWED_TOOLS)) out.push('the disallowed tools are not the recorded ones');
  if (!isDeepStrictEqual(record.readOnlyBash, READ_ONLY_BASH) || !isDeepStrictEqual(record.readOnlyExact, READ_ONLY_EXACT)) out.push('the read-only Bash set is not the recorded one');
  if (record.tools !== TOOLS) out.push(`the recorded tool set is ${record.tools}, not ${TOOLS}`);
  if (record.settings?.sha256 !== settingsDigest()) out.push('the hook settings are not the recorded ones');
  if (!isDeepStrictEqual(record.hook, hookDigest())) out.push('hook.mjs or guard.mjs is not the recorded one');
  if (record.maxTurns !== MAX_TURNS) out.push(`the recorded turn limit is ${record.maxTurns}, not ${MAX_TURNS}`);
  if (record.billing !== BILLING) out.push(`the recorded billing is ${record.billing}, not ${BILLING}`);
  if (record.network !== NETWORK) out.push(`the recorded network is ${record.network}, not ${NETWORK}`);
  if (record.totalCapUsd !== totalCap(record.pilots ?? {})) out.push(`the recorded total cap is ${record.totalCapUsd}, not the sum of the caps`);
  const text = sha256(readFileSync(join(root, 'demo', 'baseline', `arm-${arm}.md`)));
  if (text !== record.armTexts?.[arm]) out.push(`arm-${arm}.md hashes to ${text}, not the recorded ${record.armTexts?.[arm]}`);
  let have;
  try { have = version(); } catch (e) { have = undefined; out.push(`the agent's version could not be read: ${e.message}`); }
  if (have === null) out.push('claude --version printed no version, so the agent cannot be shown to be the recorded one');
  else if (have !== undefined && have !== record.claudeCode?.version) out.push(`the agent is version ${have}, the record says ${record.claudeCode?.version}`);
  out.push(...apiKeyProblems(env));
  out.push(...(deps.configProblems ?? configProblems)(configDir));
  // The runs already made: a name is used once, the pilots are as many as the record says and are named in order, and a kept run is one.
  // A run is taken once it has been made, committed or not, and an excluded run (DB13) stays taken.
  const excludedHere = (record.excluded ?? []).filter((e) => e.arm === arm).map((e) => e.run);
  const taken = [...new Set([...[runsDir, localRunsDir].flatMap((d) => (existsSync(d) ? readdirSync(d).filter((n) => n.startsWith(`${arm}-`)).map((n) => n.slice(arm.length + 1)) : [])), ...excludedHere])];
  if (taken.includes(run)) out.push(`the ${arm} arm already has a run named ${run}; a repeat is a new pre-registration (DB4)`);
  if (run.startsWith('pilot-')) {
    const pilots = taken.filter((r) => r.startsWith('pilot-')).length;
    if (pilots >= (record.pilots?.[arm] ?? 0)) out.push(`the record allows ${record.pilots?.[arm] ?? 0} pilot(s) of the ${arm} arm, and they are used`);
    if (!taken.includes(run) && run !== `pilot-${pilots + 1}`) out.push(`the next pilot of the ${arm} arm is pilot-${pilots + 1}, not ${run}: pilots are named in order`);
  }
  if (run === 'kept' && taken.includes('kept')) out.push(`the ${arm} arm already has its kept run`);
  if (arm === 'poly') {
    const reference = (deps.reference ?? (() => polyReferenceRecord(join(tmpdir(), `poly-demo-reference-${process.pid}`), root)))();
    if (!isDeepStrictEqual(reference, record.polyReference)) out.push('the poly arm\'s language reference (the files in tools/poly, or what they hold) is not the recorded one');
  }
  const scratch = join(tmpdir(), `poly-demo-check-${process.pid}-${arm}`);
  const scaffold = deps.scaffold ?? ((a) => scaffoldDigest(a, scratch, root));
  const digest = scaffold(arm);
  if (digest !== record.scaffolds?.[arm]) out.push(`the ${arm} scaffold is ${digest}, not the recorded ${record.scaffolds?.[arm]}: a toolchain built since the record was made changes it`);
  // The smoke test is the slow check: it runs only when nothing else is wrong (DB10 item 5).
  if (out.length === 0) {
    const smoke = (deps.smoke ?? ((a) => smokeTest(a, { root })))(arm);
    if (!smoke.ok) out.push(`the smoke test of the ${arm} workspace failed: ${smoke.steps.filter((s) => !s.ok).map((s) => `${s.name} (${s.detail})`).join('; ')}`);
  }
  return out;
}

/** What a workspace holds that is not the agent's work: installed packages, the declared toolchain, and git's own folder. */
const NOT_AGENT = ['node_modules', '.harness', '.git'];

/** The files of a workspace or a tree that the agent made or changed: not in the harness's manifest, or with other bytes (DB12). */
export function agentFilesIn(dir, initial) {
  const bare = (hash) => String(hash).replace(/^sha256:/, '');
  return listFiles(dir, '', NOT_AGENT).filter((rel) => !(rel in initial) || bare(initial[rel]) !== bare(sha256(readFileSync(join(dir, rel))))).sort();
}

/**
 * The one line that reports a finished run (DB12). The agent's own result label is never alone on it: it comes with the number of files the
 * agent made and the audit, because the label says only how the session ended.
 */
export const summaryLine = ({ sdkResult, agentFiles, audit, costUsd }) => `sdk result: ${sdkResult ?? 'none'} (the agent's own label, not a task outcome); agent files: ${agentFiles}; audit: ${audit}; cost: ${costUsd ?? 'unknown'} USD`;

/** The hash of every file the harness itself put in a workspace, except the toolchain under .harness: what the agent started from. */
function initialManifest(workspace) {
  return Object.fromEntries(listFiles(workspace, '', ['.harness']).map((rel) => [rel, sha256(readFileSync(join(workspace, rel)))]));
}

/**
 * Runs the agent once, in a workspace of its own outside the repository (DB10 item 1). `sources` is where the toolchain is copied from (the
 * repository by default; a test whose `root` is a throwaway repository points it at the real one). `bin` is the agent's command (a stub in the tests).
 * The stream is written as it arrives; the result event (its subtype, text, usage and cost) is kept. Returns the run folder and the workspace.
 */
export async function runArm({ arm, run, bin = 'claude', binArgs = [], root = ROOT, env = process.env, configDir = CONFIG_DIR, runsDir = RUNS_DIR, workDir: workRoot = WORK_DIR, sources = root, checks = preflight, deps = {} }) {
  const problems = checks({ arm, run, root, env, configDir, localRunsDir: runsDir, deps });
  if (problems.length) throw new Error(`not started:\n- ${problems.join('\n- ')}`);
  const dir = join(runsDir, `${arm}-${run}`);
  if (existsSync(dir)) throw new Error(`${dir} exists: a run is not repeated in place`);
  const workspace = join(workRoot, `${arm}-${run}`);
  if (existsSync(workspace)) throw new Error(`${workspace} exists: a workspace is not reused`);
  mkdirSync(dir, { recursive: true });
  makeWorkspace(arm, workspace, sources);
  writeFileSync(join(dir, 'initial.json'), `${JSON.stringify(initialManifest(workspace), null, 2)}\n`);
  const prompt = promptText(root);
  const out = createWriteStream(join(dir, 'session.jsonl'));
  const child = spawn(bin, [...binArgs, ...claudeArgs({ arm, prompt, text: armText(arm, root) })], { cwd: workspace, env: { ...armEnv(env, configDir), POLY_DEMO_WORKSPACE: workspace, POLY_DEMO_ALLOWED_BASH: JSON.stringify(ALLOWED_TOOLS[arm].filter((p) => p.startsWith('Bash('))) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let result = null;
  let buffer = '';
  child.stdout.on('data', (c) => {
    out.write(c);
    buffer += c.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      try { const e = JSON.parse(line); if (e.type === 'result') result = e; } catch { /* not an event */ }
    }
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(-4000); });
  // A binary that cannot be started emits 'error' and may never emit 'close': either one ends the wait, and the failure is recorded.
  let spawnError = null;
  const exit = await new Promise((resolve) => { child.once('error', (e) => { spawnError = e; resolve(null); }); child.once('close', resolve); });
  // The last event may arrive with no newline after it.
  try { const e = JSON.parse(buffer); if (e.type === 'result') result = e; } catch { /* nothing left, or not an event */ }
  await new Promise((resolve) => out.end(resolve));
  const summary = {
    arm, run, exit, startedWith: { model: MODEL, capUsd: ARMS[arm].capUsd },
    // The agent's own label for how the session ended (DB12): it says nothing about whether the task was done.
    sdkResult: result?.subtype ?? null, finalMessage: typeof result?.result === 'string' ? result.result : null, workspace,
    costUsd: result?.total_cost_usd ?? null, usage: result?.usage ?? null, stderrTail: stderr,
    error: spawnError ? `${spawnError.code ?? 'ERROR'}: ${spawnError.message}` : null,
    modelCallFlags: auditSession(join(dir, 'session.jsonl')),
  };
  writeFileSync(join(dir, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { dir, workspace, summary };
}

/** What would call a model from inside a run: the poly commands that may, and the agent's own command line. */
const MODEL_CALL = /(?:\bpoly|cli\.js)\s+(?:new|explain)\b|\bclaude\s+-p\b|\bnpx\s+(?:-y\s+)?@anthropic|api\.anthropic\.com/;

/**
 * The tool list is an allow-list, not a sandbox: an arm that may write a file and run its tests can run any code it wrote. So the session
 * is read after the run for anything that would call a model (`poly new`, an explanation command, the agent's own command line, the
 * provider's host), and each hit is recorded in result.json for the owner to read. A hit is not a refusal after the fact; it is a fact
 * the report states (DB7).
 */
export function auditSession(file) {
  const flags = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    for (const part of e.message?.content ?? []) {
      if (part?.type !== 'tool_use') continue;
      for (const [field, value] of Object.entries(part.input ?? {})) {
        if (typeof value === 'string' && MODEL_CALL.test(value)) flags.push({ tool: part.name, field, excerpt: value.slice(Math.max(0, value.search(MODEL_CALL) - 20), value.search(MODEL_CALL) + 80) });
      }
    }
  }
  return flags;
}

/**
 * Prepares a run's commit: the workspace's files (not node_modules, .harness or .git) copied verbatim to demo/baseline/runs/<arm>-<run>/tree,
 * the session, and a record of the tree's digest and what happened (DB12): the agent's own result label, the files the agent made or changed,
 * its final message and the audit of its tool calls. Returns the commands the owner types to commit it. The tree is committed before anything
 * is run against it (DB4), and no file of it is edited afterwards.
 */
export function prepareCommit({ arm, run, runsDir = RUNS_DIR, workDir: workRoot = WORK_DIR, root = ROOT }) {
  const from = join(runsDir, `${arm}-${run}`);
  const workspace = join(workRoot, `${arm}-${run}`);
  if (!existsSync(workspace)) throw new Error(`no workspace for ${arm}-${run} in ${workRoot}`);
  if (!existsSync(join(from, 'result.json'))) throw new Error(`no run ${arm}-${run} in ${runsDir}`);
  const to = join(root, 'demo', 'baseline', 'runs', `${arm}-${run}`);
  if (existsSync(to)) throw new Error(`${to} exists: a run is committed once`);
  mkdirSync(to, { recursive: true });
  cpSync(workspace, join(to, 'tree'), { recursive: true, filter: (p) => !/(^|[\\/])(node_modules|\.harness|\.git)([\\/]|$)/.test(p) });
  cpSync(join(from, 'session.jsonl'), join(to, 'session.jsonl'));
  const result = JSON.parse(readFileSync(join(from, 'result.json'), 'utf8'));
  const initial = JSON.parse(readFileSync(join(from, 'initial.json'), 'utf8'));
  const record = JSON.parse(readFileSync(join(root, RECORD), 'utf8'));
  // The agent's files: a file of the tree whose path the harness did not provide, or whose bytes it changed.
  const treeDir = join(to, 'tree');
  const agentFilePaths = agentFilesIn(treeDir, initial);
  // Two categories (DB17): `calls` are the calls that escaped, `refused` the calls inside the workspace that the guard or the tool list refused.
  const { status, calls, refused } = auditRun(join(from, 'session.jsonl'), result.workspace ?? workspace);
  writeFileSync(join(to, 'RECORD.json'), `${JSON.stringify({
    arm, run, treeDigest: treeDigest(treeDir), promptSha256: record.prompt.sha256, model: MODEL, claudeCode: record.claudeCode,
    sdkResult: result.sdkResult, sdkResultMeans: 'the agent\'s own label for how the session ended, not a task outcome',
    agentFiles: agentFilePaths.length, agentFilePaths, finalMessage: result.finalMessage, audit: { status, calls, refused },
    costUsd: result.costUsd, usage: result.usage,
  }, null, 2)}\n`);
  const rel = `demo/baseline/runs/${arm}-${run}`;
  return [
    `git add ${rel}`,
    `git commit -m "Baseline run ${arm}-${run}, committed verbatim before anything is run against it" -m "Tree digest: see ${rel}/RECORD.json. No file of the tree is edited after this commit."`,
    `git rev-parse HEAD:${rel}/tree   # the tree hash to record in the demo's record`,
  ];
}
