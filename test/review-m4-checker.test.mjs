// The checker findings of M4's code review (part D), each a test that failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile, render } from '@poly/check';
import { ROOT } from './helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'review-m4');
const OUT = join(ROOT, '.poly', 'test-review-m4');
mkdirSync(OUT, { recursive: true });
const codes = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)].map((d) => d.code);

test('review D2: two decisions sharing a completion action: adjudicating the one never decided is PL6203', async () => {
  const r = await checkFile(join(FIX, 'shared2.poly'), { root: OUT });
  assert.ok(codes(r).includes('PL6203'), render(r));
});

test('review D3: an adjudication in the decision\'s own completion step is not PL6203', async () => {
  const r = await checkFile(join(FIX, 'incompletion.poly'), { root: OUT });
  assert.ok(!codes(r).includes('PL6203'), render(r));
});

test('review D4: a compose invariant whose antecedent never holds is vacuous, never CLEAN', async () => {
  const r = await checkFile(join(FIX, 'compose2.poly'), { root: OUT });
  const order = r.machines.find((m) => m.machine === 'Order');
  assert.deepEqual(order.vacuous.map((v) => v.property), ['never']);
  assert.equal(order.verdict, 'INCONCLUSIVE');
});

test('review D5: the antecedent is printed with the parentheses its meaning needs', async () => {
  const f = join(OUT, 'vac1.poly');
  writeFileSync(f, 'module v\nenum S { A, B, C }\nmachine M {\n  state { s : S = A  n : 0..1 = 0 }\n  action Go()\n  action Back()\n  on Go { require s == A else reject "not-a"  s\' = B }\n  on Back { require s == B else reject "not-b"  s\' = A }\n  invariant v: (s == C || n == 1) implies s == B implies n == 0\n}\n');
  const r = await checkFile(f, { root: OUT });
  assert.equal(r.machines[0].vacuous[0].antecedent, '(s == C || n == 1) && s == B');
});

test('review D6: a path property can name an adjudication\'s kind', async () => {
  const r = await checkFile(join(FIX, 'pathout.poly'), { root: OUT });
  assert.ok(!codes(r).includes('PL1001'), render(r));
  assert.ok(r.verdict === 'CLEAN' || r.verdict === 'INCONCLUSIVE', render(r));
});
