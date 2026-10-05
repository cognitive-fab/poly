// The M8a review, part B: use across modules (S176, PS1.0). Each test failed on the tree before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';

const OUT = join(ROOT, '.poly', 'test-review-m8a-b');
function dir(name, files) {
  const d = join(OUT, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  for (const [f, t] of files) writeFileSync(join(d, f), t);
  return d;
}
const check = (file, name) => checkFile(file, { root: join(OUT, `${name}-root`) });
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];

test('B-F1: a used module the checker refuses refuses the check that uses it, with its own errors', { timeout: 120_000 }, async () => {
  const d = dir('f1', [
    ['b.poly', 'module b\n\nmachine W {\n  state { n: 0..1 = 0   flag: bool = true }\n  terminal n == 1\n  action Go()\n  on Go { n\' = 1   require flag else reject "off" }\n}\n'],
    ['a.poly', 'module a\nuse b\n\nmachine Solo {\n  state { k: 0..1 = 0 }\n  terminal k == 1\n  action Tick()\n  on Tick { require k == 0 else reject "t"   k\' = 1 }\n}\n\nconfiguration c {\n  w : b.W\n  s : Solo\n  inputs { w.Go, s.Tick }\n  bounds { transit 2 }\n  invariant w-in-range: w.n <= 1\n}\n'],
  ]);
  const r = await check(join(d, 'a.poly'), 'f1');
  assert.equal(r.verdict, 'REFUSED', JSON.stringify(all(r).map((x) => x.message)));
  assert.ok(r.diagnostics.some((x) => x.code === 'PL2101' && /module b/.test(x.message)));
});

test('B-F2, PS1.0: module b spawns b.c.X, the machine X of module b.c', { timeout: 120_000 }, async () => {
  const d = dir('f2', [
    ['bc.poly', 'module b.c\n\nmachine X {\n  state { n: 0..2 = 0 }\n  terminal n > 0\n  action Create(n: 1..2)\n  on Create(n) { require n > 0 else reject "zero"   n\' = n }\n}\n'],
    ['b.poly', 'module b\nuse b.c\n\nmachine P {\n  state { started: bool = false }\n  terminal started\n  action Go()\n  on Go {\n    require !started else reject "started"\n    spawn detached b.c.X as w -> Create(n: 1)\n    started\' = true\n  }\n}\n'],
  ]);
  const r = await check(join(d, 'b.poly'), 'f2');
  assert.equal(r.verdict, 'CLEAN', `${r.error ?? ''} ${JSON.stringify(all(r).map((x) => x.message))}`);
});

test('B-F3, S176: two files that declare the checked module are refused when another module uses it', { timeout: 120_000 }, async () => {
  const a = 'module a\nuse b\n\nmachine A {\n  state { k: 0..1 = 0 }\n  terminal k == 1\n  action Tick()\n  on Tick { require k == 0 else reject "t"   k\' = 1 }\n}\n';
  const d = dir('f3', [
    ['a.poly', a],
    ['a-copy.poly', a.replace('use b\n', '')],
    ['b.poly', 'module b\nuse a\n\nmachine B {\n  state { r: Ref<a.A> = none   done: bool = false }\n  terminal done\n  action Go()\n  on Go { require !done else reject "d"   done\' = true }\n}\n'],
  ]);
  const r = await check(join(d, 'a.poly'), 'f3');
  assert.ok(r.diagnostics.some((x) => x.code === 'PL1002' && /module a/.test(x.message)), JSON.stringify(r.diagnostics.map((x) => x.message)));
});

test('B-F4, S190: a field whose enum another module declares is read in a configuration only with is', { timeout: 120_000 }, async () => {
  const B = 'module b\n\nenum S { Idle, Busy }\n\nmachine W {\n  state { st: S = Idle }\n  terminal st is Busy\n  action Go()\n  on Go { require st is Idle else reject "busy"   st\' = Busy }\n}\n';
  const A = (inv) => `module a\nuse b\n\nenum S { Idle, Gone }\n\nmachine A {\n  state { st: S = Idle }\n  terminal st is Gone\n  action Leave()\n  on Leave { require st is Idle else reject "gone"   st' = Gone }\n}\n\nconfiguration c {\n  w : b.W\n  x : A\n  inputs { w.Go, x.Leave }\n  bounds { transit 2 }\n  invariant p: ${inv}\n}\n`;
  for (const [name, inv, want] of [['v1', 'w.st != Gone', 'REFUSED'], ['v2', 'w.st == x.st implies x.st is Idle', 'REFUSED'], ['v3', 'w.st is Busy implies x.st is Idle', null]]) {
    const d = dir(`f4-${name}`, [['b.poly', B], ['a.poly', A(inv)]]);
    const r = await check(join(d, 'a.poly'), `f4-${name}`);
    if (want) assert.ok(r.diagnostics.some((x) => x.code === 'PL0901' && /S190/.test(x.message)), `${inv}: ${JSON.stringify(r.diagnostics.map((x) => x.message))}`);
    else assert.notEqual(r.verdict, 'REFUSED', `${inv}: ${JSON.stringify(all(r).map((x) => x.message))}`);
  }
});

test('B-F5, PS1.0: a dotted module\'s machine names its group of detached instances, m.n.M[*]', { timeout: 180_000 }, async () => {
  const U = join(ROOT, 'conformance', 'm8', 'use');
  const rename = (t) => t.replaceAll('workers.Worker', 'team.workers.Worker').replace('module workers', 'module team.workers').replace('use workers.Worker', 'use team.workers');
  const d = dir('f5', [['workers.poly', rename(readFileSync(join(U, 'workers.poly'), 'utf8'))], ['dispatch.poly', rename(readFileSync(join(U, 'dispatch.poly'), 'utf8'))]]);
  const r = await check(join(d, 'dispatch.poly'), 'f5');
  assert.equal(r.verdict, 'CLEAN', `${r.error ?? ''} ${JSON.stringify(all(r).map((x) => x.message))}`);
  assert.equal(r.configurations[0].instance.states, 5);
});
