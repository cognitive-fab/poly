// DB13 item 3 and DB15 item 6: an amendment's keeps are read against the record as the amendment leaves it, so a total of the caps that moves with the
// pilots can be kept, and amendment 1 keeps the approved total of 150 USD with 25 USD for each run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveRecord, buildRecord, preflight, RECORD } from '../demo/baseline/procedure.mjs';

const ROOT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const IMMUTABLE = ['prompt', 'armTexts', 'model', 'claudeCode', 'billing', 'network', 'maxTurns', 'capsUsd', 'polyReference'];
const DEPS = { claudeVersion: () => '2.1.287', scaffold: () => 'sha256:ts', reference: () => ({ files: ['README.md'], listSha256: 'sha256:list', treeSha256: 'sha256:tree' }), configProblems: () => [], smoke: () => ({ ok: true, steps: [] }) };
const EXCLUDED = [
  { arm: 'ts', run: 'pilot-1', commit: '90eee290', tree: 'f3be07cd', findings: ['H3', 'H4'], note: 'excluded' },
  { arm: 'poly', run: 'pilot-1', commit: '20f7054c', tree: 'd02b8170', findings: ['H1', 'H2', 'H3'], note: 'excluded' },
];

/** The base record of these tests: cheap to build (scaffolds and reference are given). */
const baseRecord = () => buildRecord({ root: ROOT_DIR, version: '2.1.287', scaffolds: { ts: 'sha256:ts', poly: 'sha256:poly' }, reference: { files: ['README.md'], listSha256: 'sha256:list', treeSha256: 'sha256:tree' } });
const immutableKeeps = (base) => Object.fromEntries(IMMUTABLE.map((k) => [k, base[k]]));

/** A throwaway git repository with a committed base record and the amendments given, each committed. `baseText` replaces the record when given. */
function gitRepo({ amendments = [], baseText = null, files = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'baseline-total-'));
  const sh = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(root, 'demo', 'baseline'), { recursive: true });
  for (const name of ['PROMPT.md', 'arm-ts.md', 'arm-poly.md', 'orders.json']) copyFileSync(join(ROOT_DIR, 'demo', 'baseline', name), join(root, 'demo', 'baseline', name));
  const base = baseText ? JSON.parse(baseText) : baseRecord();
  writeFileSync(join(root, RECORD), baseText ?? `${JSON.stringify(base, null, 2)}\n`);
  sh('init', '-q');
  sh('config', 'user.name', 'test');
  sh('config', 'user.email', 'test@example.invalid');
  sh('config', 'commit.gpgsign', 'false');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'pre-registration');
  for (const [n, given] of (files ?? amendments).entries()) {
    writeFileSync(join(root, `demo/baseline/PREREGISTRATION.amendment-${n + 1}.json`), typeof given === 'string' ? given : `${JSON.stringify(given, null, 2)}\n`);
    sh('add', '-A');
    sh('commit', '-q', '-m', `amendment ${n + 1}`);
  }
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { root, base, git, clean: () => rmSync(root, { recursive: true, force: true }) };
}

const amendment = (keeps, pilots) => ({ v: 1, amendment: 1, reason: 'test', findings: [], keeps, set: { pilots }, excluded: EXCLUDED });
const preflightOf = (r) => preflight({ arm: 'ts', run: 'pilot-2', root: r.root, env: {}, runsDir: join(r.root, 'demo', 'baseline', 'runs'), localRunsDir: join(tmpdir(), 'baseline-local-'), deps: DEPS });

// Catches a keeps check that refuses the total it was meant to record: keeps.totalCapUsd 150 with two pilots and the kept run for each arm (3 runs of 25 USD, twice).
test('DB13: an amendment that keeps totalCapUsd 150 and allows two pilots an arm is accepted, and the effective total is 150 (a)', () => {
  const base = baseRecord();
  const r = gitRepo({ amendments: [amendment({ ...immutableKeeps(base), totalCapUsd: 150 }, { ts: 2, poly: 2 })] });
  try {
    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.deepEqual(eff.problems, []);
    assert.equal(eff.record.totalCapUsd, 150);
    assert.equal(base.totalCapUsd, 100, 'the base record paid for one pilot an arm');
    assert.deepEqual(preflightOf(r), []);
  } finally { r.clean(); }
});

// Catches a total that is kept but not checked: three pilots an arm cost 200, and the amendment says 150.
test('DB13: an amendment that keeps totalCapUsd 150 and allows three pilots an arm is refused, naming totalCapUsd and 150 (b)', () => {
  const base = baseRecord();
  const r = gitRepo({ amendments: [amendment({ ...immutableKeeps(base), totalCapUsd: 150 }, { ts: 3, poly: 3 })] });
  try {
    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.ok(eff.problems.some((p) => /totalCapUsd/.test(p) && /150/.test(p) && /200/.test(p)), eff.problems.join(' | '));
    assert.ok(preflightOf(r).some((p) => /totalCapUsd/.test(p)), 'preflight refuses it too');
  } finally { r.clean(); }
});

// Catches a keeps that is read against the record before the amendment: the total before is 100, so keeps 100 would pass there and must not here.
test('DB13: an amendment that keeps totalCapUsd 100 and allows two pilots an arm is refused, naming totalCapUsd and 100 (c)', () => {
  const base = baseRecord();
  const r = gitRepo({ amendments: [amendment({ ...immutableKeeps(base), totalCapUsd: 100 }, { ts: 2, poly: 2 })] });
  try {
    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.ok(eff.problems.some((p) => /totalCapUsd/.test(p) && /100/.test(p) && /150/.test(p)), eff.problems.join(' | '));
  } finally { r.clean(); }
});

// Catches a total that does not follow the pilots when keeps does not name it.
test('DB13: an amendment that keeps no total and allows two pilots an arm is accepted, and the effective total is recomputed to 150 (d)', () => {
  const base = baseRecord();
  const r = gitRepo({ amendments: [amendment(immutableKeeps(base), { ts: 2, poly: 2 })] });
  try {
    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.deepEqual(eff.problems, []);
    assert.equal(eff.record.totalCapUsd, 150);
  } finally { r.clean(); }
});

// Catches a keeps on a key the amendment's own set changes that is read against the record before: keeps.pilots is what the amendment leaves.
test('DB13: keeps.pilots equal to the pilots the amendment sets is accepted (e)', () => {
  const base = baseRecord();
  const r = gitRepo({ amendments: [amendment({ ...immutableKeeps(base), pilots: { ts: 2, poly: 2 } }, { ts: 2, poly: 2 })] });
  try {
    assert.deepEqual(effectiveRecord({ root: r.root, git: r.git }).problems, []);
  } finally { r.clean(); }
});

test('DB13: keeps.pilots equal to the pilots BEFORE the amendment, which it changes, is refused, naming pilots (e)', () => {
  const base = baseRecord();
  const r = gitRepo({ amendments: [amendment({ ...immutableKeeps(base), pilots: { ts: 1, poly: 1 } }, { ts: 2, poly: 2 })] });
  try {
    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.ok(eff.problems.some((p) => /keeps pilots/.test(p)), eff.problems.join(' | '));
  } finally { r.clean(); }
});

// Control: the nine immutable keys are still compared, and a differing one is refused by name.
test('DB13: keeps.model differing from the record is still refused, naming model (f)', () => {
  const base = baseRecord();
  const r = gitRepo({ amendments: [amendment({ ...immutableKeeps(base), model: 'other-model' }, { ts: 2, poly: 2 })] });
  try {
    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.ok(eff.problems.some((p) => /keeps model/.test(p)), eff.problems.join(' | '));
  } finally { r.clean(); }
});

// The prepared amendment 1, read from the working tree (a missing file fails the test).
const PREPARED = join(ROOT_DIR, 'demo', 'baseline', 'PREREGISTRATION.amendment-1.json');

test('DB15: the prepared amendment 1 keeps the nine immutable keys, the total of 150 USD and each run\'s cap of 25 USD, and sets the read-only lists and the pilots (g)', () => {
  const amendmentOne = JSON.parse(readFileSync(PREPARED, 'utf8'));
  const baseOnDisk = JSON.parse(readFileSync(join(ROOT_DIR, 'demo', 'baseline', 'PREREGISTRATION.json'), 'utf8'));
  for (const key of IMMUTABLE) assert.deepEqual(amendmentOne.keeps[key], baseOnDisk[key], `keeps.${key}`);
  assert.equal(amendmentOne.keeps.totalCapUsd, 150);
  assert.deepEqual(amendmentOne.keeps.capsUsd, { ts: 25, poly: 25 });
  assert.deepEqual(amendmentOne.set.readOnlyBash, ['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'cd']);
  assert.deepEqual(amendmentOne.set.readOnlyExact, ['node --version', 'npm --version', 'npx tsc --version']);
  assert.deepEqual(amendmentOne.set.pilots, { ts: 2, poly: 2 });
  assert.ok(!('totalCapUsd' in amendmentOne.set), 'the total is derived from the pilots, not set');
  assert.ok(!('capsUsd' in amendmentOne.set), 'the caps are kept, not set');
  assert.ok(amendmentOne.limits.includes('The guard sees tool inputs, not what an agent\'s own program does at run time.'));
});

// Catches a prepared amendment that the code would refuse: the real base record with the prepared file committed on it has no problem.
test('DB13: the prepared amendment 1 on the real base record leaves no problem (g)', () => {
  const r = gitRepo({ baseText: readFileSync(join(ROOT_DIR, 'demo', 'baseline', 'PREREGISTRATION.json'), 'utf8'), files: [readFileSync(PREPARED, 'utf8')] });
  try {
    const eff = effectiveRecord({ root: r.root, git: r.git });
    assert.deepEqual(eff.problems, []);
    assert.equal(eff.record.totalCapUsd, 150);
    assert.deepEqual(eff.record.pilots, { ts: 2, poly: 2 });
    assert.deepEqual(eff.amendments.map((x) => x.n), [1]);
  } finally { r.clean(); }
});
