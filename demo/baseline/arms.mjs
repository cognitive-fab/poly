// The two arms of the baseline (DB3, plan step 10): one coding agent, one model, one prompt, two workspaces. This file holds what is
// fixed about them: the model, the per-run caps, the tools each arm may use, the arguments of the agent's command line, and the
// workspace each arm starts in. Nothing here runs an agent, and nothing here costs money; run-arm.mjs does that, in the owner's
// terminal, after the pre-registration commit.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISALLOWED_TOOLS as DISALLOWED } from './guard.mjs';
import { writeReference } from './poly-reference.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASELINE = join(ROOT, 'demo', 'baseline');

/**
 * Where a run's workspace is built (DB10 item 1): a folder of its own per run, beside the runs folder and not inside it, so that a
 * workspace never sits inside the runs folder of another arm. The runs folder (session.jsonl, result.json, initial.json) is in procedure.mjs.
 */
export const WORK_DIR = join(homedir(), '.poly-demo', 'work');
export const workDir = (arm, run) => join(WORK_DIR, `${arm}-${run}`);

/** Q13: Opus 5.5 for both arms, named in the pre-registration commit. */
export const MODEL = 'claude-opus-5-5';
/** The same cap for both arms, so that neither is advantaged by its budget (plan section 5). */
export const RUN_CAP_USD = 25;
/** The same turn limit for both arms (`--max-turns`), for the same reason. */
export const MAX_TURNS = 200;
export const ARMS = {
  ts: { label: 'TypeScript', capUsd: RUN_CAP_USD },
  poly: { label: 'poly', capUsd: RUN_CAP_USD },
};
/** Both arms run on the owner's subscription, never on an API key, so they are not on the API ceiling of plan section 5. */
export const BILLING = 'subscription';
/** Neither arm runs in a container: both have ordinary network access, and no key of any kind is in the workspace or the environment. */
export const NETWORK = 'ordinary network access, no container, no keys';

const FILES = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
/** The built-in tools that exist at all in a run (DB11 item 8): the file tools and Bash. No agent, task, web or notebook tool. */
export const TOOLS = [...FILES, 'Bash'].join(',');
/** Never allowed, in either arm (DB11 item 2). The same list is the guard's. */
export { DISALLOWED_TOOLS, READ_ONLY_BASH, READ_ONLY_EXACT } from './guard.mjs';
/**
 * The tools of each arm. Web tools are off in both (DB3). Both arms may install packages (`npm install`) and run their tests (`npm test`). Both arms may run node on a file. The TypeScript arm may also run the compiler
 * (`npx tsc`), which is what its language needs. The poly arm gets the deterministic commands of poly and none that calls a model: `poly new` drafts a module with a
 * model provider, and an explanation command may add model-written text, so neither is listed (DB3, plan section 5). Both arms have `node` (ruled 2026-10-15): neither has a model key,
 * so `poly new` could not reach a model, and the post-run audit flags any attempt (procedure.mjs). The poly arm's `npm run poly` is limited to the
 * deterministic commands.
 */
export const ALLOWED_TOOLS = {
  ts: [...FILES, 'Bash(node *)', 'Bash(npm test*)', 'Bash(npm install*)', 'Bash(npx tsc*)'],
  poly: [...FILES, 'Bash(node *)', 'Bash(npm test*)', 'Bash(npm install*)', 'Bash(npm run poly check*)', 'Bash(npm run poly witness*)', 'Bash(npm run poly fix*)', 'Bash(npm run poly fmt*)', 'Bash(npm run poly edit-check*)', 'Bash(npm run poly admit*)', 'Bash(npm run poly lint*)'],
};

/** The prompt, byte for byte (DB2): the file's contents, which the pre-registration hashes. */
export const promptText = (root = ROOT) => readFileSync(join(root, 'demo', 'baseline', 'PROMPT.md'), 'utf8');
/**
 * The one text an arm receives beyond the prompt, byte for byte, as an appended system prompt: the language it is told to use and the
 * tool that language needs. The two files have the same shape. The workspace holds no CLAUDE.md (the arms run with CLAUDE.md files off),
 * so this is the only other instruction an arm gets. The pre-registration hashes both files.
 */
export const armText = (arm, root = ROOT) => readFileSync(join(root, 'demo', 'baseline', `arm-${arm}.md`), 'utf8');
export const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** The hook file that Claude Code runs before every tool call (DB11 item 7). */
export const HOOK_FILE = join(BASELINE, 'hook.mjs');
export const GUARD_FILE = join(BASELINE, 'guard.mjs');

/** The settings that install the hook (DB11 item 8). The path is written with forward slashes, which both bash and cmd accept inside quotes. */
export const hookSettings = (hookPath) => ({
  hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${hookPath.replace(/\\/g, '/')}"` }] }] },
});

/**
 * The agent's command line for one run. The arms run on the owner's own login (experiments/m3/runner/isolation.mjs: no API key in the
 * environment, a configuration folder of their own), so no `--bare`. `dontAsk` denies a tool outside the list without a prompt, no
 * slash command or MCP server is loaded, and the CLI's own dollar cap stops the run at the arm's cap.
 */
export function claudeArgs({ arm, prompt, capUsd = ARMS[arm].capUsd, text = armText(arm) }) {
  if (!ARMS[arm]) throw new Error(`no arm ${arm}`);
  return [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--model', MODEL,
    '--append-system-prompt', text,
    '--settings', JSON.stringify(hookSettings(HOOK_FILE)),
    '--tools', TOOLS,
    '--disallowedTools', DISALLOWED.join(','),
    '--allowedTools', ALLOWED_TOOLS[arm].join(','),
    '--permission-mode', 'dontAsk',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--max-budget-usd', String(capUsd),
    '--max-turns', String(MAX_TURNS),
  ];
}

const write = (ws, rel, text) => { mkdirSync(dirname(join(ws, rel)), { recursive: true }); writeFileSync(join(ws, rel), text); };
const copy = (ws, rel, from, filter) => { mkdirSync(dirname(join(ws, rel)), { recursive: true }); cpSync(from, join(ws, rel), { recursive: true, filter }); };
const notBuildInfo = (p) => !p.endsWith('.tsbuildinfo');

/**
 * The toolchain, as folders under .harness/ and devDependencies of the workspace (DB10 item 2): [package name, folder, source in the repository].
 * A source that is a poly package is copied as package.json and dist; any other is copied whole.
 */
const BOTH = [
  ['typescript', 'typescript', 'node_modules/typescript'],
  ['@types/node', 'types-node', 'node_modules/@types/node'],
  ['undici-types', 'undici-types', 'node_modules/undici-types'],
];
const POLY = [
  ['@poly/core', 'poly-core', 'packages/poly-core'],
  ['@poly/lang', 'poly-lang', 'packages/poly-lang'],
  ['@poly/lower', 'poly-lower', 'packages/poly-lower'],
  ['@poly/ref', 'poly-ref', 'packages/poly-ref'],
  ['@poly/embed', 'poly-embed', 'packages/poly-embed'],
  ['@poly/check', 'poly-check', 'packages/poly-check'],
  ['@poly/runtime', 'poly-runtime', 'packages/poly-runtime'],
  ['@cognitive-fab/polygraph', 'polygraph', 'vendor/polygraph'],
  ['@cognitive-fab/sam-pattern', 'sam-pattern', 'vendor/sam-pattern'],
  ['@cognitive-fab/polyflow-kernel', 'polyflow-kernel', 'vendor/polyflow/platform/packages/kernel'],
  ['@cognitive-fab/polyflow-verify', 'polyflow-verify', 'vendor/polyflow/platform/packages/verify'],
  // The standard library the reference describes (std.channels, std.credentials, std.routing). The checker and the runtime read it four folders
  // above their own package, which is node_modules/std here, so it is a package of the workspace (DB16 item 7, finding H5).
  ['std', 'std', 'std'],
];
/** The package.json the harness writes into .harness/std: the repository's std folder has none, and npm needs one to install it. */
const STD_PACKAGE_JSON = `${JSON.stringify({ name: 'std', version: '0.0.0', private: true }, null, 2)}\n`;

/**
 * A folder that a poly package reads from its own root at run time, besides `dist` (DB16 item 2). `@poly/runtime` verifies its OutboxIntent models in
 * `model/` at load; without the folder `load` throws, and poly-pilot-2 rebuilt it from the specification text (finding H5).
 */
const RUNTIME_FOLDERS = { 'poly-runtime': ['model'] };

/** Copies the packages into .harness/ and returns the devDependencies that declare them. */
function declarePackages(dir, root, packages) {
  const dependencies = {};
  for (const [name, folder, source] of packages) {
    const from = join(root, source);
    if (source.startsWith('packages/')) {
      copy(dir, `.harness/${folder}/package.json`, join(from, 'package.json'));
      copy(dir, `.harness/${folder}/dist`, join(from, 'dist'), notBuildInfo);
      for (const extra of RUNTIME_FOLDERS[folder] ?? []) copy(dir, `.harness/${folder}/${extra}`, join(from, extra));
    } else copy(dir, `.harness/${folder}`, from);
    if (name === 'std') write(dir, '.harness/std/package.json', STD_PACKAGE_JSON);
    dependencies[name] = `file:.harness/${folder}`;
  }
  return Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Builds the workspace of an arm in `dir` (DB10): the scaffold, orders.json and the toolchain, which is declared in package.json as
 * `file:.harness/<folder>` and installed by `npm install` with no network. The poly arm also gets the cleaned language reference in
 * tools/poly. Neither holds a CLAUDE.md, a memory, a skill or any word of the other arm. Returns the files, relative to `dir`.
 */
export function makeWorkspace(arm, dir, root = ROOT) {
  if (!ARMS[arm]) throw new Error(`no arm ${arm}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copy(dir, 'orders.json', join(root, 'demo', 'baseline', 'orders.json'));
  write(dir, '.npmrc', 'install-links=true\n');
  const devDependencies = declarePackages(dir, root, arm === 'poly' ? [...BOTH, ...POLY] : BOTH);
  if (arm === 'ts') {
    write(dir, 'package.json', `${JSON.stringify({ name: 'support-agent', private: true, type: 'module', engines: { node: '>=24' }, scripts: { test: 'node --test' }, devDependencies }, null, 2)}\n`);
    write(dir, 'tsconfig.json', `${JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, types: ['node'], skipLibCheck: true }, include: ['src/**/*.ts', 'test/**/*.ts'] }, null, 2)}\n`);
  } else {
    write(dir, 'package.json', `${JSON.stringify({ name: 'support-agent', private: true, type: 'module', scripts: { test: 'node --test', poly: 'node node_modules/@poly/check/dist/src/cli.js' }, devDependencies }, null, 2)}\n`);
    write(dir, 'poly.json', `${JSON.stringify({ poly: '1', name: 'support-agent', modules: ['src/*.poly'] }, null, 2)}\n`);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeReference(dir, root);
  }
  return listFiles(dir);
}

/** Every file under a directory, relative to it, in a stable order. */
export function listFiles(dir, rel = '', skip = []) {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, p, skip));
    else out.push(p);
  }
  return out.sort();
}

/** A digest of a folder's files (names and bytes), excluding node_modules and .git: the same tree hashes the same. */
export function treeDigest(dir, { skip = ['node_modules', '.git'] } = {}) {
  const h = createHash('sha256');
  for (const f of listFiles(dir).filter((p) => !p.split('/').some((s) => skip.includes(s)))) {
    h.update(`${f}\0`);
    h.update(readFileSync(join(dir, f)));
    h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

/**
 * The poly arm's language reference, as the record states it: the list of the files in its tools/poly/ (and a digest of that list), and a
 * digest of what they hold after the edits of poly-reference.mjs. A file added, dropped or reworded changes one of the two.
 */
export function polyReferenceRecord(tmp, root = ROOT) {
  makeWorkspace('poly', tmp, root);
  try {
    const files = listFiles(join(tmp, 'tools', 'poly'));
    return { files, listSha256: sha256(files.join('\n')), treeSha256: treeDigest(join(tmp, 'tools', 'poly'), { skip: [] }) };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** The digest of a whole workspace as an arm would start in it (what the pre-registration records, so a changed scaffold is seen). */
export function scaffoldDigest(arm, tmp, root = ROOT) {
  makeWorkspace(arm, tmp, root);
  try { return treeDigest(tmp, { skip: [] }); } finally { rmSync(tmp, { recursive: true, force: true }); }
}
