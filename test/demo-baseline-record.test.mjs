// Tests for DB12 and DB13: the record says what happened, and a pre-registration amendment.
// Spec sections: Amendment 1 (2026-10-16): DB10 to DB14, DB3 and DB5.
// Rule 7a: failing tests from the specification, written before the implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runArm, prepareCommit, preflight, effectiveRecord, buildRecord, RECORD } from '../demo/baseline/procedure.mjs';

const ROOT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// The keys that no amendment may set (DB13 item 3).
const IMMUTABLE = ['prompt', 'armTexts', 'model', 'claudeCode', 'billing', 'network', 'maxTurns', 'capsUsd', 'polyReference'];
const DEPS = { claudeVersion: () => '2.1.287', scaffold: () => 'sha256:ts', reference: () => ({ files: ['README.md'], listSha256: 'sha256:list', treeSha256: 'sha256:tree' }), configProblems: () => [], smoke: () => ({ ok: true, steps: [] }) };
const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

// Helper: build a throwaway git repository with a base record and optional amendments.
function gitRepo({ amendments = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'baseline-amend-'));
  const sh = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(root, 'demo', 'baseline'), { recursive: true });
  const base = buildRecord({ root: ROOT_DIR, version: '2.1.287', scaffolds: { ts: 'sha256:ts', poly: 'sha256:poly' }, reference: { files: ['README.md'], listSha256: 'sha256:list', treeSha256: 'sha256:tree' } });
  writeFileSync(join(root, RECORD), JSON.stringify(base, null, 2) + '\n');
  sh('init', '-q');
  sh('config', 'user.name', 'test');
  sh('config', 'user.email', 'test@example.invalid');
  sh('config', 'commit.gpgsign', 'false');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'pre-registration');
  const amendmentCommits = {};
  for (const [n, given] of amendments.entries()) {
    const amend = { ...given, keeps: given.keeps ?? Object.fromEntries(IMMUTABLE.map((k) => [k, base[k]])) };
    writeFileSync(join(root, `demo/baseline/PREREGISTRATION.amendment-${n + 1}.json`), JSON.stringify(amend, null, 2) + '\n');
    sh('add', '-A');
    sh('commit', '-q', '-m', `amendment ${n + 1}`);
    amendmentCommits[n + 1] = sh('rev-parse', 'HEAD');
  }
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { root, base, git, amendmentCommits, clean: () => rmSync(root, { recursive: true, force: true }) };
}

// ---- Test A: runArm with stub agent ----

test('A: runArm builds workspace, writes run files, and returns the correct paths (DB10, DB12)', async () => {
  // The stub writes src/agent.ts and rewrites package.json, so initial.json reflects the workspace before changes.
  const r = gitRepo();
  const runsDir = mkdtempSync(join(tmpdir(), 'baseline-runs-'));
  const workDirRoot = mkdtempSync(join(tmpdir(), 'baseline-work-'));
  const stub = join(runsDir, 'stub.cjs');
  writeFileSync(stub, `
const fs = require('node:fs');
const path = require('node:path');
console.log(JSON.stringify({ type: 'system', subtype: 'init', args: process.argv.slice(2), cwd: process.cwd(), env: { POLY_DEMO_WORKSPACE: process.env.POLY_DEMO_WORKSPACE } }));
fs.writeFileSync('src/agent.ts', 'export const x = 1;\\n');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.author = 'stub';
fs.writeFileSync('package.json', JSON.stringify(pkg) + '\\n');
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'FINAL TEXT', total_cost_usd: 1.25, usage: { input_tokens: 10, output_tokens: 5 } }));
`);
  try {
    const { dir, workspace, summary } = await runArm({
      arm: 'ts', run: 'pilot-1', bin: process.execPath, binArgs: [stub],
      root: r.root, env: {}, runsDir, workDir: workDirRoot, configDir: join(runsDir, 'cfg'),
      checks: () => [], deps: DEPS
    });
    // (1) workspace equals path.join(workDir, 'ts-pilot-1'), run folder is in runsDir.
    assert.equal(workspace, join(workDirRoot, 'ts-pilot-1'), 'workspace path');
    assert.equal(dir, join(runsDir, 'ts-pilot-1'), 'run folder path');
    assert.ok(!workspace.includes(dir), 'workspace not inside run folder');
    assert.ok(!workspace.startsWith(r.root), 'workspace not in repository root');
    // (2) stub saw the workspace in POLY_DEMO_WORKSPACE.
    const sessionEvents = readFileSync(join(dir, 'session.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const initEvent = sessionEvents.find(e => e.type === 'system' && e.subtype === 'init');
    assert.equal(initEvent.env.POLY_DEMO_WORKSPACE, workspace, 'workspace passed to stub');
    // (3) result.json has the required fields from DB12.
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    assert.equal(result.arm, 'ts', 'result.arm');
    assert.equal(result.run, 'pilot-1', 'result.run');
    assert.equal(result.sdkResult, 'success', 'result.sdkResult');
    assert.equal(result.finalMessage, 'FINAL TEXT', 'result.finalMessage');
    assert.equal(result.workspace, workspace, 'result.workspace');
    assert.equal(result.costUsd, 1.25, 'result.costUsd');
    assert.equal(typeof result.usage, 'object', 'result.usage is object');
    assert.ok(!('stopped' in result), 'result has no stopped field');
    assert.ok('exit' in result, 'result has exit field');
    assert.ok('startedWith' in result, 'result has startedWith field');
    assert.ok('stderrTail' in result, 'result has stderrTail field');
    assert.ok('error' in result, 'result has error field');
    assert.ok('modelCallFlags' in result, 'result has modelCallFlags field');
    // (4) initial.json exists with harness file hashes.
    const initial = JSON.parse(readFileSync(join(dir, 'initial.json'), 'utf8'));
    assert.equal(typeof initial, 'object', 'initial.json is an object');
    assert.ok(initial['package.json'], 'initial.json has package.json hash');
    assert.match(initial['package.json'], /^sha256:[0-9a-f]{64}$|^[0-9a-f]{64}$/, 'hash format');
    // The stub changed package.json, so its hash differs.
    const pkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
    assert.equal(pkg.author, 'stub', 'package.json was rewritten by stub');
  } finally { r.clean(); rmSync(runsDir, { recursive: true, force: true }); rmSync(workDirRoot, { recursive: true, force: true }); }
});

// ---- Test B: prepareCommit after runArm ----

test('B: prepareCommit writes RECORD.json with sdkResult, agentFiles, agentFilePaths, audit, and no stopped field (DB12)', async () => {
  // Build a run folder and workspace by hand to test prepareCommit's record generation.
  const r = gitRepo();
  const runsDir = mkdtempSync(join(tmpdir(), 'baseline-runs-'));
  const workDirRoot = mkdtempSync(join(tmpdir(), 'baseline-work-'));
  const workspace = join(workDirRoot, 'ts-pilot-1');
  const runDir = join(runsDir, 'ts-pilot-1');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(workspace, 'package.json'), '{}');
  writeFileSync(join(workspace, 'src', 'agent.ts'), 'export const x = 1;');
  writeFileSync(join(workspace, 'node_modules', 'x', 'index.js'), 'module.exports = x;');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({
    arm: 'ts', run: 'pilot-1', exit: 0, startedWith: {}, sdkResult: 'success',
    finalMessage: 'test complete', workspace, costUsd: 1.5, usage: { input_tokens: 10, output_tokens: 5 },
    stderrTail: '', error: null, modelCallFlags: {}
  }));
  writeFileSync(join(runDir, 'initial.json'), JSON.stringify({
    'package.json': sha('{}')
  }));
  writeFileSync(join(runDir, 'session.jsonl'), '');
  try {
    const commands = await prepareCommit({ arm: 'ts', run: 'pilot-1', runsDir, workDir: workDirRoot, root: r.root });
    // Check RECORD.json has the new format.
    const recordPath = join(r.root, 'demo', 'baseline', 'runs', 'ts-pilot-1', 'RECORD.json');
    assert.ok(existsSync(recordPath), 'RECORD.json created');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(record.arm, 'ts', 'record.arm');
    assert.equal(record.run, 'pilot-1', 'record.run');
    assert.equal(record.sdkResult, 'success', 'record.sdkResult');
    assert.match(record.sdkResultMeans, /./, 'record.sdkResultMeans non-empty');
    assert.equal(record.agentFiles, 1, 'record.agentFiles counts src/agent.ts, not node_modules');
    assert.deepEqual(record.agentFilePaths, ['src/agent.ts'], 'record.agentFilePaths sorted');
    assert.equal(record.finalMessage, 'test complete', 'record.finalMessage verbatim');
    assert.equal(typeof record.audit, 'object', 'record.audit is object');
    assert.equal(record.audit.status, 'clean', 'record.audit.status');
    assert.equal(typeof record.audit.calls, 'object', 'record.audit.calls');
    assert.ok(!('stopped' in record), 'record has no stopped field');
    assert.equal(record.costUsd, 1.5, 'record.costUsd');
    // Check prepareCommit returns command strings including git add.
    assert.ok(Array.isArray(commands), 'returns array');
    assert.ok(commands.some(c => /^git add/.test(c)), 'includes git add command');
    // Calling twice throws.
    assert.throws(() => prepareCommit({ arm: 'ts', run: 'pilot-1', runsDir, workDir: workDirRoot, root: r.root }), /exists/);
  } finally { r.clean(); rmSync(runsDir, { recursive: true, force: true }); rmSync(workDirRoot, { recursive: true, force: true }); }
});

// ---- Test C: effectiveRecord with git amendments ----

test('C: effectiveRecord reads the base record and overlays amendment sets in order (DB13)', async () => {
  // Build a repo with a base record and two amendments.
  const amendment1 = {
    v: 1, amendment: 1, reason: 'test',
    findings: ['H1'],
    set: { pilots: { ts: 2, poly: 2 } },
    excluded: []
  };
  const amendment2 = {
    v: 1, amendment: 2, reason: 'test 2',
    findings: ['H2'],
    set: { pilots: { ts: 3, poly: 3 } },
    excluded: []
  };
  const r = gitRepo({ amendments: [amendment1, amendment2] });
  try {
    const result = effectiveRecord({ root: r.root, git: r.git });
    // Base commit recorded.
    assert.equal(typeof result.base, 'string', 'base is commit hash');
    assert.equal(result.base.length, 40, 'base is full hash');
    // Record has amendments overlay applied.
    assert.equal(result.record.pilots.ts, 3, 'amendment 2 set wins');
    assert.equal(result.record.pilots.poly, 3, 'amendment 2 set wins for poly');
    // Base keys unchanged.
    assert.equal(typeof result.record.model, 'string', 'model from base');
    // Amendments list in order.
    assert.equal(result.amendments.length, 2, 'two amendments');
    assert.equal(result.amendments[0].n, 1, 'amendment 0 is n=1');
    assert.equal(result.amendments[1].n, 2, 'amendment 1 is n=2');
    assert.equal(typeof result.amendments[0].commit, 'string', 'amendment commit is hash');
    assert.equal(result.amendments[0].commit.length, 40, 'amendment commit is full hash');
  } finally { r.clean(); }
});

test('C: effectiveRecord with no amendment returns amendments=[] (DB13)', async () => {
  const r = gitRepo({ amendments: [] });
  try {
    const result = effectiveRecord({ root: r.root, git: r.git });
    assert.deepEqual(result.amendments, [], 'no amendments');
  } finally { r.clean(); }
});

// ---- Test D: preflight refusals for amendments ----

test('D: preflight refuses amendment setting immutable keys (DB13)', async () => {
  // Amendment that tries to change prompt.
  const bad = {
    v: 1, amendment: 1, reason: 'test', findings: [],
    set: { prompt: 'sha256:other' },
    excluded: []
  };
  const r = gitRepo({ amendments: [bad] });
  try {
    const problems = preflight({ arm: 'ts', run: 'pilot-1', root: r.root, env: {}, runsDir: join(r.root, 'demo', 'baseline', 'runs'), localRunsDir: join(tmpdir(), 'baseline-local-'), deps: DEPS });
    assert.ok(problems.length > 0, 'problems reported');
    assert.ok(problems.some(p => /prompt/.test(p) && /amendment/.test(p)), 'mentions prompt and amendment');
  } finally { r.clean(); }
});

test('D: preflight refuses amendment whose keeps differs from effective record (DB13)', async () => {
  const amendment1 = {
    v: 1, amendment: 1, reason: 'test', findings: [],
    set: { pilots: { ts: 2, poly: 2 } },
    excluded: []
  };
  const amendment2 = {
    v: 1, amendment: 2, reason: 'test 2', findings: [],
    keeps: { prompt: 'p', armTexts: { ts: 's', poly: 'different' } },
    set: { pilots: { ts: 3, poly: 3 } },
    excluded: []
  };
  const r = gitRepo({ amendments: [amendment1, amendment2] });
  try {
    const problems = preflight({ arm: 'ts', run: 'pilot-1', root: r.root, env: {}, runsDir: join(r.root, 'demo', 'baseline', 'runs'), localRunsDir: join(tmpdir(), 'baseline-local-'), deps: DEPS });
    assert.ok(problems.length > 0, 'problems reported');
    assert.ok(problems.some(p => /keeps/.test(p) || /arm/.test(p)), 'mentions keeps or arm');
  } finally { r.clean(); }
});

test('D: preflight refuses amendment file that is not committed (DB13)', async () => {
  const r = gitRepo({ amendments: [] });
  try {
    // Write an amendment but don't commit it.
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-1.json'), JSON.stringify({
      v: 1, amendment: 1, reason: 'test', findings: [], keeps: {}, set: {}, excluded: []
    }));
    const problems = preflight({ arm: 'ts', run: 'pilot-1', root: r.root, env: {}, runsDir: join(r.root, 'demo', 'baseline', 'runs'), localRunsDir: join(tmpdir(), 'baseline-local-'), deps: DEPS });
    assert.ok(problems.length > 0, 'problems reported');
    assert.ok(problems.some(p => /not committed|uncommitted/.test(p)), 'mentions commit');
  } finally { r.clean(); }
});

test('D: preflight refuses amendment with a gap in numbering (DB13)', async () => {
  const amendment2 = {
    v: 1, amendment: 2, reason: 'test', findings: [],
    set: { pilots: { ts: 2, poly: 2 } },
    excluded: []
  };
  const r = gitRepo({ amendments: [amendment2] });
  try {
    const problems = preflight({ arm: 'ts', run: 'pilot-1', root: r.root, env: {}, runsDir: join(r.root, 'demo', 'baseline', 'runs'), localRunsDir: join(tmpdir(), 'baseline-local-'), deps: DEPS });
    assert.ok(problems.length > 0, 'problems reported');
    assert.ok(problems.some(p => /amendment.*1|gap/.test(p)), 'mentions amendment 1 or gap');
  } finally { r.clean(); }
});

test('D: preflight refuses amendment when smoke test fails (DB10, DB13)', async () => {
  const amendment1 = {
    v: 1, amendment: 1, reason: 'test', findings: [],
    set: { pilots: { ts: 2, poly: 2 } },
    excluded: []
  };
  const r = gitRepo({ amendments: [amendment1] });
  try {
    const problems = preflight({ arm: 'ts', run: 'pilot-1', root: r.root, env: {}, runsDir: join(r.root, 'demo', 'baseline', 'runs'), localRunsDir: join(tmpdir(), 'baseline-local-'), deps: { ...DEPS, smoke: () => ({ ok: false, steps: [{ name: 'install', ok: false, detail: 'boom' }] }) } });
    assert.ok(problems.length > 0, 'problems reported');
    assert.ok(problems.some(p => /install|boom/.test(p)), 'mentions install and detail');
  } finally { r.clean(); }
});

test('D: preflight passes when smoke test succeeds (DB10, DB13)', async () => {
  const amendment1 = {
    v: 1, amendment: 1, reason: 'test', findings: [],
    set: { pilots: { ts: 2, poly: 2 } },
    excluded: []
  };
  const r = gitRepo({ amendments: [amendment1] });
  try {
    const problems = preflight({ arm: 'ts', run: 'pilot-1', root: r.root, env: {}, runsDir: join(r.root, 'demo', 'baseline', 'runs'), localRunsDir: join(tmpdir(), 'baseline-local-'), deps: DEPS });
    assert.deepEqual(problems, [], 'no problems');
  } finally { r.clean(); }
});

// ---- Test E: Pilot naming ----

test('E: pilot-2 is allowed when amendment sets pilots to 2 and pilot-1 is taken (DB13)', async () => {
  const amendment1 = {
    v: 1, amendment: 1, reason: 'test', findings: [],
    set: { pilots: { ts: 2, poly: 1 } },
    excluded: []
  };
  const r = gitRepo({ amendments: [amendment1] });
  const runsDir = join(r.root, 'demo', 'baseline', 'runs');
  mkdirSync(join(runsDir, 'ts-pilot-1'), { recursive: true });
  try {
    const problems = preflight({ arm: 'ts', run: 'pilot-2', root: r.root, env: {}, runsDir, localRunsDir: join(tmpdir(), 'baseline-local-'), deps: DEPS });
    assert.deepEqual(problems, [], 'pilot-2 allowed');
  } finally { r.clean(); }
});

test('E: pilot-3 is refused when only 2 pilots allowed, naming pilot-2 as next (DB13)', async () => {
  const amendment1 = {
    v: 1, amendment: 1, reason: 'test', findings: [],
    set: { pilots: { ts: 2, poly: 1 } },
    excluded: []
  };
  const r = gitRepo({ amendments: [amendment1] });
  const runsDir = join(r.root, 'demo', 'baseline', 'runs');
  mkdirSync(join(runsDir, 'ts-pilot-1'), { recursive: true });
  mkdirSync(join(runsDir, 'ts-pilot-2'), { recursive: true });
  try {
    const problems = preflight({ arm: 'ts', run: 'pilot-3', root: r.root, env: {}, runsDir, localRunsDir: join(tmpdir(), 'baseline-local-'), deps: DEPS });
    assert.ok(problems.length > 0, 'problems reported');
    assert.ok(problems.some(p => /pilot-2|allows/.test(p)), 'names pilot-2');
  } finally { r.clean(); }
});

test('E: pilot name in excluded stays taken (DB13)', async () => {
  const amendment1 = {
    v: 1, amendment: 1, reason: 'test', findings: ['H1'],
    set: { pilots: { ts: 2, poly: 1 } },
    excluded: [
      { arm: 'ts', run: 'pilot-1', commit: '90eee290', tree: 'f3be07cd', findings: ['H3'], note: 'test' }
    ]
  };
  const r = gitRepo({ amendments: [amendment1] });
  try {
    const problems = preflight({ arm: 'ts', run: 'pilot-1', root: r.root, env: {}, runsDir: join(r.root, 'demo', 'baseline', 'runs'), localRunsDir: join(tmpdir(), 'baseline-local-'), deps: DEPS });
    assert.ok(problems.length > 0, 'problems reported');
    assert.ok(problems.some(p => /already|taken|pilot-1/.test(p)), 'names pilot-1 as taken');
  } finally { r.clean(); }
});

test('E: without amendment pilots default to 1, pilot-2 is refused (DB5, DB13)', async () => {
  const r = gitRepo({ amendments: [] });
  try {
    const problems = preflight({ arm: 'ts', run: 'pilot-2', root: r.root, env: {}, runsDir: join(r.root, 'demo', 'baseline', 'runs'), localRunsDir: join(tmpdir(), 'baseline-local-'), deps: DEPS });
    assert.ok(problems.length > 0, 'problems reported');
    assert.ok(problems.some(p => /pilot.*1|allows 1/.test(p)), 'mentions only 1 pilot allowed');
  } finally { r.clean(); }
});

// ---- More DB13 refusals, each with its own reason ----

const pre = (r, arm = 'ts', run = 'pilot-1') => preflight({ arm, run, root: r.root, env: {}, runsDir: join(r.root, 'demo', 'baseline', 'runs'), localRunsDir: join(tmpdir(), 'baseline-local-'), deps: DEPS });

// Catches an amendment check that guards some of the nine immutable keys and not all of them.
test('D: an amendment that sets any one of the nine immutable keys is refused, by name', () => {
  for (const key of IMMUTABLE) {
    const r = gitRepo({ amendments: [{ v: 1, amendment: 1, reason: 'test', findings: [], set: { [key]: 'changed' }, excluded: [] }] });
    try {
      assert.match(pre(r).join('\n'), new RegExp(`amendment 1[^\\n]*${key}|${key}[^\\n]*amendment 1`), key);
    } finally { r.clean(); }
  }
});

// Catches a keeps check that is skipped, or that refuses without naming the key that differs.
test('D: an amendment whose keeps differs from the effective record is refused, and names the key', () => {
  const base = buildRecord({ root: ROOT_DIR, version: '2.1.287', scaffolds: { ts: 'a', poly: 'b' }, reference: { files: [], listSha256: 'c', treeSha256: 'd' } });
  const keeps = Object.fromEntries(IMMUTABLE.map((k) => [k, base[k]]));
  keeps.model = 'another-model';
  const r = gitRepo({ amendments: [{ v: 1, amendment: 1, reason: 'test', findings: [], keeps, set: { pilots: { ts: 2, poly: 2 } }, excluded: [] }] });
  try {
    assert.match(pre(r).join('\n'), /keeps[^\n]*model|model[^\n]*keeps/);
  } finally { r.clean(); }
});

// Catches a check that reads the amendment as it is on disk and not as it was committed (DB13 item 3).
test('D: an amendment file changed in a later commit is refused', () => {
  const r = gitRepo({ amendments: [{ v: 1, amendment: 1, reason: 'test', findings: [], set: { pilots: { ts: 2, poly: 2 } }, excluded: [] }] });
  try {
    assert.deepEqual(pre(r), [], 'the committed amendment is accepted');
    const file = join(r.root, 'demo', 'baseline', 'PREREGISTRATION.amendment-1.json');
    writeFileSync(file, JSON.stringify({ v: 1, amendment: 1, reason: 'rewritten', findings: [], set: { pilots: { ts: 9, poly: 9 } }, excluded: [] }));
    r.git(['commit', '-q', '-a', '-m', 'rewrite the amendment']);
    assert.match(pre(r).join('\n'), /amendment 1[^\n]*changed|changed[^\n]*amendment 1|PREREGISTRATION\.amendment-1\.json has changed/);
  } finally { r.clean(); }
});

// Catches a count that counts a harness file the agent never touched.
test('B: a harness file that the agent changed counts in agentFiles, and one that it left alone does not', async () => {
  const r = gitRepo();
  const runsDir = mkdtempSync(join(tmpdir(), 'baseline-runs-'));
  const workDirRoot = mkdtempSync(join(tmpdir(), 'baseline-work-'));
  const workspace = join(workDirRoot, 'poly-pilot-2');
  const runDir = join(runsDir, 'poly-pilot-2');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(workspace, 'package.json'), '{"changed":true}');
  writeFileSync(join(workspace, 'orders.json'), '[]');
  writeFileSync(join(runDir, 'initial.json'), JSON.stringify({ 'package.json': sha('{}'), 'orders.json': sha('[]') }));
  writeFileSync(join(runDir, 'session.jsonl'), '');
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({ arm: 'poly', run: 'pilot-2', exit: 0, startedWith: {}, sdkResult: 'success', finalMessage: '', workspace, costUsd: 0, usage: {}, stderrTail: '', error: null, modelCallFlags: [] }));
  try {
    await prepareCommit({ arm: 'poly', run: 'pilot-2', runsDir, workDir: workDirRoot, root: r.root });
    const record = JSON.parse(readFileSync(join(r.root, 'demo', 'baseline', 'runs', 'poly-pilot-2', 'RECORD.json'), 'utf8'));
    assert.equal(record.agentFiles, 1);
    assert.deepEqual(record.agentFilePaths, ['package.json']);
  } finally { r.clean(); rmSync(runsDir, { recursive: true, force: true }); rmSync(workDirRoot, { recursive: true, force: true }); }
});

// Catches a record that calls a run with no file of its own anything but zero files (the H3 case).
test('B: a run that wrote no file of its own has agentFiles 0 and agentFilePaths [], whatever the agent called its result', async () => {
  const r = gitRepo();
  const runsDir = mkdtempSync(join(tmpdir(), 'baseline-runs-'));
  const workDirRoot = mkdtempSync(join(tmpdir(), 'baseline-work-'));
  const workspace = join(workDirRoot, 'poly-pilot-3');
  const runDir = join(runsDir, 'poly-pilot-3');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(workspace, 'package.json'), '{}');
  writeFileSync(join(runDir, 'initial.json'), JSON.stringify({ 'package.json': sha('{}') }));
  writeFileSync(join(runDir, 'session.jsonl'), '');
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({ arm: 'poly', run: 'pilot-3', exit: 0, startedWith: {}, sdkResult: 'success', finalMessage: 'I broke the toolchain', workspace, costUsd: 0.99, usage: {}, stderrTail: '', error: null, modelCallFlags: [] }));
  try {
    await prepareCommit({ arm: 'poly', run: 'pilot-3', runsDir, workDir: workDirRoot, root: r.root });
    const record = JSON.parse(readFileSync(join(r.root, 'demo', 'baseline', 'runs', 'poly-pilot-3', 'RECORD.json'), 'utf8'));
    assert.equal(record.sdkResult, 'success');
    assert.equal(record.agentFiles, 0);
    assert.deepEqual(record.agentFilePaths, []);
    assert.equal(record.finalMessage, 'I broke the toolchain');
  } finally { r.clean(); rmSync(runsDir, { recursive: true, force: true }); rmSync(workDirRoot, { recursive: true, force: true }); }
});

// ---- Test F: The prepared amendment 1 file ----

test('F: PREREGISTRATION.amendment-1.json exists and has the correct structure (DB13)', () => {
  // The file must exist; a missing file must FAIL the test.
  const path = join(ROOT_DIR, 'demo/baseline/PREREGISTRATION.amendment-1.json');
  const content = readFileSync(path, 'utf8');
  const amend = JSON.parse(content);
  // Check structure.
  assert.equal(amend.v, 1, 'v is 1');
  assert.equal(amend.amendment, 1, 'amendment is 1');
  assert.ok('reason' in amend, 'has reason');
  assert.ok('findings' in amend, 'has findings');
  assert.ok('keeps' in amend, 'has keeps');
  assert.ok('set' in amend, 'has set');
  assert.ok('excluded' in amend, 'has excluded');
});

test('F: amendment-1 keeps all immutable keys from base record (DB13)', () => {
  const path = join(ROOT_DIR, 'demo/baseline/PREREGISTRATION.amendment-1.json');
  const content = readFileSync(path, 'utf8');
  const amend = JSON.parse(content);
  const base = JSON.parse(readFileSync(join(ROOT_DIR, RECORD), 'utf8'));
  // keeps must include the nine immutable keys.
  for (const key of ['prompt', 'armTexts', 'model', 'claudeCode', 'billing', 'network', 'maxTurns', 'capsUsd', 'polyReference']) {
    assert.ok(key in amend.keeps, `keeps has ${key}`);
    assert.deepEqual(amend.keeps[key], base[key], `${key} unchanged`);
  }
  // set must not contain any immutable key.
  for (const key of ['prompt', 'armTexts', 'model', 'claudeCode', 'billing', 'network', 'maxTurns', 'capsUsd', 'polyReference']) {
    assert.ok(!(key in amend.set), `set does not have ${key}`);
  }
});

test('F: amendment-1 set has the required keys (DB13)', () => {
  const path = join(ROOT_DIR, 'demo/baseline/PREREGISTRATION.amendment-1.json');
  const content = readFileSync(path, 'utf8');
  const amend = JSON.parse(content);
  const set = amend.set;
  // Check required keys in set.
  assert.ok('allowedTools' in set, 'set has allowedTools');
  assert.ok('disallowedTools' in set, 'set has disallowedTools');
  assert.ok('tools' in set, 'set has tools');
  assert.ok('settings' in set, 'set has settings');
  assert.ok('hook' in set, 'set has hook');
  assert.ok('scaffolds' in set, 'set has scaffolds');
  assert.ok('pilots' in set, 'set has pilots');
  // Check types.
  assert.deepEqual(set.pilots, { ts: 2, poly: 2 }, 'pilots are ts:2, poly:2');
  assert.equal(typeof set.settings, 'object', 'settings is object');
  assert.equal(typeof set.hook, 'object', 'hook is object');
  assert.ok('sha256' in set.settings || 'sha256' in set.hook, 'has sha256 fields');
});

test('F: amendment-1 excluded records the two pilot runs (DB13)', () => {
  const path = join(ROOT_DIR, 'demo/baseline/PREREGISTRATION.amendment-1.json');
  const content = readFileSync(path, 'utf8');
  const amend = JSON.parse(content);
  assert.equal(amend.excluded.length, 2, 'exactly two excluded runs');
  const ts = amend.excluded.find(e => e.arm === 'ts');
  const poly = amend.excluded.find(e => e.arm === 'poly');
  assert.ok(ts, 'ts-pilot-1 in excluded');
  assert.ok(poly, 'poly-pilot-1 in excluded');
  // Check structure.
  assert.equal(ts.run, 'pilot-1', 'ts run is pilot-1');
  assert.ok(/^90eee290/.test(ts.commit), 'ts commit starts 90eee290');
  assert.ok(/^f3be07cd/.test(ts.tree), 'ts tree starts f3be07cd');
  assert.ok(Array.isArray(ts.findings), 'ts findings is array');
  assert.equal(poly.run, 'pilot-1', 'poly run is pilot-1');
  assert.ok(/^20f7054c/.test(poly.commit), 'poly commit starts 20f7054c');
  assert.ok(/^d02b8170/.test(poly.tree), 'poly tree starts d02b8170');
  assert.deepEqual(poly.findings, ['H1', 'H2', 'H3'], 'poly findings all three');
});
