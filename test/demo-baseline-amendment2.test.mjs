// Tests for DB13 item 6 and DB16, DB17: buildAmendment(2) builds amendment 2 without writing it,
// which answers findings H5 and H6.
// Spec sections: Amendment 2 (2026-10-17): DB13 item 6, DB16 items 1 and 2, DB17.
// Rule 7a: failing tests from the specification, written before the implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveRecord, RECORD } from '../demo/baseline/procedure.mjs';
import { buildAmendment } from '../demo/baseline/amendments.mjs';
import { scaffoldDigest } from '../demo/baseline/arms.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const git = (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Committed data: amendment 1 and the base record (DB13 item 6).
function readCommittedAmendment(n) {
  const hash = n === 1 ? '1b9493fc' : null;
  if (!hash) throw new Error('only amendment 1 is committed');
  const output = git(['show', `${hash}:demo/baseline/PREREGISTRATION.amendment-${n}.json`]);
  return JSON.parse(output);
}

function readCommittedRecord() {
  const output = git(['show', `1b9493fc:${RECORD}`]);
  return JSON.parse(output);
}

// Get the effective record before amendment 2 (base record with amendment 1 applied).
function getEffectiveRecordBefore() {
  const amend1 = readCommittedAmendment(1);
  const r = gitRepo({ amendments: [amend1] });
  try {
    const eff = effectiveRecord({ root: r.root, git: r.git });
    return eff.record;
  } finally { r.clean(); }
}

// Get commit hash and tree for poly-pilot-2.
function getPoly2CommitAndTree() {
  const commits = git(['log', '--diff-filter=A', '--format=%H', '--', 'demo/baseline/runs/poly-pilot-2/RECORD.json']).split('\n').filter(Boolean);
  const commit = commits[commits.length - 1];
  const tree = git(['rev-parse', `${commit}:demo/baseline/runs/poly-pilot-2/tree`]);
  return { commit, tree };
}

// Helper: build a throwaway git repository with base record and amendments for acceptance test.
function gitRepo({ amendments = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'baseline-amend2-'));
  const sh = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(root, 'demo', 'baseline'), { recursive: true });
  for (const name of ['PROMPT.md', 'arm-ts.md', 'arm-poly.md', 'orders.json']) copyFileSync(join(ROOT, 'demo', 'baseline', name), join(root, 'demo', 'baseline', name));
  const base = readCommittedRecord();
  writeFileSync(join(root, RECORD), JSON.stringify(base, null, 2) + '\n');
  sh('init', '-q');
  sh('config', 'user.name', 'test');
  sh('config', 'user.email', 'test@example.invalid');
  sh('config', 'commit.gpgsign', 'false');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'pre-registration');
  for (const [n, given] of amendments.entries()) {
    writeFileSync(join(root, `demo/baseline/PREREGISTRATION.amendment-${n + 1}.json`), JSON.stringify(given, null, 2) + '\n');
    sh('add', '-A');
    sh('commit', '-q', '-m', `amendment ${n + 1}`);
  }
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { root, base, git, clean: () => rmSync(root, { recursive: true, force: true }) };
}

// Build amendment 2 at top level for all tests.
const amendment2 = await buildAmendment(2, { root: ROOT, git });

// 1. Shape: v 1, amendment 2, a reason string, findings with keys H5 and H6 (non-empty strings).
test('1: amendment 2 has v 1 and amendment 2', async () => {
  assert.equal(amendment2.v, 1, 'v is 1');
  assert.equal(amendment2.amendment, 2, 'amendment is 2');
});

test('1: amendment 2 has reason string', async () => {
  assert.equal(typeof amendment2.reason, 'string', 'reason is string');
  assert.ok(amendment2.reason.length > 0, 'reason is non-empty');
});

test('1: amendment 2 has findings with H5 and H6', async () => {
  assert.ok(typeof amendment2.findings === 'object', 'findings is object');
  assert.ok('H5' in amendment2.findings, 'findings has H5 key');
  assert.ok('H6' in amendment2.findings, 'findings has H6 key');
  assert.equal(typeof amendment2.findings.H5, 'string', 'H5 is string');
  assert.ok(amendment2.findings.H5.length > 0, 'H5 is non-empty');
  assert.equal(typeof amendment2.findings.H6, 'string', 'H6 is string');
  assert.ok(amendment2.findings.H6.length > 0, 'H6 is non-empty');
});

test('1: amendment 2 has keeps, set, excluded, and limits', async () => {
  assert.ok('keeps' in amendment2, 'has keeps');
  assert.ok('set' in amendment2, 'has set');
  assert.ok('excluded' in amendment2, 'has excluded');
  assert.ok('limits' in amendment2, 'has limits');
});

// 2. excluded has exactly one entry: arm poly, run pilot-2, correct commit and tree, findings containing H5.
test('2: amendment 2 excluded has exactly one entry', async () => {
  assert.equal(amendment2.excluded.length, 1, 'excluded has exactly one entry');
});

test('2: excluded entry is poly-pilot-2', async () => {
  const entry = amendment2.excluded[0];
  assert.equal(entry.arm, 'poly', 'excluded arm is poly');
  assert.equal(entry.run, 'pilot-2', 'excluded run is pilot-2');
});

test('2: excluded entry has correct commit (derived from git)', async () => {
  const entry = amendment2.excluded[0];
  const { commit: expectedCommit } = getPoly2CommitAndTree();
  assert.equal(entry.commit, expectedCommit, 'commit matches git log result');
  assert.equal(entry.commit.length, 40, 'commit is full hash (40 hex chars)');
  assert.match(entry.commit, /^c8aaeb95/, 'commit starts with c8aaeb95');
});

test('2: excluded entry has correct tree (derived from git)', async () => {
  const entry = amendment2.excluded[0];
  const { tree: expectedTree } = getPoly2CommitAndTree();
  assert.equal(entry.tree, expectedTree, 'tree matches git rev-parse result');
});

test('2: excluded entry findings contains H5', async () => {
  const entry = amendment2.excluded[0];
  assert.ok(Array.isArray(entry.findings), 'findings is array');
  assert.ok(entry.findings.includes('H5'), 'findings contains H5');
});

test('2: excluded entry has non-empty note', async () => {
  const entry = amendment2.excluded[0];
  assert.equal(typeof entry.note, 'string', 'note is string');
  assert.ok(entry.note.length > 0, 'note is non-empty');
});

test('2: no excluded entry for ts-pilot-2', async () => {
  const tsPilot2 = amendment2.excluded.find(e => e.arm === 'ts' && e.run === 'pilot-2');
  assert.ok(!tsPilot2, 'no excluded entry for ts-pilot-2');
});

// 3. set.pilots deep-equals { ts: 2, poly: 3 }.
test('3: set.pilots is { ts: 2, poly: 3 }', async () => {
  assert.deepEqual(amendment2.set.pilots, { ts: 2, poly: 3 }, 'pilots deep-equals { ts: 2, poly: 3 }');
});

// 4. set.scaffolds.ts equals amendment 1's set.scaffolds.ts; set.scaffolds.poly differs and equals scaffoldDigest.
test('4: set.scaffolds.ts unchanged from amendment 1', async () => {
  const amend1 = readCommittedAmendment(1);
  assert.equal(amendment2.set.scaffolds.ts, amend1.set.scaffolds.ts, 'ts scaffold unchanged');
});

test('4: set.scaffolds.ts equals scaffoldDigest(ts)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'baseline-amend2-scaffold-ts-'));
  try {
    const expected = scaffoldDigest('ts', tmp, ROOT);
    assert.equal(amendment2.set.scaffolds.ts, expected, 'ts scaffold equals scaffoldDigest result');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('4: set.scaffolds.poly is a sha256 hash', async () => {
  assert.match(amendment2.set.scaffolds.poly, /^sha256:[0-9a-f]{64}$/, 'poly scaffold is sha256 hash');
});

test('4: set.scaffolds.poly differs from amendment 1', async () => {
  const amend1 = readCommittedAmendment(1);
  assert.notEqual(amendment2.set.scaffolds.poly, amend1.set.scaffolds.poly, 'poly scaffold differs from amendment 1');
});

test('4: set.scaffolds.poly equals scaffoldDigest(poly)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'baseline-amend2-scaffold-poly-'));
  try {
    const expected = scaffoldDigest('poly', tmp, ROOT);
    assert.equal(amendment2.set.scaffolds.poly, expected, 'poly scaffold equals scaffoldDigest result');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// 5. keeps: contains the nine immutable keys with values from effective record before amendment 2.
test('5: keeps has all nine immutable keys with correct values', async () => {
  const effective = getEffectiveRecordBefore();
  const immutable = ['prompt', 'armTexts', 'model', 'claudeCode', 'billing', 'network', 'maxTurns', 'capsUsd', 'polyReference'];
  for (const key of immutable) {
    assert.ok(key in amendment2.keeps, `keeps has ${key}`);
    assert.deepEqual(amendment2.keeps[key], effective[key], `${key} value matches effective record`);
  }
});

test('5: keeps.totalCapUsd equals 175', async () => {
  assert.equal(amendment2.keeps.totalCapUsd, 175, 'totalCapUsd is 175');
});

test('5: keeps tool-related keys match effective record', async () => {
  const effective = getEffectiveRecordBefore();
  const toolKeys = ['allowedTools', 'disallowedTools', 'tools', 'settings', 'hook', 'readOnlyBash', 'readOnlyExact'];
  for (const key of toolKeys) {
    assert.ok(key in amendment2.keeps, `keeps has ${key}`);
    assert.deepEqual(amendment2.keeps[key], effective[key], `${key} value matches effective record`);
  }
});

// 6. set does not name any immutable key, allowedTools, disallowedTools, tools, settings, hook, readOnlyBash, readOnlyExact.
test('6: set does not have immutable keys', async () => {
  const immutable = ['prompt', 'armTexts', 'model', 'claudeCode', 'billing', 'network', 'maxTurns', 'capsUsd', 'polyReference'];
  const setKeys = Object.keys(amendment2.set);
  for (const key of immutable) {
    assert.ok(!setKeys.includes(key), `set does not have ${key}`);
  }
});

test('6: set does not have tool-related keys', async () => {
  const toolKeys = ['allowedTools', 'disallowedTools', 'tools', 'settings', 'hook', 'readOnlyBash', 'readOnlyExact'];
  const setKeys = Object.keys(amendment2.set);
  for (const key of toolKeys) {
    assert.ok(!setKeys.includes(key), `set does not have ${key}`);
  }
});

// 7. The amendment is accepted by the machinery: lay it over the record with effectiveRecord.
test('7: amendment 2 is accepted by effectiveRecord', async () => {
  const amend1 = readCommittedAmendment(1);
  const r = gitRepo({ amendments: [amend1, amendment2] });
  try {
    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.deepEqual(eff.problems, [], 'no problems from effectiveRecord');
    assert.equal(eff.amendments.length, 2, 'two amendments recognized');
    assert.equal(eff.amendments[1].n, 2, 'second amendment is n=2');
  } finally { r.clean(); }
});

test('7: amendment 2 sets the record to pilots { ts: 2, poly: 3 } and totalCapUsd 175', async () => {
  const amend1 = readCommittedAmendment(1);
  const r = gitRepo({ amendments: [amend1, amendment2] });
  try {
    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.deepEqual(eff.record.pilots, { ts: 2, poly: 3 }, 'pilots are { ts: 2, poly: 3 }');
    assert.equal(eff.record.totalCapUsd, 175, 'totalCapUsd is 175');
  } finally { r.clean(); }
});

// 8. buildAmendment(3) throws.
test('8: buildAmendment(3) throws', async () => {
  await assert.rejects(async () => buildAmendment(3, { root: ROOT, git: (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }), Error);
});

// 9. No em dash (U+2014, —) or en dash (U+2013, –) in the amendment JSON, and no words hon+est, hon+esty, honestly.
test('9: amendment 2 JSON text contains no em dash or en dash', async () => {
  const text = JSON.stringify(amendment2, null, 2);
  assert.ok(!/[—–]/.test(text), 'contains no em dash or en dash');
});

test('9: amendment 2 JSON text contains no forbidden words', async () => {
  const text = JSON.stringify(amendment2).toLowerCase();
  const forbidden = ['honest' + 'y', 'hon' + 'est'];
  for (const word of forbidden) {
    assert.ok(!text.includes(word), `no word ${word}`);
  }
});

// Ensure buildAmendment(2) does not write the amendment file to disk.
test('file: buildAmendment(2) does not write PREREGISTRATION.amendment-2.json', async () => {
  const baselineDir = join(ROOT, 'demo', 'baseline');
  const filePath = join(baselineDir, 'PREREGISTRATION.amendment-2.json');

  // Read folder state before call: amendment file names and git status.
  const filesBefore = execFileSync('ls', ['-1'], { cwd: baselineDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter(n => n.match(/PREREGISTRATION\.amendment-\d+\.json$/)).sort();
  const amendmentFileStatsBefore = {};
  for (const f of filesBefore) {
    const stat = execFileSync('stat', ['-c', '%Y %s', join(baselineDir, f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(' ');
    amendmentFileStatsBefore[f] = { mtime: stat[0], size: stat[1] };
  }
  const gitStatusBefore = git(['status', '--porcelain', 'demo/baseline']);

  // Call buildAmendment(2) inside the test.
  await buildAmendment(2, { root: ROOT, git });

  // Read folder state after call.
  const filesAfter = execFileSync('ls', ['-1'], { cwd: baselineDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter(n => n.match(/PREREGISTRATION\.amendment-\d+\.json$/)).sort();
  const amendmentFileStatsAfter = {};
  for (const f of filesAfter) {
    const stat = execFileSync('stat', ['-c', '%Y %s', join(baselineDir, f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(' ');
    amendmentFileStatsAfter[f] = { mtime: stat[0], size: stat[1] };
  }
  const gitStatusAfter = git(['status', '--porcelain', 'demo/baseline']);

  // Assert file list and state unchanged.
  assert.deepEqual(filesAfter, filesBefore, 'amendment file list unchanged');
  assert.deepEqual(amendmentFileStatsAfter, amendmentFileStatsBefore, 'amendment file mtimes and sizes unchanged');
  assert.equal(gitStatusAfter, gitStatusBefore, 'git status unchanged');

  // Assert amendment-2.json is absent.
  assert.ok(!existsSync(filePath), 'PREREGISTRATION.amendment-2.json does not exist');
});
