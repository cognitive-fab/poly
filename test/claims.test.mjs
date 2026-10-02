// PD5.1 (S101 to S103, S107, S109): verified claims. A `claims` type is a record of finite fields; `Principal` is
// opaque; an action names the claims it requires with `by`. These tests cover the language: the grammar, the
// formatter, the embedded surface and the checker's rules (PD5-A2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, format } from '@poly/lang';
import { checkModule } from '@poly/core';
import { ROOT } from './helpers.mjs';

const SRC = readFileSync(join(ROOT, 'conformance/m5/refund.poly'), 'utf8');
const codes = (src) => { const r = parse(src); return r.module ? [...r.diagnostics, ...checkModule(r.module).diagnostics].map((d) => d.code) : r.diagnostics.map((d) => d.code); };
const strip = (x) => JSON.stringify(x, (k, v) => (k === 'span' || k === 'id' ? undefined : v));

test('PD5.1.2: the refund example parses, checks clean, and formats back to the same module', () => {
  assert.deepEqual(codes(SRC), []);
  const m = parse(SRC).module;
  const c = m.decls.find((d) => d.kind === 'RecordDecl' && d.name === 'Caller');
  assert.equal(c.claims, true);
  const h = m.decls.find((d) => d.kind === 'Machine').items.find((i) => i.kind === 'Handler' && i.action === 'Approve');
  assert.deepEqual(h.by, { name: 'caller', type: 'Caller' });
  const printed = format(m);
  assert.match(printed, /^claims Caller \{$/m);
  assert.match(printed, /on Approve\(\) by caller: Caller \{/);
  assert.equal(strip(parse(printed).module), strip(m));
});

const prog = (claimsFields, body = 'first\' = caller.principal', field = 'first : Principal = none') => `module t

enum Kind { Person, Agent }

claims Caller {
${claimsFields}
}

machine M {
  state { ${field} }
  action Go()
  on Go() by caller: Caller {
    ${body}
  }
}
`;

test('PD5-A2: a claims field of type int or string is PL1101, of type Tri is PL1203', () => {
  assert.deepEqual(codes(prog('  kind: Kind\n  principal: Principal')), []);
  assert.deepEqual(codes(prog('  kind: Kind\n  level: int\n  principal: Principal')), ['PL1101']);
  assert.deepEqual(codes(prog('  kind: Kind\n  name: string\n  principal: Principal')), ['PL1101']);
  assert.deepEqual(codes(prog('  kind: Kind\n  ok: Tri\n  principal: Principal')), ['PL1203']);
});

test('PD5-A2: a Principal ordered, in arithmetic, compared with a string or used as a map key is PL1206; equality, storage and passing are accepted', () => {
  const f = '  kind: Kind\n  principal: Principal';
  assert.deepEqual(codes(prog(f, 'require caller.principal != first else reject "same"\n    first\' = caller.principal')), []);
  assert.deepEqual(codes(prog(f, 'require caller.principal < first else reject "later"\n    first\' = caller.principal')), ['PL1206']);
  assert.deepEqual(codes(prog(f, 'require caller.principal == "alice" else reject "who"\n    first\' = caller.principal')), ['PL1206']);
  assert.deepEqual(codes(prog(f, 'n\' = caller.principal + 1', 'n : 0..3 = 0')), ['PL1206']);
  assert.deepEqual(codes(prog(f, 'seen\' = seen with [caller.principal] = true', 'seen : map<Principal, bool> = {}')), ['PL1206']);
});

test('PD5.1.2: `by` names a claims type, and a claims binder is read only where it is bound', () => {
  assert.deepEqual(codes(prog('  kind: Kind\n  principal: Principal').replace('by caller: Caller', 'by caller: Kind')), ['PL1201']);
  assert.deepEqual(codes(prog('  kind: Kind\n  principal: Principal').replace('by caller: Caller', 'by caller: Nobody')), ['PL1001']);
});

test('PD5.1.2: the embedded surface carries claims and `by`, and prints back to the same module', async () => {
  const { printModule, readEmbedded } = await import('@poly/embed');
  const m = parse(SRC).module;
  const ts = printModule(m);
  assert.match(ts, /claims\("Caller"/);
  assert.match(ts, /by: \["caller", "Caller"\]/);
  const back = readEmbedded(ts, 'refund.ts');
  assert.deepEqual(back.diagnostics ?? [], []);
  assert.equal(strip(back.module), strip(m));
});

// PD5-A3 (S102, S113): poly-ref reproduces principal_symmetry.py. The reachable states of the refund example for
// 2, 3 and 4 representatives are 7, 13 and 21; the default is the Principal positions plus one, 3, printed in the
// instance line; a mutant without the self-approval require is a finding whose witness requests and approves with
// one principal; one representative leaves no approval reachable, so the invariant is vacuous and nothing is clean.
test('PD5-A3: principal representatives reproduce the evidence', async () => {
  const { checkMachine } = await import('@poly/ref');
  const m = parse(SRC).module;
  assert.deepEqual([2, 3, 4].map((n) => checkMachine(m, 'Refund', { principals: n }).states), [7, 13, 21]);
  const def = checkMachine(m, 'Refund');
  assert.equal(def.instance.principals, 3);
  assert.deepEqual(def.findings.map((f) => f.code), []);
  const one = checkMachine(m, 'Refund', { principals: 1 });
  assert.deepEqual(one.findings, []);
  assert.deepEqual(one.vacuous.map((v) => v.property), ['not-self-approved']);
  const mutant = parse(SRC.replace('    require caller.principal != requester else reject "self-approval"\n', '')).module;
  const f = checkMachine(mutant, 'Refund').findings.find((x) => x.code === 'PL3001');
  assert.ok(f);
  const steps = f.witness.trace.map((s) => [s.action, s.data.$claims?.principal]);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map(([a]) => a), ['Request', 'Approve']);
  assert.equal(steps[0][1], steps[1][1]);
  const { checkFile } = await import('@poly/check');
  const { render } = await import('../packages/poly-check/dist/src/render.js');
  const r = await checkFile(join(ROOT, 'conformance/m5/refund.poly'), { root: join(ROOT, '.poly', 'test-claims') });
  assert.equal(r.verdict, 'CLEAN', render(r));
  assert.match(render(r), /3 principal representatives/);
});
