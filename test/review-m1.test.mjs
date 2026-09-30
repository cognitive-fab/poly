// The M1 code review over ca2e6b2..122b520. Each finding has a test here that failed before its fix;
// the programs are in test/fixtures/review-m1, named by the review area and the reviewer's repro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse, format } from '@poly/lang';
import { checkModule } from '@poly/core';
import { lowerMachine } from '@poly/lower';
import { checkFile, render } from '@poly/check';
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

