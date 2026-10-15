// Step 10, prepared and not run (DB2 to DB5, plan step 10): the baseline's prompt, the arms' command lines and workspaces, the
// pre-registration record, the checks that refuse a run, and the preparation of a run's commit. No agent is started, no model is
// called and nothing costs money: the agent is a stub that writes stream events, and the temporary repositories are made here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_TOOLS, ARMS, BILLING, MAX_TURNS, MODEL, NETWORK, armText, claudeArgs, listFiles, makeWorkspace, promptText, sha256, treeDigest } from '../demo/baseline/arms.mjs';
import { RECORD, auditSession, buildRecord, preflight, prepareCommit, runArm } from '../demo/baseline/procedure.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// ---- the prompt (DB2) ------------------------------------------------------------------------------------------------------------

test('DB2: PROMPT.md is the owner\'s sentence, a blank line, and the fixed paragraph of the spec, word for word', () => {
  const spec = readFileSync(join(ROOT, 'docs', 'proposals', 'demo-refund.md'), 'utf8');
  const paragraph = /^> (Customers write to it on WhatsApp.*)$/m.exec(spec)?.[1];
  assert.ok(paragraph, 'the paragraph is in the spec');
  assert.equal(promptText(), `build a support agent that issues refunds\n\n${paragraph}\n`);
});

test('DB2: the paragraph says nothing of timeouts, retries, duplicates or idempotency, and nothing of any language or of poly', () => {
  const text = promptText();
  assert.doesNotMatch(text, /timeout|time out|retr(y|ies)|duplicate|idempoten|twice|once|TypeScript|JavaScript|python|poly|language/i);
  assert.ok(!text.includes('\r'), 'no carriage return: the hash is of the bytes the agent receives');
});

test('DB2: git leaves the prompt\'s bytes alone (no end-of-line conversion), so its hash is the same on every checkout', () => {
  const attributes = readFileSync(join(ROOT, '.gitattributes'), 'utf8');
  assert.match(attributes, /^demo\/baseline\/PROMPT\.md -text$/m);
});

// ---- the arms (DB3) ---------------------------------------------------------------------------------------------------------------

test('DB3, Q13: both arms use Opus 5.5, the per-run caps of the plan, no web tool, no MCP server, no slash command', () => {
  assert.equal(MODEL, 'claude-opus-5-5');
  assert.deepEqual([ARMS.ts.capUsd, ARMS.poly.capUsd, MAX_TURNS], [25, 25, 200], 'the same cap and the same turn limit');
  for (const arm of ['ts', 'poly']) {
    const args = claudeArgs({ arm, prompt: 'P' });
    assert.equal(args[args.indexOf('--model') + 1], MODEL);
    assert.equal(args[args.indexOf('--max-budget-usd') + 1], '25');
    assert.equal(args[args.indexOf('--max-turns') + 1], '200');
    assert.equal(args[args.indexOf('--append-system-prompt') + 1], armText(arm));
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.ok(args.includes('--strict-mcp-config') && args.includes('--disable-slash-commands'));
    assert.ok(!args.includes('--bare'), 'the arms run on the owner\'s login');
    assert.ok(!ALLOWED_TOOLS[arm].some((t) => /^(WebSearch|WebFetch|Skill|Task|Agent)/.test(t)), `${arm} has no web tool, skill or subagent`);
    assert.equal(args[1], 'P', 'the prompt is the argument of -p, whole');
  }
});

test('DB3, plan section 5: the poly arm has the deterministic commands and none that calls a model (no poly new, no explain)', () => {
  const tools = ALLOWED_TOOLS.poly.join(' ');
  for (const c of ['check', 'witness', 'fix', 'fmt', 'edit-check']) assert.ok(tools.includes(`npm run poly ${c}`), c);
  assert.doesNotMatch(tools, /poly new|poly explain|Bash\(npm run poly \*\)/);
  assert.ok(!ALLOWED_TOOLS.poly.includes('Bash(node *)'), 'node alone would run the poly command line directly, poly new included');
  assert.ok(ALLOWED_TOOLS.poly.includes('Bash(node --test*)'));
  assert.ok(ALLOWED_TOOLS.ts.includes('Bash(npm *)'), 'the TypeScript arm may install what it uses');
});

test('DB3: the arms differ only in the language they are told to use and the tools it needs: the two texts have one shape, and neither says anything about failure', () => {
  const [ts, poly] = ['ts', 'poly'].map((a) => armText(a));
  assert.match(ts, /TypeScript/);
  assert.match(poly, /in poly/);
  assert.doesNotMatch(ts, /poly/i, 'the TypeScript arm hears nothing of poly');
  assert.doesNotMatch(poly, /TypeScript/i, 'the poly arm is not told to write TypeScript');
  for (const text of [ts, poly]) {
    assert.match(text, /^Write the program in /);
    assert.match(text, /Run the tests with `npm test`, which runs `node --test`\./);
    assert.doesNotMatch(text, /timeout|retry|retries|duplicate|idempoten|twice|fail|safe|crash|network|stripe|whatsapp/i, 'no hint of the failure the demo is about');
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
    assert.equal(text.trimEnd().split('\n\n').length, 2, 'two paragraphs each');
  }
  assert.match(poly, /npm run poly check <file>/);
  assert.ok(ALLOWED_TOOLS.poly.includes('Bash(npm run poly check*)'), 'every command the text names is on the list');
  assert.ok(ALLOWED_TOOLS.poly.includes('Bash(npm test*)') && ALLOWED_TOOLS.ts.includes('Bash(npm *)'));
});

test('DB2: the record is refused on a changed text of an arm, a changed turn limit, another billing or another network; and the subscription is not an API key', () => {
  for (const [what, tweak, expect] of [
    ['arm text', (rec) => ({ ...rec, armTexts: { ...rec.armTexts, poly: 'sha256:0' } }), /arm-poly\.md hashes to/],
    ['turn limit', (rec) => ({ ...rec, maxTurns: 50 }), /turn limit is 50/],
    ['billing', (rec) => ({ ...rec, billing: 'api' }), /billing is api/],
    ['network', (rec) => ({ ...rec, network: 'container' }), /network is container/],
    ['total', (rec) => ({ ...rec, totalCapUsd: 90 }), /total cap is 90/],
  ]) {
    const r = repo({ tweak });
    try { assert.match(run(r, 'poly', 'pilot-1').join(), expect, what); } finally { r.clean(); }
  }
  const r = repo();
  try {
    writeFileSync(join(r.root, 'demo', 'baseline', 'arm-ts.md'), 'Write the program in Go.\n');
    r.sh('commit', '-q', '-a', '-m', 'reworded');
    assert.match(run(r).join(), /arm-ts\.md has changed since the pre-registration commit/);
    assert.match(run(r, 'ts', 'pilot-1', { rest: { env: { ANTHROPIC_AUTH_TOKEN: 'x' } } }).join(), /ANTHROPIC_AUTH_TOKEN is set/);
  } finally { r.clean(); }
});

test('DB3: the TypeScript workspace is a Node and TypeScript scaffold with orders.json; the poly workspace is the poly scaffold with its toolchain and reference; neither holds a CLAUDE.md, a memory or a skill', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'baseline-ws-'));
  try {
    const orders = readFileSync(join(ROOT, 'demo', 'baseline', 'orders.json'));
    const ts = makeWorkspace('ts', join(tmp, 'ts'));
    assert.deepEqual(ts, ['orders.json', 'package.json', 'tsconfig.json']);
    const poly = makeWorkspace('poly', join(tmp, 'poly'));
    for (const f of ['orders.json', 'package.json', 'poly.json', 'tools/poly/README.md', 'tools/poly/docs/03-technical-spec.md', 'tools/poly/docs/04-semantics.md', 'node_modules/@poly/check/package.json']) assert.ok(poly.includes(f), f);
    assert.deepEqual([readFileSync(join(tmp, 'ts', 'orders.json')), readFileSync(join(tmp, 'poly', 'orders.json'))], [orders, orders], 'the same orders, byte for byte');
    for (const files of [ts, poly]) assert.ok(!files.some((f) => /(^|\/)(CLAUDE\.md|CLAUDE\.local\.md|\.claude\/|memory|skills?\/|\.mcp\.json)/i.test(f)), 'no instruction file');
    assert.ok(!poly.some((f) => /^tools\/poly\/examples\/(concierge|retry|inbox|oms|orders|harness)\//.test(f)), 'no example that models this task');
    assert.equal(JSON.parse(readFileSync(join(tmp, 'ts', 'package.json'), 'utf8')).scripts.test, 'node --test');
    assert.match(JSON.parse(readFileSync(join(tmp, 'poly', 'package.json'), 'utf8')).scripts.poly, /@poly\/check\/dist\/src\/cli\.js/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- the record and the checks that refuse (DB2, DB4) ----------------------------------------------------------------------------

/** A repository of its own with a prompt, and, when asked, a committed record: the facts a preflight reads. */
function repo({ committed = true, record = true, dirty = false, tweak = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'baseline-repo-'));
  const sh = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(root, 'demo', 'baseline'), { recursive: true });
  for (const f of ['PROMPT.md', 'arm-ts.md', 'arm-poly.md']) copyFileSync(join(ROOT, 'demo', 'baseline', f), join(root, 'demo', 'baseline', f));
  copyFileSync(join(ROOT, 'demo', 'baseline', 'orders.json'), join(root, 'demo', 'baseline', 'orders.json'));
  sh('init', '-q');
  sh('config', 'user.name', 'test');
  sh('config', 'user.email', 'test@example.invalid');
  sh('config', 'commit.gpgsign', 'false');
  const scaffolds = { ts: 'sha256:ts-scaffold', poly: 'sha256:poly-scaffold' };
  if (record) writeFileSync(join(root, RECORD), `${JSON.stringify(tweak ? tweak(buildRecord({ root, version: '2.1.287', scaffolds })) : buildRecord({ root, version: '2.1.287', scaffolds }), null, 2)}\n`);
  if (committed) { sh('add', '-A'); sh('commit', '-q', '-m', 'pre-registration'); }
  if (dirty) writeFileSync(join(root, 'demo', 'baseline', 'PROMPT.md'), 'changed\n');
  return { root, sh, scaffolds, clean: () => rmSync(root, { recursive: true, force: true }) };
}

const deps = (r, over = {}) => ({ claudeVersion: () => '2.1.287', scaffold: (arm) => r.scaffolds[arm], configProblems: () => [], ...over });
const run = (r, arm = 'ts', name = 'pilot-1', over = {}) => preflight({ arm, run: name, root: r.root, env: {}, runsDir: join(r.root, 'demo', 'baseline', 'runs'), localRunsDir: join(r.root, 'nowhere'), deps: deps(r, over.deps), ...over.rest });

test('DB2: the record holds the prompt\'s hash, the model, the agent\'s version, one pilot an arm, the caps, the turn limit, the subscription, the network and the hash of each arm text', () => {
  const r = buildRecord({ version: '2.1.287', scaffolds: { ts: 'a', poly: 'b' } });
  assert.deepEqual([r.v, r.prompt.file, r.model, r.claudeCode.version, r.pilots, r.capsUsd, r.maxTurns, r.billing, r.totalCapUsd, r.network], [1, 'demo/baseline/PROMPT.md', MODEL, '2.1.287', { ts: 1, poly: 1 }, { ts: 25, poly: 25 }, 200, BILLING, 100, NETWORK]);
  assert.deepEqual([r.billing, r.network], ['subscription', 'ordinary network access, no container, no keys']);
  assert.deepEqual(r.armTexts, { ts: sha256(readFileSync(join(ROOT, 'demo', 'baseline', 'arm-ts.md'))), poly: sha256(readFileSync(join(ROOT, 'demo', 'baseline', 'arm-poly.md'))) });
  assert.equal(r.prompt.sha256, sha256(readFileSync(join(ROOT, 'demo', 'baseline', 'PROMPT.md'))));
  assert.match(r.prompt.sha256, /^sha256:[0-9a-f]{64}$/);
});

test('DB2: nothing may run before the pre-registration commit: no record, an uncommitted record and an edited prompt each refuse', () => {
  const none = repo({ record: false, committed: false });
  const uncommitted = repo({ committed: false });
  const edited = repo({ dirty: true });
  try {
    assert.match(run(none).join(), /does not exist.*nothing may run before/);
    assert.match(run(uncommitted).join(), /is not committed/);
    const problems = run(edited);
    assert.ok(problems.some((p) => /uncommitted changes/.test(p)) && problems.some((p) => /PROMPT\.md hashes to/.test(p)), problems.join('; '));
  } finally { none.clean(); uncommitted.clean(); edited.clean(); }
});

test('DB2, DB4: a run that agrees with the record may start, and one that does not is refused for each way', () => {
  const r = repo();
  try {
    assert.deepEqual(run(r), [], 'the committed, unchanged, matching case');
    assert.match(run(r, 'ts', 'pilot-1', { deps: { claudeVersion: () => '2.1.300' } }).join(), /version 2\.1\.300, the record says 2\.1\.287/);
    assert.match(run(r, 'ts', 'pilot-1', { deps: { scaffold: () => 'sha256:other' } }).join(), /scaffold is sha256:other/);
    assert.match(run(r, 'ts', 'pilot-1', { rest: { env: { ANTHROPIC_API_KEY: 'x' } } }).join(), /ANTHROPIC_API_KEY is set/);
    assert.ok(!run(r, 'ts', 'pilot-1', { rest: { env: { ANTHROPIC_API_KEY: 'x' } } }).join().includes('=x'), 'the key\'s value is never printed');
    assert.match(run(r, 'ts', 'pilot-1', { deps: { configProblems: () => ['CLAUDE.md is in the folder'] } }).join(), /CLAUDE\.md is in the folder/);
    assert.match(run(r, 'ts', 'nonsense').join(), /not a run name/);
    assert.match(run(r, 'java', 'pilot-1').join(), /no arm java/);
  } finally { r.clean(); }
});

test('DB4, DB5: a run name is used once, the pilots are as many as the record says, and a kept run is one', () => {
  const r = repo();
  try {
    mkdirSync(join(r.root, 'demo', 'baseline', 'runs', 'ts-pilot-1'), { recursive: true });
    assert.match(run(r, 'ts', 'pilot-1').join(), /already has a run named pilot-1/);
    assert.match(run(r, 'ts', 'pilot-2').join(), /allows 1 pilot\(s\).*used/);
    assert.deepEqual(run(r, 'poly', 'pilot-1'), [], 'the other arm\'s pilot is its own');
    mkdirSync(join(r.root, 'demo', 'baseline', 'runs', 'ts-kept'), { recursive: true });
    assert.match(run(r, 'ts', 'kept').join(), /already has a run named kept|already has its kept run/);
  } finally { r.clean(); }
});

test('DB5: a pilot that has run but is not committed yet still counts: a second pilot is refused before the first is committed', async () => {
  const r = repo();
  const runs = mkdtempSync(join(tmpdir(), 'baseline-runs-'));
  try {
    mkdirSync(join(runs, 'ts-pilot-1'), { recursive: true });
    const problems = preflight({ arm: 'ts', run: 'pilot-2', root: r.root, env: {}, runsDir: join(r.root, 'demo', 'baseline', 'runs'), localRunsDir: runs, deps: deps(r) });
    assert.match(problems.join(), /allows 1 pilot\(s\).*used/);
    assert.match(preflight({ arm: 'ts', run: 'pilot-1', root: r.root, env: {}, runsDir: join(r.root, 'demo', 'baseline', 'runs'), localRunsDir: runs, deps: deps(r) }).join(), /already has a run named pilot-1/);
  } finally { r.clean(); rmSync(runs, { recursive: true, force: true }); }
});

test('DB2: the registration is the commit that introduced the record: a later commit that rewrites the record or the prompt does not re-register', () => {
  const rewritten = repo();
  const reworded = repo();
  try {
    const record = JSON.parse(readFileSync(join(rewritten.root, RECORD), 'utf8'));
    record.pilots = { ts: 5, poly: 5 };
    writeFileSync(join(rewritten.root, RECORD), `${JSON.stringify(record, null, 2)}\n`);
    rewritten.sh('commit', '-q', '-a', '-m', 'more pilots');
    assert.match(run(rewritten).join(), /PREREGISTRATION\.json has changed since the pre-registration commit/);
    writeFileSync(join(reworded.root, 'demo', 'baseline', 'PROMPT.md'), 'build something else\n');
    reworded.sh('commit', '-q', '-a', '-m', 'new wording');
    assert.match(run(reworded).join(), /PROMPT\.md has changed since the pre-registration commit/);
  } finally { rewritten.clean(); reworded.clean(); }
});

test('DB3: the record pins the tools: an arm whose tool list is not the recorded one is refused', () => {
  const r = repo({ tweak: (rec) => ({ ...rec, allowedTools: { ...rec.allowedTools, poly: [...rec.allowedTools.poly, 'Bash(npm run poly new*)'] } }) });
  try {
    assert.match(run(r, 'poly', 'pilot-1').join(), /tools of the poly arm are not the recorded ones/);
    assert.deepEqual(run(r, 'ts', 'pilot-1'), [], 'the arm whose list is as recorded may start');
  } finally { r.clean(); }
});

test('DB7: the cost of a run is recorded even when its last event has no newline after it', async () => {
  const r = repo();
  const runs = mkdtempSync(join(tmpdir(), 'baseline-runs-'));
  const stub = join(runs, 'stub.cjs');
  writeFileSync(stub, "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 2.5, usage: { input_tokens: 1, output_tokens: 1 } }));");
  try {
    const { summary } = await runArm({ arm: 'ts', run: 'pilot-1', bin: process.execPath, binArgs: [stub], root: r.root, env: {}, runsDir: runs, configDir: join(runs, 'cfg'), deps: deps(r) });
    assert.deepEqual([summary.stopped, summary.costUsd], ['success', 2.5]);
  } finally { r.clean(); rmSync(runs, { recursive: true, force: true }); }
});

test('DB3: the tool list is not a sandbox, so the session is read after the run for anything that would call a model, and each hit is recorded', async () => {
  const runs = mkdtempSync(join(tmpdir(), 'baseline-runs-'));
  const session = join(runs, 'session.jsonl');
  const use = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  writeFileSync(session, [
    use('Bash', { command: 'npm test' }),
    use('Bash', { command: 'node node_modules/@poly/check/dist/src/cli.js new "a refund agent"' }),
    use('Write', { file_path: 'test/x.test.mjs', content: "import { execSync } from 'node:child_process'; execSync('claude -p hello');" }),
    use('Bash', { command: 'npm run poly check src/agent.poly' }),
    'not json',
  ].join('\n'));
  try {
    const flags = auditSession(session);
    assert.deepEqual(flags.map((x) => [x.tool, x.field]), [['Bash', 'command'], ['Write', 'content']]);
    assert.match(flags[0].excerpt, /cli\.js new/);
    assert.deepEqual(auditSession((() => { writeFileSync(session, use('Bash', { command: 'npm run poly check src/a.poly' })); return session; })()), []);
  } finally { rmSync(runs, { recursive: true, force: true }); }
});

// ---- one run, with a stub agent (nothing is called, nothing costs) -----------------------------------------------------------------

const STUB = `
const events = [
  { type: 'system', subtype: 'init', args: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'ANTHROPIC_API_KEY'].map((k) => [k, process.env[k] ?? null])) },
  { type: 'result', subtype: 'success', total_cost_usd: 1.25, usage: { input_tokens: 10, output_tokens: 5 } },
];
const fs = require('node:fs');
fs.writeFileSync('index.ts', 'export const answer = 42;\\n');
fs.mkdirSync('node_modules/x', { recursive: true });
fs.writeFileSync('node_modules/x/index.js', 'x');
for (const e of events) console.log(JSON.stringify(e));
`;

test('DB3, DB4: one run writes the session as it ran, in a workspace outside the repository, with the recorded model and cap and the arms\' own login folder', async () => {
  const r = repo();
  const runs = mkdtempSync(join(tmpdir(), 'baseline-runs-'));
  const stub = join(runs, 'stub.cjs');
  writeFileSync(stub, STUB);
  try {
    const { dir, workspace, summary } = await runArm({ arm: 'ts', run: 'pilot-1', bin: process.execPath, binArgs: [stub], root: r.root, env: {}, runsDir: runs, configDir: join(runs, 'cfg'), deps: deps(r) });
    assert.ok(!dir.startsWith(r.root), 'outside the repository');
    const events = readFileSync(join(dir, 'session.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const init = events[0];
    assert.equal(init.args[init.args.indexOf('--model') + 1], MODEL);
    assert.equal(init.args[init.args.indexOf('--max-budget-usd') + 1], '25');
    assert.equal(init.args[init.args.indexOf('--append-system-prompt') + 1], armText('ts', r.root));
    assert.equal(init.args[1], promptText(r.root));
    assert.equal(init.cwd, workspace);
    assert.deepEqual(init.env, { CLAUDE_CONFIG_DIR: join(runs, 'cfg'), CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ANTHROPIC_API_KEY: null });
    assert.deepEqual([summary.exit, summary.stopped, summary.costUsd], [0, 'success', 1.25]);
    assert.ok(existsSync(join(workspace, 'index.ts')), 'the stub wrote into the workspace');
    await assert.rejects(runArm({ arm: 'ts', run: 'pilot-1', bin: process.execPath, binArgs: [stub], root: r.root, env: {}, runsDir: runs, deps: deps(r), checks: () => [] }), /not repeated in place/);
  } finally { r.clean(); rmSync(runs, { recursive: true, force: true }); }
});

test('DB4: a run that fails a check is not started: nothing is created', async () => {
  const r = repo({ committed: false });
  const runs = mkdtempSync(join(tmpdir(), 'baseline-runs-'));
  try {
    await assert.rejects(runArm({ arm: 'ts', run: 'pilot-1', bin: process.execPath, binArgs: ['-e', 'process.exit(9)'], root: r.root, env: {}, runsDir: runs, deps: deps(r) }), /not started:\n- .*not committed/s);
    assert.deepEqual(readdirSync(runs), []);
  } finally { r.clean(); rmSync(runs, { recursive: true, force: true }); }
});

test('DB4: a run is committed verbatim: its tree without node_modules, its session, and a record of the tree\'s digest; the commands are printed and nothing is committed', async () => {
  const r = repo();
  const runs = mkdtempSync(join(tmpdir(), 'baseline-runs-'));
  const stub = join(runs, 'stub.cjs');
  writeFileSync(stub, STUB);
  try {
    await runArm({ arm: 'ts', run: 'kept', bin: process.execPath, binArgs: [stub], root: r.root, env: {}, runsDir: runs, configDir: join(runs, 'cfg'), deps: deps(r) });
    const before = r.sh('rev-list', '--count', 'HEAD');
    const commands = prepareCommit({ arm: 'ts', run: 'kept', runsDir: runs, root: r.root });
    const to = join(r.root, 'demo', 'baseline', 'runs', 'ts-kept');
    assert.ok(existsSync(join(to, 'tree', 'index.ts')) && !existsSync(join(to, 'tree', 'node_modules')));
    assert.ok(existsSync(join(to, 'session.jsonl')));
    const rec = JSON.parse(readFileSync(join(to, 'RECORD.json'), 'utf8'));
    assert.equal(rec.treeDigest, treeDigest(join(to, 'tree')));
    assert.deepEqual([rec.arm, rec.run, rec.model, rec.promptSha256, rec.costUsd], ['ts', 'kept', MODEL, JSON.parse(readFileSync(join(r.root, RECORD), 'utf8')).prompt.sha256, 1.25]);
    assert.match(commands[0], /^git add demo\/baseline\/runs\/ts-kept$/);
    assert.match(commands[1], /^git commit .*verbatim before anything is run against it/);
    assert.match(commands[2], /git rev-parse HEAD:demo\/baseline\/runs\/ts-kept\/tree/);
    assert.equal(r.sh('rev-list', '--count', 'HEAD'), before, 'nothing was committed');
    assert.throws(() => prepareCommit({ arm: 'ts', run: 'kept', runsDir: runs, root: r.root }), /a run is committed once/);
  } finally { r.clean(); rmSync(runs, { recursive: true, force: true }); }
});

test('Step 10: the committed drafts name no key, start nothing by themselves, and the repository holds no record yet', () => {
  assert.ok(!existsSync(join(ROOT, RECORD)), 'the pre-registration is the owner\'s commit: no record is committed with the drafts');
  assert.ok(!existsSync(join(ROOT, 'demo', 'baseline', 'runs')));
  for (const f of listFiles(join(ROOT, 'demo', 'baseline')).filter((p) => /\.mjs$/.test(p))) {
    assert.doesNotMatch(readFileSync(join(ROOT, 'demo', 'baseline', f), 'utf8'), /sk-ant|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN/, f);
  }
});
