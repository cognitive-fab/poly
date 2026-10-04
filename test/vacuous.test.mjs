// Vacuous properties (PT12.3, S113, S128): a property whose antecedent is never true where it is judged is
// INCONCLUSIVE with reason `vacuous`, naming the property and its antecedent, never CLEAN. One seed per kind of
// S128, each with a non-vacuous twin that stays CLEAN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';

const OUT = join(ROOT, '.poly', 'test-vacuous');
mkdirSync(OUT, { recursive: true });
const write = (name, src) => { const f = join(OUT, name); writeFileSync(f, src); return f; };
const check = (name, src) => checkFile(write(name, src), { root: OUT });

// A and B alternate; C is never reached, and Go is rejected "not-a" only in B.
const machine = (prop) => `module v
enum S { A, B, C }
machine M {
  state { s : S = A  n : 0..1 = 0 }
  action Go()
  action Back()
  on Go { require s == A else reject "not-a"  s' = B }
  on Back { require s == B else reject "not-b"  s' = A }
  ${prop}
}
`;

async function expectVacuous(name, src, property, antecedent) {
  const r = await check(name, src);
  const m = r.configurations[0] ?? r.machines[0];
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), [], name);
  assert.equal(m.verdict, 'INCONCLUSIVE', `${name}: ${JSON.stringify(m.diagnostics.map((d) => d.code))}`);
  assert.equal(r.verdict, 'INCONCLUSIVE');
  const v = m.vacuous.find((x) => x.property === property);
  assert.ok(v, `${name}: ${JSON.stringify(m.vacuous)}`);
  assert.equal(v.antecedent, antecedent);
  return v;
}

async function expectClean(name, src) {
  const r = await check(name, src);
  const m = r.configurations[0] ?? r.machines[0];
  assert.deepEqual(m.vacuous, [], name);
  assert.equal(m.verdict, 'CLEAN', `${name}: ${JSON.stringify(m.diagnostics.map((d) => `${d.code} ${d.message}`))} ${JSON.stringify(m.notRun)}`);
}

test('an invariant whose antecedent is unreachable is vacuous; its twin is clean', async () => {
  await expectVacuous('inv.poly', machine('invariant v: s == C implies n == 0'), 'v', 's == C');
  await expectClean('inv-twin.poly', machine('invariant v: s == B implies n == 0'));
});

test('a step property is judged over accepted transitions', async () => {
  await expectVacuous('step.poly', machine('step property v: post.s == C implies pre.s == A'), 'v', 'post.s == C');
  await expectClean('step-twin.poly', machine('step property v: post.s == B implies pre.s == A'));
});

test('a reject property is judged over every transition', async () => {
  await expectVacuous('reject.poly', machine('reject property v: (rejected("not-a") && s == A) implies n == 0'), 'v', 'rejected("not-a") && s == A');
  await expectClean('reject-twin.poly', machine('reject property v: rejected("not-a") implies s == B'));
});

test('leads to: P never true is vacuous', async () => {
  await expectVacuous('live.poly', machine('liveness v: s == C leads to s == A under fair { Go, Back }'), 'v', 's == C');
  await expectClean('live-twin.poly', machine('liveness v: s == B leads to s == A under fair { Go, Back }'));
});

test('the right spine of implies: the antecedent is the conjunction of its left sides', async () => {
  await expectVacuous('spine.poly', machine('invariant v: s == B implies n == 1 implies s == A'), 'v', 's == B && n == 1');
});

test('a conjunction is judged conjunct by conjunct, and one vacuous conjunct is enough', async () => {
  await expectVacuous('conj.poly', machine('invariant v: (s == B implies n == 0) && (s == C implies n == 1)'), 'v', 's == C');
});

test('an implication nested under another operator is not judged', async () => {
  await expectClean('nested.poly', machine('invariant v: !(s == C) || (s == C implies n == 0)'));
});

const shop = (ship) => `module bv
enum P { Start, Packed, Done }
machine M {
  state { p : P = Start }
  terminal p == Done
  action Pack()
  action Ship()
  action Finish()
  on Finish { require p == Packed else reject "no"  p' = Done }
  on Pack { require p == Start else reject "no"  p' = Packed  emit pack(1) }
  on Ship { ${ship}  p' = Done  emit ship(1) }
  path property pack-first: count("w.pack") <= 1 && before("w.pack", "w.ship")
  effect pack(n: 0..1) {
    kind "w.pack"
    labels { write:store }
  }
  effect ship(n: 0..1) {
    kind "w.ship"
    labels { egress:external }
  }
}
`;

test('before(k1, k2) with no k2 ever emitted is vacuous; count clauses have no antecedent', async () => {
  await expectVacuous('before.poly', shop('require p == Packed else reject "no"  require p == Start else reject "never"'), 'pack-first', 'before("w.pack", "w.ship"): no w.ship is emitted');
  await expectClean('before-twin.poly', shop('require p == Packed else reject "no"'));
});

const config = (prop) => `module cv
enum S { Idle, Sent, Got }
machine A {
  state { s : S = Idle   peer : Ref<B> = none }
  terminal s == Sent
  action Go()
  on Go { require s == Idle else reject "sent"  s' = Sent  send peer <- Ping() }
}
service machine B {
  state { n : 0..2 = 0 }
  action Ping()
  on Ping { require n < 2 else reject "full"  n' = n + 1 }
}
configuration c {
  b    : B
  a[2] : A { peer: b }
  inputs { a[*].Go }
  bounds { transit 2 }
  ${prop}
}
`;

test('a quantified configuration invariant is judged for every member of its group', async () => {
  const v = await expectVacuous('config.poly', config('invariant v: forall i in a: a[i].s == Got implies b.n >= 1'), 'v', 'a[i].s == Got');
  assert.equal(v.member, 0);
  await expectClean('config-twin.poly', config('invariant v: forall i in a: a[i].s == Sent implies b.n <= 2'));
});

test('the report says vacuous, and the rendered verdict names the antecedent', async () => {
  const { render } = await import('@poly/check');
  const r = await check('inv.poly', machine('invariant v: s == C implies n == 0'));
  assert.match(render(r), /vacuous: v, its antecedent s == C is never true/);
});
