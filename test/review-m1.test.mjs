// The M1 code review over ca2e6b2..122b520. Each finding has a test here that failed before its fix;
// the programs are in test/fixtures/review-m1, named by the review area and the reviewer's repro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse, format } from '@poly/lang';
import { checkModule } from '@poly/core';
import { lowerMachine } from '@poly/lower';
import { checkFile, checkProject, projectKindConflicts, render } from '@poly/check';
import { ROOT, BUILD } from './helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'review-m1');
const OUT = join(BUILD, 'review-m1');
const src = (name) => readFileSync(join(FIX, `${name}.poly`), 'utf8');
const codes = (text) => {
  const p = parse(text);
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  return checkModule(p.module).diagnostics.map((d) => d.code);
};
const lowerCodes = (text, machine) => {
  const p = parse(text);
  const check = checkModule(p.module);
  if (check.diagnostics.length) return check.diagnostics.map((d) => d.code);
  return lowerMachine(p.module, check, machine).diagnostics.map((d) => d.code);
};

// ── the checker ───────────────────────────────────────────────────────────

test('C1: an index outside a family is PL1201, for signal, cancel and a compose invariant (S49)', () => {
  assert.deepEqual(codes(src('checker-sig3')), ['PL1201']);
  assert.deepEqual(codes(src('checker-sig3').replace('signal t[0]', 'signal t[2]')), []);
  assert.deepEqual(codes(src('checker-fam2')), ['PL1201', 'PL1201', 'PL1201']);
  assert.deepEqual(codes(src('checker-fam2').replace('cancel late[5]', 'cancel late[2]').replaceAll('t[5]', 't[1]')), []);
});

test('C2: a map keyed by a record is PL1201 (PT3.1), not a crash', () => {
  assert.deepEqual(codes(src('checker-rec2')), ['PL1201']);
});

test('C3: a record parameter is held to the rules of what it contains (S65)', () => {
  assert.deepEqual(codes(src('checker-effrec')), ['PL0901']);
  assert.deepEqual(lowerCodes(src('checker-recmap2'), 'M'), ['PL0901']);
});

test('C4: a constant record is checked field by field against its types (PS4.2, PS13.1)', () => {
  assert.deepEqual(codes(src('checker-rec1')), ['PL1201']);
  assert.deepEqual(codes(src('checker-cfg1')), ['PL1201']);
});

test('C5: childState must have the child\'s field types, ranges included (S44)', () => {
  assert.deepEqual(codes(src('checker-cs1')), ['PL1201']);
  assert.deepEqual(codes(src('checker-cs1').replace('n: 0..1 }', 'n: 0..3 }')), []);
});

test('C6: a loop to a field whose type starts at or above lo always runs its first copies (S49)', () => {
  assert.deepEqual(codes(src('checker-loop1')), []);
  // A bound that may be below lo still has a path with no copy.
  assert.deepEqual(codes(src('checker-loop1').replace('n    : 1..2 = 1', 'n    : 0..2 = 0').replace('for i in 0..n', 'for i in 1..n')), ['PL2201']);
});

test('C7: the formatter keeps the parentheses a quantifier needs', () => {
  const m = parse(src('checker-fmt1')).module;
  const out = format(m);
  const strip = (x) => JSON.stringify(x, (k, v) => (k === 'id' || k === 'span' ? undefined : v));
  assert.equal(strip(parse(out).module), strip(m));
  assert.match(out, /\(forall i in t: t\[i\] spawned implies parent\.phase != Idle\) && parent\.landed <= 2/);
});

test('C8: a record literal compares on either side, and one recursion is one diagnostic', () => {
  assert.deepEqual(codes(src('checker-cmp1')), []);
  assert.deepEqual(codes(src('checker-rec3')), ['PL1201']);
  assert.deepEqual(codes(src('checker-mut')), ['PL1201']);
});


// ── the pipeline ──────────────────────────────────────────────────────────

test('P2: a check reads only this check\'s artefacts, not a previous build left in the same root', async () => {
  const root = join(OUT, 'stale');
  assert.equal((await checkFile(join(ROOT, 'conformance', 'm1', 'effects.poly'), { root })).verdict, 'CLEAN');
  for (const name of ['pipeline-stale-no-path', 'pipeline-stale-no-effects']) {
    const again = await checkFile(join(FIX, `${name}.poly`), { root });
    const fresh = await checkFile(join(FIX, `${name}.poly`), { root: join(OUT, `fresh-${name}`) });
    assert.equal(again.verdict, fresh.verdict, render(again));
    assert.ok(!again.machines.some((m) => m.diagnostics.some((d) => d.code === 'PL2501')), render(again));
  }
});

test('P3: a project refuses two modules with one name, which would share one build directory', async () => {
  const dir = join(OUT, 'dup-project');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'poly.json'), '{ "poly": "1", "name": "dup", "modules": ["src/*.poly"] }');
  const hello = readFileSync(join(ROOT, 'examples', 'hello', 'hello-empty.poly'), 'utf8');
  writeFileSync(join(dir, 'src', 'a.poly'), hello);
  writeFileSync(join(dir, 'src', 'b.poly'), hello);
  const p = await checkProject(dir, { root: join(OUT, 'dup-root') });
  assert.deepEqual(p.files[1].diagnostics.map((d) => d.code), ['PL1002']);
  assert.equal(p.verdict, 'REFUSED');
});

test('P4: a project never folds a file\'s ERROR away', () => {
  const report = (verdict, kinds) => ({ file: 'x', module: 'm', verdict, exit: verdict === 'ERROR' ? 4 : 0, diagnostics: [], machines: [], configurations: [], engines: {}, effectKinds: kinds });
  const a = report('CLEAN', [{ kind: 'k', signature: 'one', effect: 'M.e' }]);
  const b = report('ERROR', [{ kind: 'k', signature: 'two', effect: 'N.e' }]);
  projectKindConflicts([a, b]);
  assert.deepEqual([b.verdict, b.exit], ['ERROR', 4]);
  assert.deepEqual(b.diagnostics.map((d) => d.code), ['PL1002']);
});

test('P5, P7: a child that does not lower refuses the file, and the parent lists composition as not run', async () => {
  const r = await checkFile(join(FIX, 'pipeline-child-maparg.poly'), { root: join(OUT, 'child') });
  assert.equal(r.verdict, 'REFUSED', render(r));
  assert.equal(r.exit, 2);
  const order = r.machines.find((m) => m.machine === 'Order');
  assert.deepEqual(order.stages.filter((s) => s.stage === 'composition').map((s) => s.status), ['not-run']);
  assert.equal(r.machines.find((m) => m.machine === 'Shipment').verdict, 'REFUSED');
  // P7: an early exit lists every stage the machine would have run, effects and composition included.
  const dir = join(OUT, 'p7');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'refused.poly');
  writeFileSync(file, readFileSync(join(FIX, 'pipeline-child-maparg.poly'), 'utf8').replace('module shop', 'module shop\nmachine Broken { state { x: bool = 1 } }'));
  const refused = await checkFile(file, { root: dir });
  const parent = refused.machines.find((m) => m.machine === 'Order');
  assert.deepEqual(parent.stages.filter((s) => s.status === 'not-run').map((s) => s.stage), ['lower', 'validate', 'translation-validation', 'model-check', 'deadlock', 'effects', 'composition']);
});

test('P6: the JSON form gives every diagnostic its schema, configurations included', () => {
  const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'check', join(ROOT, 'examples', 'checkout', 'checkout-optimistic.poly'), '--json', '--root', join(OUT, 'json')], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.configurations.flatMap((c) => c.diagnostics.map((d) => d.schema)), ['poly.diagnostic/1']);
});
