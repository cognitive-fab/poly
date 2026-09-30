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

// ── the lowering ──────────────────────────────────────────────────────────

const lowered = (name, machine) => {
  const p = parse(src(name));
  const check = checkModule(p.module);
  assert.deepEqual(check.diagnostics.map((d) => d.code), [], name);
  const r = lowerMachine(p.module, check, machine);
  assert.ok(r.lowered, JSON.stringify(r.diagnostics.map((d) => d.message)));
  return r.lowered;
};

test('L1: a completion\'s constant data is written as the value poly-ref assumes (PT6.1, S58, S65)', () => {
  const m2 = JSON.parse(lowered('lower-man2', 'Acct').files['effects.manifest.json']).effects['net.ping'];
  assert.deepEqual([m2.onSuccess.data, m2.onFailure.data], [{ w: { $: 'Fine' }, k: 3 }, { w: { $: 'Fine' } }]);
  const m3 = JSON.parse(lowered('lower-man3', 'Acct').files['effects.manifest.json']).effects;
  assert.equal(Object.values(m3)[0].onSuccess.data.p, null);
  const m1 = JSON.parse(lowered('lower-man1', 'Acct').files['effects.manifest.json']).effects;
  assert.equal(Object.values(m1)[0].onSuccess.data.k, 3);
});

test('L2: terminalStates lists the tags of a control field that is a union with payloads', () => {
  assert.deepEqual(lowered('lower-term4', 'T').contract.terminalStates, ['Shut']);
});

test('L3: an effect kind that is a kernel intent name is refused (PT6.1)', () => {
  assert.deepEqual(codes(src('lower-kindtimer2')), ['PL1201']);
});

test('L4: a map literal with qualified keys lowers its keys by name (S22)', () => {
  assert.deepEqual(lowered('lower-maplit3', 'M').contract.initState.m, { A: false, B: false });
});

test('L5: `is` on a record field, a parent field and a child field reads the structured value (PS5.1, PS7.3)', async () => {
  for (const name of ['lower-recis', 'lower-recinv', 'lower-comp2']) {
    const r = await checkFile(join(FIX, `${name}.poly`), { root: join(OUT, name) });
    assert.ok(!JSON.stringify(r).includes('PL2501'), render(r));
  }
  const r = await checkFile(join(FIX, 'lower-comp1.poly'), { root: join(OUT, 'comp1') });
  const f = r.machines.find((m) => m.machine === 'Par').diagnostics.find((d) => d.code === 'PL5001');
  assert.match(f.engine, /polyrun/, render(r));
});

test('L6: a union payload of record type lowers', () => {
  assert.ok(lowered('lower-recpay', 'M'));
});

test('L7: a parameter whose union payload holds a map is PL0901, as a map parameter is (S65)', () => {
  assert.deepEqual(lowerCodes(src('lower-unmap'), 'M'), ['PL0901']);
});

test('L8: __proto__ as a name is refused, since it cannot be lowered to a JSON key safely', () => {
  assert.deepEqual(codes(src('lower-proto')), ['PL1201']);
});

test('L9: a map key whose range leaves the map\'s keys is PL1201, not a crash in poly-ref', () => {
  assert.deepEqual(codes(src('lower-oob')), ['PL1201']);
});

// ── poly-ref ──────────────────────────────────────────────────────────────

test('R1: the same signal twice in one step is refused, as the kernel poisons it (S66)', () => {
  assert.deepEqual(codes(src('ref-dupsig')), ['PL5105']);
});

test('R2: a declared-type escape reached through a cascade is PL3102, not a bound hit (PS4.2a)', async () => {
  const r = await checkFile(join(FIX, 'ref-jesc.poly'), { root: join(OUT, 'jesc') });
  assert.ok(r.machines.some((m) => m.diagnostics.some((d) => d.code === 'PL3102')), render(r));
  assert.equal(r.verdict, 'FINDINGS');
});

test('R3: translation validation applies the runtime\'s terminal row from contract.json to every action (PS9.1a)', async () => {
  const { translationValidate } = await import('@poly/ref');
  const { cpSync } = await import('node:fs');
  const [b] = (await import('./helpers.mjs')).build(join(FIX, 'ref-dupsig.poly').replace('ref-dupsig', 'lower-term4'), 'review-m1-tv');
  const dir = join(OUT, 'tv-bad');
  cpSync(b.dir, dir, { recursive: true });
  const c = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf8'));
  for (const wrong of [[], ['Open'], ['Open', 'Shut']]) {
    writeFileSync(join(dir, 'contract.json'), JSON.stringify({ ...c, terminalStates: wrong }));
    const tv = await translationValidate(b.module, 'T', dir);
    assert.ok(tv.mismatches.length > 0, JSON.stringify(wrong));
  }
  writeFileSync(join(dir, 'contract.json'), JSON.stringify(c));
  assert.deepEqual((await translationValidate(b.module, 'T', dir)).mismatches, []);
});

test('R4: an engine\'s automatic invariant is confirmed by its field, when one step leaves the instance twice', async () => {
  const r = await checkFile(join(FIX, 'ref-both.poly'), { root: join(OUT, 'both') });
  assert.ok(!JSON.stringify(r).includes('PL2501'), render(r));
});

test('R5: in a configuration, a type escape is reported even when the step also passes the transit bound', () => {
  const p = parse(src('ref-cfgmask'));
  const decl = p.module.decls.find((d) => d.kind === 'Configuration');
  return import('@poly/ref').then(({ checkConfiguration }) => {
    const r = checkConfiguration(p.module, decl.name);
    assert.ok(r.findings.some((d) => d.code === 'PL3102'), JSON.stringify(r.findings.map((d) => d.code)));
  });
});

// polywatch after the review: a family with a gap (t1 and t3, no t2) passed an index in its interval.
test('C1b: an index that names no member of a family with a gap is PL1201, for signal and cancel', () => {
  assert.deepEqual(codes(src('checker-gap')), ['PL1201', 'PL1201']);
  assert.deepEqual(codes(src('checker-gap').replace('signal t[2]', 'signal t[3]').replace('cancel late[2]', 'cancel late[1]')), []);
});

// polywatch (an earlier review, rated at M2's start): a map-literal key that is a parameter or a field is not
// a constant, whatever its spelling; one named like a constructor was taken for the constructor.
test('W1: a map-literal key that names a parameter or a field is PL1502, not a constructor or a wrong key', () => {
  assert.deepEqual(codes(src('pw-mapkey')), ['PL1502', 'PL1502']);
});

// polywatch, rated at M2's start. W2: an ERROR report must not show the machines it did not finish as CLEAN.
test('W2: when a stage throws, no machine of the ERROR report says CLEAN', async () => {
  const blocker = join(OUT, 'root-is-a-file');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(blocker, 'not a directory');
  const r = await checkFile(join(ROOT, 'conformance', 'm1', 'sends.poly'), { root: blocker });
  assert.equal(r.verdict, 'ERROR');
  assert.deepEqual(r.machines.map((m) => m.verdict).filter((v) => v === 'CLEAN'), []);
  assert.equal(r.machines.length, 4);
});

// W3: sync-corpora's verify reports a listed file missing from a copy instead of throwing.
test('W3: expand lists a missing entry instead of throwing', async () => {
  const { expand } = await import('../scripts/sync-corpora.mjs');
  assert.deepEqual(expand(OUT, ['no-such-file']), ['no-such-file']);
});

// W4 (already fixed by 905083b, pinned here): an initial value outside a check domain, int or string, is PL1201.
test('W4: initial values are checked against int and string check domains', () => {
  const text = 'module c\nservice machine M {\n  state {\n    x : int check { 1, 2 } = 3\n    s : string check { "a", "b" } = "c"\n  }\n  action Go()\n  on Go { x\' = 1 }\n}\n';
  assert.deepEqual(codes(text), ['PL1201', 'PL1201']);
});
