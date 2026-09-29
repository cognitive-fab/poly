// The lowering's contract: it lowers only what the checker accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { lowerMachine } from '@poly/lower';

test('a refused program is not lowered: its errors come back, nothing throws', () => {
  // Unbounded payloads and an unchecked int parameter: PL1101 (PT3.2).
  const src = 'module t\ntype P = A { s: string } | B { n: int }\nmachine M {\n  state { p : P = B { n: 1 } }\n  action Go(k: int)\n  on Go(k) { p\' = A { s: "x" } }\n}\n';
  const m = parse(src).module;
  const check = checkModule(m);
  const r = lowerMachine(m, check, 'M');
  assert.equal(r.lowered, null);
  assert.ok(r.diagnostics.length >= 4);
  assert.ok(r.diagnostics.every((d) => d.code === 'PL1101'));
});
