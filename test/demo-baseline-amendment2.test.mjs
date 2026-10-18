// Tests for DB13 item 6 and DB16, DB17: buildAmendment(2) builds amendment 2 without writing it,
// which answers findings H5 and H6.
// Spec sections: Amendment 2 (2026-10-17): DB13 item 6, DB16 items 1 and 2, DB17.
// Rule 7a: failing tests from the specification, written before the implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

// Helper: build a throwaway git repository with base record, amendment 1, and poly-pilot-2 files.
function gitRepoWithAmendments({ amendments = [] } = {}) {
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

  // Commit amendment 1 if requested.
  if (amendments.length > 0) {
    const amend1 = amendments[0];
    writeFileSync(join(root, `demo/baseline/PREREGISTRATION.amendment-${1}.json`), JSON.stringify(amend1, null, 2) + '\n');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'amendment 1');
  }

  // Create and commit poly-pilot-2 files so that excluded entries can cite them.
  mkdirSync(join(root, 'demo', 'baseline', 'runs', 'poly-pilot-2'), { recursive: true });
  writeFileSync(join(root, 'demo', 'baseline', 'runs', 'poly-pilot-2', 'RECORD.json'), '{}');
  mkdirSync(join(root, 'demo', 'baseline', 'runs', 'poly-pilot-2', 'tree'), { recursive: true });
  writeFileSync(join(root, 'demo', 'baseline', 'runs', 'poly-pilot-2', 'tree', 'x.txt'), 'placeholder');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'add poly-pilot-2');

  const gitHelper = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { root, base, git: gitHelper, clean: () => rmSync(root, { recursive: true, force: true }) };
}

// Lazy-created, cached shared repo and helpers (no module-level buildAmendment call).
let _r_shared = null;
let _amendment2_throwaway_promise = null;
let _eff_before_amend2_cache = null;
let _poly2_commit_tree_cache = null;
let _amend1_cache = null;

function getAmend1() {
  if (!_amend1_cache) {
    _amend1_cache = readCommittedAmendment(1);
  }
  return _amend1_cache;
}

function getSharedRepo() {
  if (!_r_shared) {
    const amend1 = getAmend1();
    _r_shared = gitRepoWithAmendments({ amendments: [amend1] });
  }
  return _r_shared;
}

async function getAmendment2Throwaway() {
  if (!_amendment2_throwaway_promise) {
    _amendment2_throwaway_promise = (async () => {
      const r = getSharedRepo();
      return await buildAmendment(2, { root: r.root, git: r.git });
    })();
  }
  return _amendment2_throwaway_promise;
}

async function getEffBeforeAmend2() {
  if (!_eff_before_amend2_cache) {
    const r = getSharedRepo();
    const eff = effectiveRecord({ root: r.root, git: r.git });
    if (eff.problems.length) throw new Error(`problems in shared repo: ${eff.problems.join(', ')}`);
    _eff_before_amend2_cache = eff.record;
  }
  return _eff_before_amend2_cache;
}

async function getPoly2CommitTree() {
  if (!_poly2_commit_tree_cache) {
    const r = getSharedRepo();
    const commits = r.git(['log', '--diff-filter=A', '--format=%H', '--', 'demo/baseline/runs/poly-pilot-2/RECORD.json']).split('\n').filter(Boolean);
    const commit = commits[commits.length - 1];
    const tree = r.git(['rev-parse', `${commit}:demo/baseline/runs/poly-pilot-2/tree`]);
    _poly2_commit_tree_cache = { commit, tree };
  }
  return _poly2_commit_tree_cache;
}

// T1: buildAmendment(2) can be called in a throwaway repo with amendment 1 committed.
test('T1: buildAmendment(2) can be called in throwaway repo with amendment 1 committed', async () => {
  const amendment2 = await getAmendment2Throwaway();
  assert.ok(amendment2, 'amendment2 returned');
  assert.equal(amendment2.v, 1, 'v is 1');
  assert.equal(amendment2.amendment, 2, 'amendment is 2');
});

// 1. Shape: v 1, amendment 2, a reason string, findings with keys H5 and H6 (non-empty strings).
test('1: amendment 2 has v 1 and amendment 2', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  assert.equal(amendment2_throwaway.v, 1, 'v is 1');
  assert.equal(amendment2_throwaway.amendment, 2, 'amendment is 2');
});

test('1: amendment 2 has reason string', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  assert.equal(typeof amendment2_throwaway.reason, 'string', 'reason is string');
  assert.ok(amendment2_throwaway.reason.length > 0, 'reason is non-empty');
});

test('1: amendment 2 has findings with H5 and H6', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  assert.ok(typeof amendment2_throwaway.findings === 'object', 'findings is object');
  assert.ok('H5' in amendment2_throwaway.findings, 'findings has H5 key');
  assert.ok('H6' in amendment2_throwaway.findings, 'findings has H6 key');
  assert.equal(typeof amendment2_throwaway.findings.H5, 'string', 'H5 is string');
  assert.ok(amendment2_throwaway.findings.H5.length > 0, 'H5 is non-empty');
  assert.equal(typeof amendment2_throwaway.findings.H6, 'string', 'H6 is string');
  assert.ok(amendment2_throwaway.findings.H6.length > 0, 'H6 is non-empty');
});

test('1: amendment 2 has keeps, set, excluded, and limits', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  assert.ok('keeps' in amendment2_throwaway, 'has keeps');
  assert.ok('set' in amendment2_throwaway, 'has set');
  assert.ok('excluded' in amendment2_throwaway, 'has excluded');
  assert.ok('limits' in amendment2_throwaway, 'has limits');
});

// 2. excluded has exactly one entry: arm poly, run pilot-2, correct commit and tree, findings containing H5.
test('2: amendment 2 excluded has exactly one entry', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  assert.equal(amendment2_throwaway.excluded.length, 1, 'excluded has exactly one entry');
});

test('2: excluded entry is poly-pilot-2', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const entry = amendment2_throwaway.excluded[0];
  assert.equal(entry.arm, 'poly', 'excluded arm is poly');
  assert.equal(entry.run, 'pilot-2', 'excluded run is pilot-2');
});

test('2: excluded entry has correct commit', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const poly2_commit_tree = await getPoly2CommitTree();
  const entry = amendment2_throwaway.excluded[0];
  assert.equal(entry.commit, poly2_commit_tree.commit, 'commit matches derived commit');
  assert.equal(entry.commit.length, 40, 'commit is full hash (40 hex chars)');
});

test('2: excluded entry has correct tree', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const poly2_commit_tree = await getPoly2CommitTree();
  const entry = amendment2_throwaway.excluded[0];
  assert.equal(entry.tree, poly2_commit_tree.tree, 'tree matches derived tree');
});

test('2: excluded entry findings contains H5', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const entry = amendment2_throwaway.excluded[0];
  assert.ok(Array.isArray(entry.findings), 'findings is array');
  assert.ok(entry.findings.includes('H5'), 'findings contains H5');
});

test('2: excluded entry has non-empty note', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const entry = amendment2_throwaway.excluded[0];
  assert.equal(typeof entry.note, 'string', 'note is string');
  assert.ok(entry.note.length > 0, 'note is non-empty');
});

test('2: no excluded entry for ts-pilot-2', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const tsPilot2 = amendment2_throwaway.excluded.find(e => e.arm === 'ts' && e.run === 'pilot-2');
  assert.ok(!tsPilot2, 'no excluded entry for ts-pilot-2');
});

// 3. set.pilots deep-equals { ts: 2, poly: 3 }.
test('3: set.pilots is { ts: 2, poly: 3 }', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  assert.deepEqual(amendment2_throwaway.set.pilots, { ts: 2, poly: 3 }, 'pilots deep-equals { ts: 2, poly: 3 }');
});

// 4. set.scaffolds.ts equals amendment 1's set.scaffolds.ts; set.scaffolds.poly differs and equals scaffoldDigest.
test('4: set.scaffolds.ts unchanged from amendment 1', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const amend1 = getAmend1();
  assert.equal(amendment2_throwaway.set.scaffolds.ts, amend1.set.scaffolds.ts, 'ts scaffold unchanged');
});

test('4: set.scaffolds.ts equals scaffoldDigest(ts)', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const tmp = mkdtempSync(join(tmpdir(), 'baseline-amend2-scaffold-ts-'));
  try {
    const expected = scaffoldDigest('ts', tmp, ROOT);
    assert.equal(amendment2_throwaway.set.scaffolds.ts, expected, 'ts scaffold equals scaffoldDigest result');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('4: set.scaffolds.poly is a sha256 hash', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  assert.match(amendment2_throwaway.set.scaffolds.poly, /^sha256:[0-9a-f]{64}$/, 'poly scaffold is sha256 hash');
});

test('4: set.scaffolds.poly differs from amendment 1', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const amend1 = getAmend1();
  assert.notEqual(amendment2_throwaway.set.scaffolds.poly, amend1.set.scaffolds.poly, 'poly scaffold differs from amendment 1');
});

test('4: set.scaffolds.poly equals scaffoldDigest(poly)', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const tmp = mkdtempSync(join(tmpdir(), 'baseline-amend2-scaffold-poly-'));
  try {
    const expected = scaffoldDigest('poly', tmp, ROOT);
    assert.equal(amendment2_throwaway.set.scaffolds.poly, expected, 'poly scaffold equals scaffoldDigest result');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// 5. keeps: contains the nine immutable keys with values from effective record before amendment 2.
test('5: keeps has all nine immutable keys with correct values', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const eff_before_amend2 = await getEffBeforeAmend2();
  const immutable = ['prompt', 'armTexts', 'model', 'claudeCode', 'billing', 'network', 'maxTurns', 'capsUsd', 'polyReference'];
  for (const key of immutable) {
    assert.ok(key in amendment2_throwaway.keeps, `keeps has ${key}`);
    assert.deepEqual(amendment2_throwaway.keeps[key], eff_before_amend2[key], `${key} value matches effective record`);
  }
});

test('5: keeps.totalCapUsd equals 175', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  assert.equal(amendment2_throwaway.keeps.totalCapUsd, 175, 'totalCapUsd is 175 (total after amendment; before: 150)');
});

test('5: keeps tool-related keys match effective record', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const eff_before_amend2 = await getEffBeforeAmend2();
  const toolKeys = ['allowedTools', 'disallowedTools', 'tools', 'settings', 'hook', 'readOnlyBash', 'readOnlyExact'];
  for (const key of toolKeys) {
    assert.ok(key in amendment2_throwaway.keeps, `keeps has ${key}`);
    assert.deepEqual(amendment2_throwaway.keeps[key], eff_before_amend2[key], `${key} value matches effective record`);
  }
});

// 6. set does not name any immutable key, allowedTools, disallowedTools, tools, settings, hook, readOnlyBash, readOnlyExact.
test('6: set does not have immutable keys', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const immutable = ['prompt', 'armTexts', 'model', 'claudeCode', 'billing', 'network', 'maxTurns', 'capsUsd', 'polyReference'];
  const setKeys = Object.keys(amendment2_throwaway.set);
  for (const key of immutable) {
    assert.ok(!setKeys.includes(key), `set does not have ${key}`);
  }
});

test('6: set does not have tool-related keys', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const toolKeys = ['allowedTools', 'disallowedTools', 'tools', 'settings', 'hook', 'readOnlyBash', 'readOnlyExact'];
  const setKeys = Object.keys(amendment2_throwaway.set);
  for (const key of toolKeys) {
    assert.ok(!setKeys.includes(key), `set does not have ${key}`);
  }
});

// 7. The amendment is accepted by the machinery: lay it over the record with effectiveRecord.
test('7: amendment 2 is accepted by effectiveRecord', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const amend1 = getAmend1();
  // Create a throwaway repo with amendment 1 committed, write and commit amendment 2, then test effectiveRecord.
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(amendment2_throwaway, null, 2) + '\n');
    execFileSync('git', ['-C', r.root, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', r.root, 'commit', '-q', '-m', 'amendment 2'], { stdio: ['ignore', 'pipe', 'pipe'] });

    // Test effectiveRecord accepts amendment 2.
    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.deepEqual(eff.problems, [], 'no problems from effectiveRecord');
    assert.equal(eff.amendments.length, 2, 'two amendments recognized (1 and 2)');
    assert.equal(eff.amendments[1].n, 2, 'second amendment n is 2');
    assert.deepEqual(eff.record.pilots, { ts: 2, poly: 3 }, 'pilots are { ts: 2, poly: 3 } after amendment 2');
    assert.equal(eff.record.totalCapUsd, 175, 'totalCapUsd is 175 after amendment 2');
    assert.deepEqual(eff.record.scaffolds, amendment2_throwaway.set.scaffolds, 'scaffolds match amendment 2 set.scaffolds');

    // Test that changing keeps.allowedTools causes a problem.
    // Control: unmodified amendment 2 should have no problems (already tested above, but verify again).
    assert.deepEqual(eff.problems, [], 'control: unmodified amendment 2 has no problems');

    // Create a new repo with amendment 1 and modified amendment 2 (one tool added to ts list).
    const r_bad = gitRepoWithAmendments({ amendments: [amend1] });
    try {
      const badAmendment2 = JSON.parse(JSON.stringify(amendment2_throwaway));
      // Keep the shape (object keyed by arm) and add one tool to the ts list.
      badAmendment2.keeps.allowedTools = { ...badAmendment2.keeps.allowedTools, ts: [...(badAmendment2.keeps.allowedTools.ts || []), 'Bash(rm *)'] };
      writeFileSync(join(r_bad.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(badAmendment2, null, 2) + '\n');
      execFileSync('git', ['-C', r_bad.root, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
      execFileSync('git', ['-C', r_bad.root, 'commit', '-q', '-m', 'amendment 2 with modified keeps'], { stdio: ['ignore', 'pipe', 'pipe'] });

      const eff_bad = effectiveRecord({ root: r_bad.root, git: r_bad.git });
      assert.equal(eff_bad.problems.length, 1, 'exactly one problem reported when keeps.allowedTools changed');
      assert.ok(eff_bad.problems[0].startsWith('amendment 2 keeps allowedTools as '), 'problem message starts with correct prefix');
      assert.ok(eff_bad.problems[0].includes('Bash(rm *)'), 'problem message includes the tool name');
      assert.ok(eff_bad.problems[0].includes(', but the record has '), 'problem message includes expected/actual comparison');
    } finally { r_bad.clean(); }
  } finally { r.clean(); }
});

// 9. No em dash (U+2014, —) or en dash (U+2013, –) in the amendment JSON, and no words hon+est, hon+esty, honestly.
test('9: amendment 2 JSON text contains no em dash or en dash', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const text = JSON.stringify(amendment2_throwaway, null, 2);
  assert.ok(!/[—–]/.test(text), 'contains no em dash or en dash');
});

test('9: amendment 2 JSON text contains no forbidden words', async () => {
  const amendment2_throwaway = await getAmendment2Throwaway();
  const text = JSON.stringify(amendment2_throwaway).toLowerCase();
  const forbidden = ['honest' + 'y', 'hon' + 'est'];
  for (const word of forbidden) {
    assert.ok(!text.includes(word), `no word ${word}`);
  }
});

// T2: buildAmendment(2) gives same result in three states: (a) no file, (b) uncommitted file, (c) committed file.
test('T2a: buildAmendment(2) with no amendment-2 file', async () => {
  const amend1 = getAmend1();
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    const result = await buildAmendment(2, { root: r.root, git: r.git });
    assert.ok(result, 'buildAmendment returns result');
    assert.equal(result.amendment, 2, 'amendment is 2');
  } finally { r.clean(); }
});

test('T2b: buildAmendment(2) with uncommitted amendment-2 file gives same result', async () => {
  const amend1 = getAmend1();
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    const result1 = await buildAmendment(2, { root: r.root, git: r.git });
    // Write DIFFERENT amendment 2 to disk but do not commit it (file beyond n is ignored).
    const wrongAmend2 = { v: 1, amendment: 2, reason: 'not the real one', findings: {}, set: { pilots: { ts: 9, poly: 9 } }, excluded: [], keeps: {}, limits: [] };
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(wrongAmend2, null, 2) + '\n');
    // Call buildAmendment again - should return same correct result (ignoring file beyond n).
    const result2 = await buildAmendment(2, { root: r.root, git: r.git });
    assert.deepEqual(result2, result1, 'buildAmendment returns same object with uncommitted file present');
  } finally { r.clean(); }
});

test('T2c: buildAmendment(2) with committed amendment-2 file gives same result', async () => {
  const amend1 = getAmend1();
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    const result1 = await buildAmendment(2, { root: r.root, git: r.git });
    // Write DIFFERENT amendment 2 and commit it (file beyond n is ignored).
    const wrongAmend2 = { v: 1, amendment: 2, reason: 'not the real one', findings: {}, set: { pilots: { ts: 9, poly: 9 } }, excluded: [], keeps: {}, limits: [] };
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(wrongAmend2, null, 2) + '\n');
    execFileSync('git', ['-C', r.root, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', r.root, 'commit', '-q', '-m', 'amendment 2'], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Call buildAmendment again - should return same correct result (ignoring file beyond n).
    const result2 = await buildAmendment(2, { root: r.root, git: r.git });
    assert.deepEqual(result2, result1, 'buildAmendment returns same object with committed file');
  } finally { r.clean(); }
});

test('T2: three states (a/b/c) give deepEqual buildAmendment(2) results', async () => {
  const amend1 = getAmend1();
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    // State (a): no amendment-2 file.
    const result_a = await buildAmendment(2, { root: r.root, git: r.git });

    // State (b): write different-content amendment-2 file but do not commit it.
    const wrongAmend2 = { v: 1, amendment: 2, reason: 'not the real one', findings: {}, set: { pilots: { ts: 9, poly: 9 } }, excluded: [], keeps: {}, limits: [] };
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(wrongAmend2, null, 2) + '\n');
    const result_b = await buildAmendment(2, { root: r.root, git: r.git });

    // State (c): commit the different-content amendment-2 file.
    execFileSync('git', ['-C', r.root, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', r.root, 'commit', '-q', '-m', 'amendment 2'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const result_c = await buildAmendment(2, { root: r.root, git: r.git });

    assert.deepEqual(result_a, result_b, 'state (a) no file equals state (b) uncommitted file with wrong content');
    assert.deepEqual(result_b, result_c, 'state (b) uncommitted equals state (c) committed with wrong content');
    assert.deepEqual(result_a, result_c, 'state (a) no file equals state (c) committed with wrong content');
  } finally { r.clean(); }
});

// T3: effectiveRecord with upTo parameter (new feature, may fail if not yet implemented).
test('T3a: effectiveRecord with upTo: 0 in throwaway repo', async () => {
  const result2 = await getAmendment2Throwaway();
  const amend1 = getAmend1();
  // Commit amendment 2 in a throwaway repo for testing.
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(result2, null, 2) + '\n');
    r.git(['add', '-A']);
    r.git(['commit', '-q', '-m', 'amendment 2']);

    // Test effectiveRecord with upTo: 0 (no amendments read).
    const eff0 = effectiveRecord({ root: r.root, git: r.git, upTo: 0 });
    assert.deepEqual(eff0.amendments, [], 'amendments is empty with upTo: 0');
    assert.deepEqual(eff0.record.pilots, { ts: 1, poly: 1 }, 'pilots are base { ts: 1, poly: 1 } with upTo: 0');
  } finally { r.clean(); }
});

test('T3b: effectiveRecord with upTo: 1 in throwaway repo', async () => {
  const result2 = await getAmendment2Throwaway();
  const amend1 = getAmend1();
  // Commit amendment 2 in a throwaway repo for testing.
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(result2, null, 2) + '\n');
    r.git(['add', '-A']);
    r.git(['commit', '-q', '-m', 'amendment 2']);

    // Test effectiveRecord with upTo: 1 (only amendment 1).
    const eff1 = effectiveRecord({ root: r.root, git: r.git, upTo: 1 });
    assert.equal(eff1.amendments.length, 1, 'amendments length is 1 with upTo: 1');
    assert.deepEqual(eff1.record.pilots, { ts: 2, poly: 2 }, 'pilots are { ts: 2, poly: 2 } with upTo: 1');
    assert.equal(eff1.record.totalCapUsd, 150, 'totalCapUsd is 150 with upTo: 1');
  } finally { r.clean(); }
});

test('T3d: effectiveRecord with upTo: 1 reports no problems, with no upTo reports amendment-2 not committed', async () => {
  const result2 = await getAmendment2Throwaway();
  const amend1 = getAmend1();
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    // Write but do NOT commit amendment 2.
    writeFileSync(join(r.root, 'demo/baseline/PREREGISTRATION.amendment-2.json'), JSON.stringify(result2, null, 2) + '\n');

    // Test effectiveRecord with upTo: 1 should have no problems.
    const eff1 = effectiveRecord({ root: r.root, git: r.git, upTo: 1 });
    assert.deepEqual(eff1.problems, [], 'no problems with upTo: 1 and uncommitted amendment-2');

    // Test effectiveRecord with no upTo should report problem.
    const eff_all = effectiveRecord({ root: r.root, git: r.git });
    assert.ok(eff_all.problems.some(p => p.includes('amendment-2') || p.includes('not committed')), 'problem reported for uncommitted amendment-2 with no upTo');
  } finally { r.clean(); }
});

test('T3c: effectiveRecord with no upTo parameter reads all amendments', async () => {
  const r_shared = getSharedRepo();
  const eff_all = effectiveRecord({ root: r_shared.root, git: r_shared.git });
  assert.equal(eff_all.amendments.length, 1, 'amendments length is 1 (only amendment 1 in shared repo)');
  assert.deepEqual(eff_all.record.pilots, { ts: 2, poly: 2 }, 'pilots are { ts: 2, poly: 2 }');
  assert.equal(eff_all.record.totalCapUsd, 150, 'totalCapUsd is 150');
});

// T4: Errors.
test('T4a: buildAmendment(3) throws', async () => {
  const amend1 = getAmend1();
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    await assert.rejects(async () => buildAmendment(3, { root: r.root, git: r.git }), Error);
  } finally { r.clean(); }
});

test('T4b: buildAmendment(2) throws without amendment 1', async () => {
  const r = gitRepoWithAmendments({ amendments: [] });
  try {
    await assert.rejects(async () => buildAmendment(2, { root: r.root, git: r.git }), Error);
  } finally { r.clean(); }
});

// Ensure buildAmendment(2) does not write the amendment file to disk (uses real repo).
test('file: buildAmendment(2) does not write PREREGISTRATION.amendment-2.json', async () => {
  const amend1 = getAmend1();
  const baselineDir = join(ROOT, 'demo', 'baseline');
  const filePath = join(baselineDir, 'PREREGISTRATION.amendment-2.json');

  // Read folder state before call: amendment file names and git status.
  const filesBefore = readdirSync(baselineDir).filter(n => n.match(/PREREGISTRATION\.amendment-\d+\.json$/)).sort();
  const amendmentFileStatsBefore = {};
  for (const f of filesBefore) {
    const s = statSync(join(baselineDir, f));
    amendmentFileStatsBefore[f] = { mtimeMs: s.mtimeMs, size: s.size };
  }
  const gitStatusBefore = git(['status', '--porcelain', 'demo/baseline']);

  // Call buildAmendment(2) in a fresh throwaway repo.
  const r = gitRepoWithAmendments({ amendments: [amend1] });
  try {
    await buildAmendment(2, { root: r.root, git: r.git });
  } finally { r.clean(); }

  // Read folder state after call.
  const filesAfter = readdirSync(baselineDir).filter(n => n.match(/PREREGISTRATION\.amendment-\d+\.json$/)).sort();
  const amendmentFileStatsAfter = {};
  for (const f of filesAfter) {
    const s = statSync(join(baselineDir, f));
    amendmentFileStatsAfter[f] = { mtimeMs: s.mtimeMs, size: s.size };
  }
  const gitStatusAfter = git(['status', '--porcelain', 'demo/baseline']);

  // Assert file list and state unchanged.
  assert.deepEqual(filesAfter, filesBefore, 'amendment file list unchanged');
  assert.deepEqual(amendmentFileStatsAfter, amendmentFileStatsBefore, 'amendment file mtimes and sizes unchanged');
  assert.equal(gitStatusAfter, gitStatusBefore, 'git status unchanged');
});

// Cleanup shared throwaway repo at the end.
test.after(() => {
  const r_shared = getSharedRepo();
  r_shared.clean();
});
