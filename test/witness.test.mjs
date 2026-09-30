// AC3 and PT12.4 (plan-m2 step 4): for every seeded defect, one per diagnostic kind with a witness, the
// diagnostic has a witness, and the exported host test fails on the unfixed program and passes on the fixed
// one. The test also refuses a stale build (S68), and the witness ids follow S69.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { canonicalize, digest, sha256Hex } from '@poly/core';
import { parse } from '@poly/lang';
import { checkFile, exportWitness, findWitness, render } from '@poly/check';
import { ROOT, BUILD } from './helpers.mjs';

const SEEDED = join(ROOT, 'conformance', 'm2', 'seeded');
const KINDS = [
  ['invariant', 'PL3001'],
  ['step-property', 'PL3002'],
  ['reject-property', 'PL3003'],
  ['path-property', 'PL4001'],
  ['deadlock', 'PL3201'],
  ['domain-escape', 'PL3102'],
  ['configuration-invariant', 'PL5401'],
  ['stuck', 'PL5402'],
  ['liveness', 'PL3301'],
];
// What the unfixed program's test must fail on: the violated predicate itself, never a crash.
const BECAUSE = {
  PL3001: /invariant at-most-two is violated/,
  PL3002: /step property never-falls is violated/,
  PL3003: /reject property close-reason is violated/,
  PL4001: /path property charge-once is violated/,
  PL3201: /is a deadlock/,
  PL3102: /domain:items is violated/,
  PL5401: /configuration invariant confirmed-within-stock is violated/,
  PL5402: /the configuration is stuck/,
  PL3301: /the fair cycle of the witness still never reaches its goal/,
};

const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
// The exported test runs as a user would run it: in its own test runner, not as a child of this one.
const runTest = (file) => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', env }); };

for (const [kind, code] of KINDS) {
  test(`AC3, ${kind}: the exported test fails on the unfixed program and passes on the fixed one`, async () => {
    const dir = join(BUILD, 'ac3', kind);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'm.poly');
    copyFileSync(join(SEEDED, kind, 'unfixed.poly'), file);
    const before = await checkFile(file, { root: dir });
    const d = all(before).find((x) => x.code === code);
    assert.ok(d?.witness?.trace.length, `${kind}: no ${code} with a witness\n${render(before)}`);
    // S69, S86: the id is the digest of { moduleDigest, subject, property, trace }, the subject being the machine or
    // configuration the finding is about.
    const subject = before.machines.find((m) => m.diagnostics.includes(d))?.machine ?? before.configurations.find((c) => c.diagnostics.includes(d))?.configuration ?? null;
    assert.equal(d.witness.id, 'sha256:' + sha256Hex(canonicalize({ moduleDigest: digest(parse(readFileSync(file, 'utf8')).module), subject, property: d.property ?? d.code, trace: d.witness.trace })));
    const found = findWitness(JSON.parse(JSON.stringify(before)), d.witness.id);
    assert.ok(found);
    const exported = exportWitness(found, { root: dir, kind: 'test' });
    const failing = runTest(exported);
    assert.notEqual(failing.status, 0, `${kind}: the exported test passes on the unfixed program\n${failing.stdout}`);
    assert.match(failing.stdout, BECAUSE[code]);
    copyFileSync(join(SEEDED, kind, 'fixed.poly'), file);
    // S68: before poly check rebuilds, the build is stale for the fixed source, and the test refuses it.
    const stale = runTest(exported);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stdout, /stale build/);
    const after = await checkFile(file, { root: dir });
    assert.deepEqual(all(after).filter((x) => x.code === code), [], render(after));
    const passing = runTest(exported);
    assert.equal(passing.status, 0, `${kind}: the exported test fails on the fixed program\n${passing.stdout}`);
  });
}

test('poly witness --trace writes the windows, and a lasso its cycle', async () => {
  const dir = join(BUILD, 'ac3', 'trace');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'm.poly');
  copyFileSync(join(SEEDED, 'liveness', 'unfixed.poly'), file);
  const r = await checkFile(file, { root: dir });
  const d = all(r).find((x) => x.code === 'PL3301');
  const out = exportWitness(findWitness(JSON.parse(JSON.stringify(r)), d.witness.id), { root: dir, kind: 'trace' });
  const t = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(t.id, d.witness.id);
  assert.equal(t.cycle, d.witness.cycle);
  assert.equal(t.windows.length, d.witness.length);
  for (const w of t.windows) assert.deepEqual(Object.keys(w).slice(0, 4), ['pre', 'action', 'data', 'post']);
});

test('the CLI: poly check writes .poly/report.json, and poly witness exports from it', () => {
  const dir = join(BUILD, 'ac3', 'cli');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'm.poly');
  copyFileSync(join(SEEDED, 'deadlock', 'unfixed.poly'), file);
  const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
  const check = spawnSync(process.execPath, [cli, 'check', file, '--root', dir], { encoding: 'utf8' });
  assert.equal(check.status, 1);
  const report = JSON.parse(readFileSync(join(dir, '.poly', 'report.json'), 'utf8'));
  const id = report.machines[0].diagnostics.find((d) => d.code === 'PL3201').witness.id;
  const out = spawnSync(process.execPath, [cli, 'witness', id.slice(7, 19), '--test', '--root', dir], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.notEqual(runTest(out.stdout.trim()).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, 'witness', 'sha256:0000000000000000', '--test', '--root', dir], { encoding: 'utf8' }).status, 64);
});
