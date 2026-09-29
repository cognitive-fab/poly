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

void readFileSync;
