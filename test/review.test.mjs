// Regression tests for the findings of the M0 code review (decisions-m0.md,
// "Rulings after the M0 code review"). Each was written to fail before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse, format } from '@poly/lang';
import { checkModule, digest } from '@poly/core';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'review');
const OUT = join(ROOT, '.poly', 'test-build', 'review');
const run = (name) => checkFile(join(FIX, name), { root: OUT });
const codes = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].map((d) => d.code);
const compile = (src) => {
  const p = parse(src);
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  return checkModule(p.module).diagnostics;
};
const machine = (body, types = 'enum Prio { High, Low }\ntype Job = Idle | Busy { prio: Prio }\n') =>
  `module t\n${types}machine M {\n  state {\n    j : Job = Idle\n    n : 0..3 = 0\n  }\n  action Go()\n  on Go {\n${body}\n  }\n}\n`;

// ── Finding 2, S21: names in patterns ──────────────────────────────────────

test('finding 2: an enum member in a payload pattern is a literal, so the violation is found', async () => {
  const r = await run('f2-enum-pattern.poly');
  assert.equal(r.verdict, 'FINDINGS', `got ${r.verdict}: ${codes(r).join(', ')}`);
  assert.ok(codes(r).includes('PL3001'));
});

test('finding 2: a misspelled constructor is refused at its line: PL1504 and PL1503', async () => {
  const r = await run('f2-misspelled.poly');
  assert.equal(r.verdict, 'REFUSED');
  const d = r.diagnostics;
  const unused = d.find((x) => x.code === 'PL1504');
  const unreachable = d.find((x) => x.code === 'PL1503');
  assert.ok(unused && unused.at.line === 22, JSON.stringify(d));
  assert.ok(unreachable && unreachable.at.line === 23, JSON.stringify(d));
});

test('S21 (2): a constructor of another type in a pattern is a type error, not a binder', () => {
  const src = machine("    match j { Busy { prio: Idle } => n' = 1  _ => n' = 2 }");
  assert.deepEqual(compile(src).map((d) => d.code), ['PL1201']);
});

test('S21 (4): `_` ignores a payload, and a read binder is fine', () => {
  assert.deepEqual(compile(machine("    match j { Busy { prio: _ } => n' = 1  Idle => n' = 2 }")), []);
  assert.deepEqual(compile(machine("    match j { Busy { prio: p } => if p == High { n' = 1 } else { n' = 2 }  Idle => n' = 3 }")), []);
});

test('S21 (5): an arm covered by the arms before it is PL1503', () => {
  const src = machine("    match j { Busy { prio: p } => if p == High { n' = 1 } else { n' = 2 }  Busy { prio: High } => n' = 0  Idle => n' = 3 }");
  assert.deepEqual(compile(src).map((d) => d.code), ['PL1503']);
  const wild = machine("    match j { _ => n' = 1  Idle => n' = 2 }");
  assert.deepEqual(compile(wild).map((d) => d.code), ['PL1503']);
});

test('S21: `_` in a payload pattern formats and reparses to the same AST', () => {
  const src = machine("    match j { Busy { prio: _ } => n' = 1  Idle => n' = 2 }");
  const m = parse(src).module;
  assert.equal(digest(parse(format(m)).module), digest(m));
  assert.match(format(m), /Busy \{ prio: _ \} =>/);
});

// ── Finding 1, S19 extended: one name rule in every context ────────────────

test('finding 1: an un-narrowed guard reads the field, not a same-named parameter', async () => {
  const r = await run('f1-guard-shadow.poly');
  assert.ok(!codes(r).includes('PL2501'), codes(r).join(', '));
  // At coins = 3 every Set is rejected "full": the one reachable deadlock.
  assert.deepEqual(codes(r), ['PL3201']);
});

test('finding 1: an un-narrowed reject property reads the field, and holds', async () => {
  const r = await run('f1-reject-shadow.poly');
  assert.ok(!codes(r).includes('PL2501'), codes(r).join(', '));
  assert.ok(!codes(r).includes('PL3003'), codes(r).join(', '));
});

test('S19: a colliding name in all four contexts checks CLEAN', async () => {
  const r = await checkFile(join(ROOT, 'conformance', 'm0', 'shadowing.poly'), { root: OUT });
  assert.equal(r.verdict, 'CLEAN', codes(r).join(', ') + (r.error ?? ''));
});

// ── Finding 3: every initial value is folded and range-checked ─────────────

test('finding 3: an initial value outside its range is PL1201 at its line', async () => {
  const r = await run('f3-init-range.poly');
  assert.equal(r.verdict, 'REFUSED');
  const d = r.diagnostics.filter((x) => x.code === 'PL1201');
  assert.equal(d.length, 1, JSON.stringify(r.diagnostics));
  assert.equal(d[0].at.line, 8);
});

test('finding 3: folded arithmetic, array items, payloads and check sets are checked too', () => {
  const field = (decl, types = '') => compile(`module t\n${types}machine M {\n  state {\n    ${decl}\n  }\n  action A()\n  on A { reject "no" }\n}\n`).map((d) => d.code);
  assert.deepEqual(field('n : 0..3 = 2 + 5'), ['PL1201']);
  assert.deepEqual(field('n : 0..3 = 1 + 1'), []);
  assert.deepEqual(field('m : map<0..1, 0..3> = [0, 9]'), ['PL1201']);
  assert.deepEqual(field('s : S = B { k: 7 }', 'type S = A | B { k: 0..3 }\n'), ['PL1201']);
  assert.deepEqual(field('p : int check { 10, 20 } = 15'), ['PL1201']);
  assert.deepEqual(field('w : string check { "a", "b" } = "c"'), ['PL1201']);
  assert.deepEqual(field('p : int check { 10, 20 } = 20'), []);
});

// ── Finding 7: polygraph's findings are confirmed by poly-ref ──────────────

test('finding 7: an invariant that fails only beyond a bound is a bound hit, INCONCLUSIVE', async () => {
  const r = await run('f7-beyond-bound.poly');
  assert.equal(r.verdict, 'INCONCLUSIVE', codes(r).join(', '));
  assert.ok(!codes(r).includes('PL3001'), codes(r).join(', '));
  assert.ok(codes(r).includes('PL3901'));
});

test('finding 7: a finding inside the instance stays a finding', async () => {
  const r = await checkFile(join(ROOT, 'test', 'fixtures', 'cli', 'invariant.poly'), { root: OUT });
  assert.equal(r.verdict, 'FINDINGS');
  assert.ok(codes(r).includes('PL3001'));
});

test('finding 7: a witness that poly-ref contradicts inside the instance is refused as a disagreement', async () => {
  const { checkMachine, confirmWitness } = await import('@poly/ref');
  const m = parse(readFileSync(join(ROOT, 'test', 'fixtures', 'cli', 'invariant.poly'), 'utf8')).module;
  const report = checkMachine(m, 'Counter');
  // `small: n < 2` holds at n = 1, so a witness claiming it fails there must be refused.
  const lie = { kind: 'state', property: 'small', path: [{ action: null, data: null, state: { n: 0 } }, { action: 'Inc', data: {}, state: { n: 1 } }] };
  assert.equal(confirmWitness(report, lie).status, 'disagrees');
  const truth = { kind: 'state', property: 'small', path: [...lie.path, { action: 'Inc', data: {}, state: { n: 2 } }] };
  assert.equal(confirmWitness(report, truth).status, 'confirmed');
});

// ── Finding 8: diagnostics carry structure; the merge never parses messages ─

test('finding 8: diagnostics carry the property, the field and the state digest', async () => {
  const inv = await checkFile(join(ROOT, 'test', 'fixtures', 'cli', 'invariant.poly'), { root: OUT });
  const d = inv.machines[0].diagnostics.find((x) => x.code === 'PL3001');
  assert.equal(d.property, 'small');
  assert.match(d.stateDigest ?? '', /^sha256:[0-9a-f]{64}$/);
  const esc = await checkFile(join(ROOT, 'test', 'fixtures', 'cli', 'escape.poly'), { root: OUT });
  const e = esc.machines[0].diagnostics.find((x) => x.code === 'PL3102');
  assert.equal(e.field, 'intent');
});

test('finding 8: findings merge on (code, property or field), never on message text', async () => {
  const { mergeFindings } = await import('@poly/check');
  const pg = [{ code: 'PL3002', property: 'p', message: 'polygraph wording', at: {} }];
  const ref = [{ code: 'PL3002', property: 'p', message: 'different wording entirely', at: {} }, { code: 'PL3003', property: 'q', message: 'x', at: {} }];
  const merged = mergeFindings(pg, ref);
  assert.deepEqual(merged.map((d) => `${d.code}:${d.property}`), ['PL3002:p', 'PL3003:q']);
});

void readFileSync;
