// The two arms of the baseline (DB3, plan step 10): one coding agent, one model, one prompt, two workspaces. This file holds what is
// fixed about them: the model, the per-run caps, the tools each arm may use, the arguments of the agent's command line, and the
// workspace each arm starts in. Nothing here runs an agent, and nothing here costs money; run-arm.mjs does that, in the owner's
// terminal, after the pre-registration commit.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASELINE = join(ROOT, 'demo', 'baseline');

/** Q13: Opus 5.5 for both arms, named in the pre-registration commit. */
export const MODEL = 'claude-opus-5-5';
/** The total ceiling on the API (plan section 5) and the lines of it the baseline holds: a pilot and the kept run of each arm. */
export const CEILING_USD = 90;
/** The per-run caps, as the plan's section 5 gives them: the TypeScript arm 15 USD a run, the poly arm 25. */
export const ARMS = {
  ts: { label: 'TypeScript', capUsd: 15 },
  poly: { label: 'poly', capUsd: 25 },
};

const FILES = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
/**
 * The tools of each arm. Web tools are off in both (DB3). The TypeScript arm may use node and npm (it needs the registry to install
 * what it uses). The poly arm gets the deterministic commands of poly and none that calls a model: `poly new` drafts a module with a
 * model provider, and an explanation command may add model-written text, so neither is listed (DB3, plan section 5).
 */
export const ALLOWED_TOOLS = {
  ts: [...FILES, 'Bash(node *)', 'Bash(npm *)', 'Bash(npx *)'],
  poly: [...FILES, 'Bash(node *)', 'Bash(npm test*)', 'Bash(npm run poly check*)', 'Bash(npm run poly witness*)', 'Bash(npm run poly fix*)', 'Bash(npm run poly fmt*)', 'Bash(npm run poly edit-check*)'],
};

/** The prompt, byte for byte (DB2): the file's contents, which the pre-registration hashes. */
export const promptText = (root = ROOT) => readFileSync(join(root, 'demo', 'baseline', 'PROMPT.md'), 'utf8');
export const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * The agent's command line for one run. The arms run on the owner's own login (experiments/m3/runner/isolation.mjs: no API key in the
 * environment, a configuration folder of their own), so no `--bare`. `dontAsk` denies a tool outside the list without a prompt, no
 * slash command or MCP server is loaded, and the CLI's own dollar cap stops the run at the arm's cap.
 */
export function claudeArgs({ arm, prompt, capUsd = ARMS[arm].capUsd }) {
  if (!ARMS[arm]) throw new Error(`no arm ${arm}`);
  return [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--model', MODEL,
    '--allowedTools', ALLOWED_TOOLS[arm].join(','),
    '--permission-mode', 'dontAsk',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--max-budget-usd', String(capUsd),
  ];
}

const write = (ws, rel, text) => { mkdirSync(dirname(join(ws, rel)), { recursive: true }); writeFileSync(join(ws, rel), text); };
const copy = (ws, rel, from, filter) => { mkdirSync(dirname(join(ws, rel)), { recursive: true }); cpSync(from, join(ws, rel), { recursive: true, filter }); };
const notBuildInfo = (p) => !p.endsWith('.tsbuildinfo');

/** The poly packages as node_modules holds them: package.json and dist. */
const POLY_PACKAGES = [['poly-core', 'core'], ['poly-lang', 'lang'], ['poly-lower', 'lower'], ['poly-ref', 'ref'], ['poly-embed', 'embed'], ['poly-check', 'check']];
/** Examples a poly user starts from; the ones that model this task (the concierge, the retry variants, the inbox) are left out, so no arm starts from a near-answer. */
const POLY_EXAMPLES = ['hello', 'delivery', 'evidence'];

/**
 * Builds the workspace of an arm in `dir`: "an empty Node 24 + TypeScript scaffold and orders.json" for the TypeScript arm; for the
 * poly arm the poly project scaffold, the toolchain, the language reference and orders.json. Neither holds a CLAUDE.md, a memory, a
 * skill or any word of the other arm. Returns the files, relative to `dir`.
 */
export function makeWorkspace(arm, dir, root = ROOT) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copy(dir, 'orders.json', join(root, 'demo', 'baseline', 'orders.json'));
  if (arm === 'ts') {
    write(dir, 'package.json', `${JSON.stringify({ name: 'support-agent', private: true, type: 'module', engines: { node: '>=24' }, scripts: { test: 'node --test' } }, null, 2)}\n`);
    write(dir, 'tsconfig.json', `${JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, types: ['node'], skipLibCheck: true }, include: ['src/**/*.ts', 'test/**/*.ts'] }, null, 2)}\n`);
  } else if (arm === 'poly') {
    write(dir, 'package.json', `${JSON.stringify({ name: 'support-agent', private: true, type: 'module', scripts: { test: 'node --test', poly: 'node node_modules/@poly/check/dist/src/cli.js' } }, null, 2)}\n`);
    write(dir, 'poly.json', `${JSON.stringify({ poly: '1', name: 'support-agent', modules: ['src/*.poly'] }, null, 2)}\n`);
    mkdirSync(join(dir, 'src'), { recursive: true });
    for (const [pkg, name] of POLY_PACKAGES) {
      copy(dir, `node_modules/@poly/${name}/package.json`, join(root, 'packages', pkg, 'package.json'));
      copy(dir, `node_modules/@poly/${name}/dist`, join(root, 'packages', pkg, 'dist'), notBuildInfo);
    }
    copy(dir, 'node_modules/@cognitive-fab/polygraph', join(root, 'vendor', 'polygraph'));
    copy(dir, 'node_modules/@cognitive-fab/sam-pattern', join(root, 'vendor', 'sam-pattern'));
    copy(dir, 'tools/poly/README.md', join(root, 'README.md'));
    copy(dir, 'tools/poly/docs/03-technical-spec.md', join(root, 'docs', '03-technical-spec.md'));
    copy(dir, 'tools/poly/docs/04-semantics.md', join(root, 'docs', '04-semantics.md'));
    for (const e of POLY_EXAMPLES) copy(dir, `tools/poly/examples/${e}`, join(root, 'examples', e));
  } else throw new Error(`no arm ${arm}`);
  return listFiles(dir);
}

/** Every file under a directory, relative to it, in a stable order. */
export function listFiles(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, p));
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

/** The digest of a whole workspace as an arm would start in it (what the pre-registration records, so a changed scaffold is seen). */
export function scaffoldDigest(arm, tmp, root = ROOT) {
  makeWorkspace(arm, tmp, root);
  try { return treeDigest(tmp, { skip: [] }); } finally { rmSync(tmp, { recursive: true, force: true }); }
}
