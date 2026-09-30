// The M2 code review over 9e1d045..HEAD, and the polywatch findings on the rulings' commits. Each finding has
// a test here that failed before its fix; the programs are in test/fixtures/review-m2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkFile, exportWitness, findWitness, render } from '@poly/check';
import { ROOT, BUILD } from './helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'review-m2');
const src = (name) => readFileSync(join(FIX, `${name}.poly`), 'utf8');
const codes = (text) => {
  const p = parse(text);
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  return checkModule(p.module).diagnostics.map((d) => d.code);
};
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
async function check(name, text) {
  const dir = join(BUILD, 'review-m2', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'm.poly');
  writeFileSync(f, text);
  return { dir, f, r: await checkFile(f, { root: dir }) };
}
/** Exports the witness of the first diagnostic with this code and runs it as a user would. */
function runWitness(r, dir, code) {
  const d = all(r).find((x) => x.code === code);
  assert.ok(d?.witness, `no ${code} with a witness\n${render(r)}`);
  const out = exportWitness(findWitness(JSON.parse(JSON.stringify(r)), d.witness.id), { root: dir, kind: 'test' });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', out], { encoding: 'utf8', env });
}

// ── polywatch, on the rulings' commits ─────────────────────────────────────

test('polywatch 2: a witness of no steps, for an invariant false in the initial state, still fails its exported test', async () => {
  const { dir, r } = await check('pw-initial', src('pw-initial'));
  const run = runWitness(r, dir, 'PL3001');
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(run.stdout, /invariant positive is violated in the initial state/);
});

// ── the front ends and the checker (A) ─────────────────────────────────────

const ROUTER = readFileSync(join(ROOT, 'conformance', 'm2', 'decisions', 'router.poly'), 'utf8');
const DETACHED = readFileSync(join(ROOT, 'conformance', 'm2', 'detached.poly'), 'utf8');
const STUCK = readFileSync(join(ROOT, 'conformance', 'm2', 'seeded', 'stuck', 'unfixed.poly'), 'utf8');
const swap = (base, a, b) => { const s = base.replace(a, b); assert.notEqual(s, base, a); return s; };

test('A1: a decimal ending in .0 reads from the embedded surface as the decimal it is (S76, S71)', async () => {
  const { printModule, readEmbedded } = await import('@poly/embed');
  const { digest } = await import('@poly/core');
  const poly = swap(ROUTER, 'if conf >= 0.8 && margin >= 0.3 {', 'if conf >= 1.0 && margin >= 0.0 {');
  const m = parse(poly).module;
  const back = readEmbedded(printModule(m));
  assert.ok(back.module, JSON.stringify(back.diagnostics));
  assert.equal(digest(back.module), digest(m));
  // Four digits after the point are refused, as the standalone lexer refuses them.
  const four = readEmbedded(printModule(m).replace('>= 1.0', '>= 0.8000'));
  assert.equal(four.module, null);
});

test('A2: a decimal in a configuration property is PL1201 (S76)', () => {
  assert.deepEqual(codes(STUCK.replace('invariant confirmed-within-stock:', 'invariant half: inv.onHand + 0.5 >= 1\n  invariant confirmed-within-stock:')), ['PL1201']);
});

test('A3: a fair InputRef names a member of its group, as an input does (S73, S31)', () => {
  const src = STUCK.replace('  invariant confirmed-within-stock:', '  liveness done: eventually inv.onHand == 0 under fair { order[5].Place }\n  invariant confirmed-within-stock:');
  assert.deepEqual(codes(src), ['PL1201']);
});

test('A4, A5: a Conf is only a completion parameter bound from a reply (PD1.3b, PD1.4b)', () => {
  assert.deepEqual(codes(swap(ROUTER, '    order  : 1..2         = 1\n', '    order  : 1..2         = 1\n    cm     : map<0..1, Conf> = { 0: 1, 1: 1 }\n')), ['PL1205']);
  assert.deepEqual(codes(swap(ROUTER, 'enum Branch', 'type Sc = { c: Conf }\nenum Branch')), ['PL1205']);
  assert.deepEqual(codes(swap(swap(ROUTER, '  action RouteFailed()\n', '  action RouteFailed()\n  action Poke(c: Conf)\n'), '  on RouteFailed {', '  on Poke(c) { require c >= 0.5 else reject "low"   status\' = Handled }\n  on RouteFailed {')), ['PL1205']);
});

test('A6: an effect whose kind is a decision\'s kind is PL1002 (PD1.7, S41)', () => {
  assert.deepEqual(codes(swap(ROUTER, 'kind "support.reply"', 'kind "decision.route"')), ['PL1002']);
});

test('A7: one key, one child, whatever the order of the handlers (PT6.4, S60)', () => {
  const base = DETACHED.slice(0, DETACHED.indexOf('configuration pool'));
  const second = swap(swap(base, '  action Done()\n', '  action Done()\n  action Go2()\n'), '  on Done {', '  on Go2 { require started else reject "x"   spawn Worker as w -> Start(n: 1)   done\' = 1 }\n  on Done {');
  assert.deepEqual(codes(second), ['PL1002']);
});

test('A8: one mistake, one diagnostic, for a decimal compared with an int, a negated Conf, and a missing bound', () => {
  assert.deepEqual(codes(swap(ROUTER, 'if conf >= 0.8 && margin >= 0.3 {', 'if order >= 0.5 {')), ['PL1201']);
  assert.deepEqual(codes(swap(ROUTER, 'if conf >= 0.8 && margin >= 0.3 {', 'if -conf < 0 {')), ['PL1205']);
  assert.deepEqual(codes(swap(DETACHED, '  bounds  { transit 2, instances 2 }\n', '')), ['PL5303']);
});

test('A9: Tri.Unknown is always legal (S76)', () => {
  assert.deepEqual(codes(swap(ROUTER, '  path property one-routing', '  invariant tri: Tri.Unknown == Tri.Unknown\n  path property one-routing')), []);
});

// ── the lowering (B) ───────────────────────────────────────────────────────

test('B1: a record parameter bound from a reply is checked by value at dispatch, so the program checks clean', async () => {
  const { r } = await check('b1', src('b1-record-reply'));
  assert.equal(r.verdict, 'CLEAN', render(r));
});

test('B3, B4: an int beside a Conf means thousandths in poly-ref and in a completion constant (PD1.3a)', async () => {
  const { dir, r } = await check('b3', src('b3-conf-eq'));
  assert.equal(r.verdict, 'CLEAN', render(r));
  const manifest = JSON.parse(readFileSync(join(dir, '.poly', 'build', 'b3.M', 'effects.manifest.json'), 'utf8'));
  assert.deepEqual(manifest.effects['decision.pick'].onFailure, { action: 'Go', data: { k: 'Y', conf: 1000 } });
});

test('B5: a detached child\'s address is stored, sent to or passed on, never compared before its step commits (S78)', () => {
  assert.deepEqual(codes(src('b5-marker-compare')), ['PL0901']);
  assert.deepEqual(codes(src('b5-marker-compare').replace("    same' = last == w\n", '')), []);
});

test('B6: a decision whose result is a record with a Tri field is read back, not a crash', async () => {
  const { r } = await check('b6', src('b6-tri-record'));
  assert.notEqual(r.verdict, 'ERROR', render(r));
  assert.equal(r.verdict, 'CLEAN', render(r));
});

// ── poly-ref (C) ───────────────────────────────────────────────────────────

test('C1, C3: an input names only instances that exist, and reaches a spawned child only after its creation action', async () => {
  const { r } = await check('c1', src('c1-poke'));
  assert.notEqual(r.verdict, 'ERROR', r.error);
  // Tell may send without end, so the transit bound is hit (PL5301); nothing else is found, and no invariant fails.
  assert.deepEqual(r.configurations[0].diagnostics.map((d) => d.code).filter((c) => c !== 'PL5301'), [], render(r));
});

test('C2: a spawned group is read through a quantifier or an aggregate, never by a constant index (S60)', () => {
  const s = src('c1-poke').replace('  invariant start-first:', '  invariant direct: Worker[0].poked implies d.started\n  invariant start-first:');
  assert.deepEqual(codes(s), ['PL1201']);
});

test('C4: per-value input fairness ranges over the configuration\'s addresses, so no spurious lasso (S73)', async () => {
  const { r } = await check('c4', src('c4-ping'));
  assert.deepEqual(r.configurations[0].diagnostics.filter((d) => d.code === 'PL3301'), [], render(r));
});

test('C5: the path-property read-back tells apart a predicate that counts another kind or every emission (PS5.4)', async () => {
  const { translationValidate } = await import('@poly/ref');
  const text = readFileSync(join(ROOT, 'conformance', 'm1', 'effects.poly'), 'utf8');
  for (const [i, wrong] of ['p.emitted.length <= 2', 'p.count("mail.notice") <= 2 && p.count("mail.receipt") == 0'].entries()) {
    const { dir } = await check(`c5-${i}`, text);
    const file = join(dir, '.poly', 'build', 'effects.Account', 'effect-invariants.mjs');
    writeFileSync(file, readFileSync(file, 'utf8').replace('p.count("mail.notice") <= 2', wrong));
    const tv = await translationValidate(parse(text).module, 'Account', join(dir, '.poly', 'build', 'effects.Account'));
    assert.ok(tv.mismatches.some((m) => /effect-invariants\.mjs few-notices/.test(m.message)), wrong);
  }
});

test('C6: translation validation resolves a child marker only in the step that creates the child (S78)', async () => {
  const { translationValidate } = await import('@poly/ref');
  const { dir } = await check('c6', DETACHED);
  const build = join(dir, '.poly', 'build', 'detached.Dispatcher');
  const next = join(build, 'next.cjs');
  writeFileSync(next, readFileSync(next, 'utf8').replace('next["done"] = 1;', 'next["done"] = 1; next["worker"] = ({ $ref: "child", key: "w" });'));
  const tv = await translationValidate(parse(DETACHED).module, 'Dispatcher', build);
  assert.ok(tv.mismatches.some((m) => /Done/.test(m.message)), JSON.stringify(tv.mismatches.map((m) => m.message)));
});
