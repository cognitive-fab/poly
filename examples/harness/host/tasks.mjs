// plan-e3.md E3.7, docs/e3/tasks-spec.md: the twelve offline tasks. This file prepares a task's scratch copy, applies its breaks
// and its reference fixes, and runs its stage checks, under three rules the owner set (2026-10-12):
//
//   1. work only in the ignored scratch copies, never on the originals. The originals are read, never written, built in or run
//      in; a copy is made into .poly/e3-tasks/<run>/<task>/, and the originals' file set is pinned by a digest that a task
//      checks before it copies (a changed original refuses the task);
//   2. no network for the commands a task runs. There is no sandbox on this platform, so the denial is by three means that this
//      file states and the tests hold: the environment points every proxy at a closed port and sets the offline switches of the
//      toolchains (GOPROXY=off, GOFLAGS=-mod=readonly, GOSUMDB=off, GOTOOLCHAIN=local, npm_config_offline=true); a command that
//      names a network tool or a fetching subcommand is refused before it runs; and a task's checks are the repository's own
//      tests, which open no socket. A program that opened a socket on purpose would not be stopped (the limit is stated in
//      the README);
//   3. no key in any environment a task sees. A command gets a built environment, not the process's: only the names of an
//      allow-list pass, and a name that looks like a credential is removed even if it is on the list.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const EXAMPLE = resolve(HERE, '..');
export const TASKS_DIR = join(EXAMPLE, 'tasks');
/** The repository's root: three levels up from examples/harness/host. */
export const ROOT = resolve(HERE, '..', '..', '..');
export const SCRATCH = join(ROOT, '.poly', 'e3-tasks');

// ---------------------------------------------------------------- the environment of a command (rules 2 and 3)

const ALLOW = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'GOROOT', 'GOPATH', 'GOMODCACHE']);
/** A name that looks like a credential is removed even when it is allowed. */
export const SECRET_NAME = /(key|token|secret|passw|credential|auth|cookie|session|bearer|private|signature|anthropic|openai|aws_|azure_|gcp_|google_|github|gitlab|npm_config__)/i;
const CLOSED = 'http://127.0.0.1:9';

/**
 * The environment a task's command runs in: the allow-listed names of `base`, none that looks like a credential, and the
 * toolchains offline. `cache` is the Go build cache, inside the scratch folder.
 */
export function commandEnv(base = process.env, { cache = join(SCRATCH, '.gocache') } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (ALLOW.has(k.toUpperCase()) && !SECRET_NAME.test(k)) env[k] = v;
  }
  return {
    ...env,
    HTTP_PROXY: CLOSED, HTTPS_PROXY: CLOSED, ALL_PROXY: CLOSED, http_proxy: CLOSED, https_proxy: CLOSED, all_proxy: CLOSED, NO_PROXY: '',
    GOPROXY: 'off', GOFLAGS: '-mod=readonly', GOSUMDB: 'off', GOTOOLCHAIN: 'local', GOCACHE: cache, GONOSUMCHECK: '1',
    npm_config_offline: 'true', npm_config_update_notifier: 'false', NO_COLOR: '1', CI: '1',
  };
}

const NETWORK_TOOLS = /^(curl|wget|ssh|scp|sftp|ftp|nc|ncat|netcat|telnet|rsync|ping|nslookup|dig|powershell|pwsh|cmd|bash|sh)(\.exe)?$/i;
const FETCHING = [
  [/^(npm|pnpm|yarn)(\.cmd)?$/i, /^(install|i|ci|add|update|upgrade|publish|login|audit|exec|dlx|create|init)$/i],
  [/^npx(\.cmd)?$/i, /^(?!--no-install$)/],
  [/^go(\.exe)?$/i, /^(get|install|mod|work|clean|generate)$/i],
  [/^git(\.exe)?$/i, /^(clone|fetch|pull|push|remote|submodule|ls-remote|config|credential)$/i],
  [/^(pip3?|py|python3?)(\.exe)?$/i, /^(install|download|-m)$/i],
];

/** Why a command is refused before it runs (rule 2), or null. */
export function refusal(cmd, args = []) {
  const name = String(cmd).split(/[\\/]/).pop();
  if (NETWORK_TOOLS.test(name)) return `${name} is a network tool or a shell`;
  if (/^https?:|^ftp:|^ssh:|^git@|:\/\//i.test([cmd, ...args].join(' '))) return 'a URL in the command line';
  for (const [tool, sub] of FETCHING) if (tool.test(name) && args.length && sub.test(String(args[0]))) return `${name} ${args[0]} can fetch`;
  return null;
}

// ---------------------------------------------------------------- the originals and their copies (rule 1)

const EXCLUDE = new Set(['node_modules', 'dist', '.git', '.poly', '.gocache', '.vite', 'coverage']);

/** Every file of an original that a copy takes, as [relative path with /, sha256], sorted. */
export function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (EXCLUDE.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push([relative(dir, p).split(sep).join('/'), createHash('sha256').update(readFileSync(p)).digest('hex')]);
    }
  };
  walk(dir);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
export const digestOf = (files) => createHash('sha256').update(files.map(([p, h]) => `${p}\u0000${h}`).join('\n')).digest('hex');

export const repos = () => JSON.parse(readFileSync(join(TASKS_DIR, 'repos.json'), 'utf8'));
export const originalOf = (name) => resolve(ROOT, '..', repos()[name].dir);
export const taskIds = () => readdirSync(TASKS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
export const taskOf = (id) => JSON.parse(readFileSync(join(TASKS_DIR, id, 'task.json'), 'utf8'));

const once = (text, needle, what) => {
  const n = text.split(needle).length - 1;
  if (n !== 1) throw new Error(`${what}: the text to replace occurs ${n} times, not once`);
};

function inside(root, file) {
  const p = resolve(root, file);
  const rel = relative(root, p);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${file} is outside the copy`);
  return p;
}

/** Replaces `from` by `to` once in a file of a copy. */
export function replaceIn(copy, file, from, to) {
  const p = inside(copy, file);
  const text = readFileSync(p, 'utf8');
  once(text, from, file);
  writeFileSync(p, text.replace(from, () => to));
}

/**
 * A copy of the task's original in the scratch folder, in the task's starting state: the originals' digest checked, the files
 * copied, the task's own test files added, and every injected break applied. `run` names the folder.
 */
export function prepare(id, run = 'proof', { expectDigest } = {}) {
  const task = taskOf(id);
  const orig = originalOf(task.repo);
  const files = snapshot(orig);
  const want = expectDigest ?? repos()[task.repo].digest;
  if (digestOf(files) !== want) throw new Error(`the original ${task.repo} has changed since the tasks were written (digest ${digestOf(files).slice(0, 12)}, expected ${want.slice(0, 12)})`);
  const copy = join(SCRATCH, run, id);
  if (!copy.startsWith(SCRATCH + sep)) throw new Error('the copy is outside the scratch folder');
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(copy, { recursive: true });
  for (const [rel] of files) {
    const to = join(copy, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(orig, rel), to);
  }
  // the toolchain's installed packages are used, not copied: a link to the original's folder, read by the checks and never written
  const nm = join(orig, 'node_modules');
  if (task.language === 'js' && existsSync(nm)) symlinkSync(nm, join(copy, 'node_modules'), 'junction');
  for (const add of task.addFiles ?? []) {
    const to = inside(copy, add.path);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(TASKS_DIR, id, add.from), to);
  }
  for (const stage of task.stages) for (const e of stage.edits) if (e.origin !== 'pristine') replaceIn(copy, e.file, e.fixed, e.broken);
  return { task, copy };
}

/** Applies the reference fix of one stage to a copy. */
export function applyReference(copy, stage) {
  for (const e of stage.edits) replaceIn(copy, e.file, e.broken, e.fixed);
}

/**
 * Whether a failed check failed because a test failed, and not because the copy would not build or run: an injected break that
 * only breaks the build proves nothing about the agent's reading of the tests.
 */
export function failedAsATest(r) {
  const text = r.stdout + r.stderr;
  if (r.timedOut || r.refused) return false;
  if (/[[]build failed[]]|declared and not used|cannot find package|SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND|no test files|No test files found|No test found/i.test(text)) return false;
  return /--- FAIL|AssertionError|expected .* to |FAIL /.test(text);
}

/** Whether the originals still match the digests the tasks were written against. */
export function originalsUnchanged() {
  return Object.fromEntries(Object.keys(repos()).map((name) => [name, digestOf(snapshot(originalOf(name))) === repos()[name].digest]));
}

// ---------------------------------------------------------------- running a command in a copy

/**
 * Runs one command in a copy, with the built environment and a timeout; refused first when it names a network tool.
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string, timedOut: boolean, refused: string | null }>}
 */
export function runIn(copy, cmd, args = [], { timeoutMs = 120_000, env = commandEnv(), cwd = '.' } = {}) {
  const why = refusal(cmd, args);
  if (why) return Promise.resolve({ status: null, stdout: '', stderr: `refused: ${why}`, timedOut: false, refused: why });
  const dir = cwd === '.' ? copy : inside(copy, cwd);
  mkdirSync(env.GOCACHE, { recursive: true });
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(cmd, args, { cwd: dir, env, shell: false, windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ status: null, stdout, stderr: `${stderr}${e.message}`, timedOut, refused: null });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr, timedOut, refused: null });
    });
  });
}

/** A stage's check: its command, passing when it exits 0 within its timeout. */
export async function runCheck(copy, stage, opts = {}) {
  const c = stage.check;
  const r = await runIn(copy, c.cmd, c.args, { timeoutMs: c.timeoutMs ?? 180_000, cwd: c.cwd ?? '.', ...opts });
  return { passed: r.status === 0 && !r.timedOut && !r.refused, ...r };
}

/**
 * The oracle (docs/e3/tasks-spec.md, rule 4): for every stage k, with the break applied and stages 0 to k-1 fixed, the check of
 * stage k fails; with stage k fixed, it passes; and with every stage fixed, every check passes. Returns the findings.
 */
export async function prove(id, { run = 'proof', onStep = () => {} } = {}) {
  const { task, copy } = prepare(id, run);
  const problems = [];
  for (let k = 0; k < task.stages.length; k++) {
    const stage = task.stages[k];
    const before = await runCheck(copy, stage);
    onStep({ id, stage: k, phase: 'before', passed: before.passed });
    if (before.passed) problems.push(`stage ${k}: the check passes before the stage is fixed`);
    else if (!failedAsATest(before)) problems.push(`stage ${k}: the check fails before the stage is fixed, but not as a failed test: ${(before.stderr + before.stdout).slice(-300)}`);
    applyReference(copy, stage);
    const after = await runCheck(copy, stage);
    onStep({ id, stage: k, phase: 'after', passed: after.passed });
    if (!after.passed) problems.push(`stage ${k}: the check fails after the stage is fixed: ${(after.stderr + after.stdout).slice(-600)}`);
  }
  for (let k = 0; k < task.stages.length; k++) {
    const r = await runCheck(copy, task.stages[k]);
    if (!r.passed) problems.push(`stage ${k}: the check fails when every stage is fixed`);
  }
  return { id, stages: task.stages.length, problems, copy };
}
