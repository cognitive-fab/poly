// The baseline's procedure (DB2 to DB5, plan step 10), as code that refuses: the pre-registration record, the checks that must pass
// before an agent is started, one run of an arm, and the preparation of a run's commit. The owner runs it in the owner's own terminal;
// nothing here is run by the toolchain or the tests against a real agent, and nothing here makes the pre-registration commit.
//
// The order the protocol fixes (DB2, DB4):
//   1. PROMPT.md is approved by the owner and committed with PREREGISTRATION.json, which holds its SHA-256, the model, the agent's
//      version, the pilots and the per-run caps. That commit is the pre-registration commit, and nothing has run before it.
//   2. Each pilot and each kept run: preflight (the record is committed and unchanged, the prompt hashes as recorded, the agent is the
//      recorded version, the login is clean), then the agent runs in a workspace outside the repository, then the run is committed
//      verbatim (the tree, the session, a record of its hash) before anything is run against it.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { apiKeyProblems, armEnv, configProblems } from '../../experiments/m3/runner/isolation.mjs';
import { ARMS, ALLOWED_TOOLS, CEILING_USD, MODEL, ROOT, claudeArgs, makeWorkspace, promptText, scaffoldDigest, sha256, treeDigest } from './arms.mjs';

export const RECORD = 'demo/baseline/PREREGISTRATION.json';
/** The login and settings folder of the baseline's agent, outside the repository, kept clean the way the M3 arms' is. */
export const CONFIG_DIR = join(homedir(), '.poly-demo', 'claude');
/** Where a run's workspace and session are written while it runs: outside the repository, so the agent cannot read the repository. */
export const RUNS_DIR = join(homedir(), '.poly-demo', 'runs');
export const RUN_NAME = /^(pilot-[1-9]|kept)$/;

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const claudeVersion = (bin = 'claude') => /(\d+\.\d+\.\d+)/.exec(execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))?.[1] ?? null;

/** The pre-registration record, from the facts of the day: written by preregister.mjs, reviewed by the owner, then committed with PROMPT.md. */
export function buildRecord({ root = ROOT, version = claudeVersion(), pilots = { ts: 1, poly: 1 }, scaffolds } = {}) {
  const scratch = join(tmpdir(), `poly-demo-scaffold-${process.pid}`);
  return {
    v: 1,
    prompt: { file: 'demo/baseline/PROMPT.md', sha256: sha256(readFileSync(join(root, 'demo', 'baseline', 'PROMPT.md'))) },
    model: MODEL,
    claudeCode: { version },
    pilots,
    capsUsd: { ts: ARMS.ts.capUsd, poly: ARMS.poly.capUsd },
    ceilingUsd: CEILING_USD,
    allowedTools: ALLOWED_TOOLS,
    scaffolds: scaffolds ?? { ts: scaffoldDigest('ts', scratch, root), poly: scaffoldDigest('poly', scratch, root) },
  };
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
  const record = JSON.parse(readFileSync(file, 'utf8'));
  // The pre-registration commit is the one that introduced the record, and the record and the prompt are as that commit left them: a
  // later commit that rewrites either does not re-register (a repeat is a new pre-registration, before any run, DB4).
  let commit = '';
  try { commit = g(['log', '--diff-filter=A', '--format=%H', '--', RECORD]).split('\n').filter(Boolean).at(-1) ?? ''; } catch { commit = ''; }
  if (!commit) out.push(`${RECORD} is not committed: the pre-registration commit has not been made`);
  else {
    try { g(['merge-base', '--is-ancestor', commit, 'HEAD']); } catch { out.push(`the pre-registration commit ${commit.slice(0, 8)} is not an ancestor of HEAD`); }
    for (const f of [RECORD, 'demo/baseline/PROMPT.md']) if (g(['diff', '--name-only', commit, 'HEAD', '--', f]) !== '') out.push(`${f} has changed since the pre-registration commit ${commit.slice(0, 8)}`);
  }
  if (g(['status', '--porcelain', '--', 'demo/baseline']) !== '') out.push('demo/baseline has uncommitted changes: the prompt, the record and the scaffolds must be as committed');
  const bytes = readFileSync(join(root, 'demo', 'baseline', 'PROMPT.md'));
  if (sha256(bytes) !== record.prompt?.sha256) out.push(`PROMPT.md hashes to ${sha256(bytes)}, not the recorded ${record.prompt?.sha256}`);
  if (record.model !== MODEL) out.push(`the recorded model is ${record.model}, not ${MODEL}`);
  if (record.capsUsd?.[arm] !== ARMS[arm].capUsd) out.push(`the recorded cap of the ${arm} arm is ${record.capsUsd?.[arm]}, not ${ARMS[arm].capUsd}`);
  if (!isDeepStrictEqual(record.allowedTools?.[arm], ALLOWED_TOOLS[arm])) out.push(`the tools of the ${arm} arm are not the recorded ones`);
  if (record.ceilingUsd !== CEILING_USD) out.push(`the recorded ceiling is ${record.ceilingUsd}, not ${CEILING_USD}`);
  let have;
  try { have = version(); } catch (e) { have = null; out.push(`the agent's version could not be read: ${e.message}`); }
  if (have !== null && have !== record.claudeCode?.version) out.push(`the agent is version ${have}, the record says ${record.claudeCode?.version}`);
  out.push(...apiKeyProblems(env));
  out.push(...(deps.configProblems ?? configProblems)(configDir));
  // The runs already committed: a name is used once, the pilots are as many as the record says, and a kept run is one.
  // A run is taken once it has been made, committed or not: the runs in the repository, and the ones still in the folder they ran in.
  const taken = [...new Set([runsDir, localRunsDir].flatMap((d) => (existsSync(d) ? readdirSync(d).filter((n) => n.startsWith(`${arm}-`)).map((n) => n.slice(arm.length + 1)) : [])))];
  if (taken.includes(run)) out.push(`the ${arm} arm already has a run named ${run}; a repeat is a new pre-registration (DB4)`);
  if (run.startsWith('pilot-') && taken.filter((r) => r.startsWith('pilot-')).length >= (record.pilots?.[arm] ?? 0)) out.push(`the record allows ${record.pilots?.[arm] ?? 0} pilot(s) of the ${arm} arm, and they are used`);
  if (run === 'kept' && taken.includes('kept')) out.push(`the ${arm} arm already has its kept run`);
  const scratch = join(tmpdir(), `poly-demo-check-${process.pid}-${arm}`);
  const scaffold = deps.scaffold ?? ((a) => scaffoldDigest(a, scratch, root));
  const digest = scaffold(arm);
  if (digest !== record.scaffolds?.[arm]) out.push(`the ${arm} scaffold is ${digest}, not the recorded ${record.scaffolds?.[arm]}: a toolchain built since the record was made changes it`);
  return out;
}

/**
 * Runs the agent once, in a workspace outside the repository. `bin` is the agent's command (a stub in the tests). The stream is written
 * as it arrives; the result event (its usage and cost) is kept. Returns the folder of the run.
 */
export async function runArm({ arm, run, bin = 'claude', binArgs = [], root = ROOT, env = process.env, configDir = CONFIG_DIR, runsDir = RUNS_DIR, checks = preflight, deps = {} }) {
  const problems = checks({ arm, run, root, env, configDir, localRunsDir: runsDir, deps });
  if (problems.length) throw new Error(`not started:\n- ${problems.join('\n- ')}`);
  const dir = join(runsDir, `${arm}-${run}`);
  if (existsSync(dir)) throw new Error(`${dir} exists: a run is not repeated in place`);
  const workspace = join(dir, 'workspace');
  mkdirSync(dir, { recursive: true });
  makeWorkspace(arm, workspace, root);
  const prompt = promptText(root);
  const out = createWriteStream(join(dir, 'session.jsonl'));
  const child = spawn(bin, [...binArgs, ...claudeArgs({ arm, prompt })], { cwd: workspace, env: armEnv(env, configDir), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
  const exit = await new Promise((resolve) => child.once('close', resolve));
  // The last event may arrive with no newline after it.
  try { const e = JSON.parse(buffer); if (e.type === 'result') result = e; } catch { /* nothing left, or not an event */ }
  await new Promise((resolve) => out.end(resolve));
  const summary = { arm, run, exit, startedWith: { model: MODEL, capUsd: ARMS[arm].capUsd }, stopped: result?.subtype ?? null, costUsd: result?.total_cost_usd ?? null, usage: result?.usage ?? null, stderrTail: stderr, modelCallFlags: auditSession(join(dir, 'session.jsonl')) };
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
 * Prepares a run's commit: the workspace's files (not node_modules or .git) copied verbatim to demo/baseline/runs/<arm>-<run>/tree, the
 * session, and a record of the tree's digest and the facts of the run. Returns the commands the owner types to commit it. The tree is
 * committed before anything is run against it (DB4), and no file of it is edited afterwards.
 */
export function prepareCommit({ arm, run, runsDir = RUNS_DIR, root = ROOT }) {
  const from = join(runsDir, `${arm}-${run}`);
  if (!existsSync(join(from, 'workspace'))) throw new Error(`no run ${arm}-${run} in ${runsDir}`);
  const to = join(root, 'demo', 'baseline', 'runs', `${arm}-${run}`);
  if (existsSync(to)) throw new Error(`${to} exists: a run is committed once`);
  mkdirSync(to, { recursive: true });
  cpSync(join(from, 'workspace'), join(to, 'tree'), { recursive: true, filter: (p) => !/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(p) });
  cpSync(join(from, 'session.jsonl'), join(to, 'session.jsonl'));
  const result = JSON.parse(readFileSync(join(from, 'result.json'), 'utf8'));
  const record = JSON.parse(readFileSync(join(root, RECORD), 'utf8'));
  writeFileSync(join(to, 'RECORD.json'), `${JSON.stringify({ arm, run, treeDigest: treeDigest(join(to, 'tree')), promptSha256: record.prompt.sha256, model: MODEL, claudeCode: record.claudeCode, stopped: result.stopped, costUsd: result.costUsd, usage: result.usage }, null, 2)}\n`);
  const rel = `demo/baseline/runs/${arm}-${run}`;
  return [
    `git add ${rel}`,
    `git commit -m "Baseline run ${arm}-${run}, committed verbatim before anything is run against it" -m "Tree digest: see ${rel}/RECORD.json. No file of the tree is edited after this commit."`,
    `git rev-parse HEAD:${rel}/tree   # the tree hash to record in the demo's record`,
  ];
}
