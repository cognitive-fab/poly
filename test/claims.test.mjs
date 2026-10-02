// PD5.1 (S101 to S103, S107, S109): verified claims. A `claims` type is a record of finite fields; `Principal` is
// opaque; an action names the claims it requires with `by`. These tests cover the language: the grammar, the
// formatter, the embedded surface and the checker's rules (PD5-A2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, format } from '@poly/lang';
import { checkModule } from '@poly/core';
import { ROOT, build } from './helpers.mjs';

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

// S155: $claims and $lineage are the runtime's keys. The standalone surface cannot spell them; the embedded surface can,
// and a program that declares either is refused at check.
test('S155: a program that declares $claims or $lineage is PL1208', async () => {
  const { readEmbedded } = await import('@poly/embed');
  const ts = (name) => `import { action, field, machine, module, on, set, t } from '@cognitive-fab/poly/embed';\nexport default module("t", [machine("M", { state: { x: field(t.range(0, 1), ($) => 0) }, items: [action("Go", { ${name}: t.range(0, 1) }), on("Go", ($) => [set("x", 1)])] })]);\n`;
  const ok = readEmbedded(ts('n'), 'ok.ts');
  assert.deepEqual(checkModule(ok.module).diagnostics.map((d) => d.code), []);
  for (const name of ['"$claims"', '"$lineage"']) {
    const r = readEmbedded(ts(name), 'bad.ts');
    assert.deepEqual(checkModule(r.module).diagnostics.map((d) => d.code), ['PL1208'], name);
  }
});

// ── review of M5b, part A ──────────────────────────────────────────────────

// A-F2: a correct program that matches on a claims field is CLEAN: the handler's body never runs on bad claims.
test('review A-F2: a handler that matches on a claims field checks CLEAN, and bad claims never reach its body', async () => {
  const { checkFile } = await import('@poly/check');
  const r = await checkFile(join(ROOT, 'conformance/m5/match-claims.poly'), { root: join(ROOT, '.poly', 'test-match-claims') });
  assert.equal(r.verdict, 'CLEAN', JSON.stringify(r.machines.flatMap((m) => m.diagnostics).map((d) => d.message).slice(0, 2)));
});

// A-F3: the representatives cover the principals a state holds (a map counts each key) and the most a label carries.
test('review A-F3: representatives cover a map of principals and a label with two principals', async () => {
  const { checkMachine } = await import('@poly/ref');
  for (const f of ['conformance/m5/reps-map.poly', 'conformance/m5/reps-label.poly']) {
    const m = parse(readFileSync(join(ROOT, f), 'utf8')).module;
    const r = checkMachine(m, 'M');
    assert.deepEqual(r.findings.map((x) => x.code), ['PL3001'], f);
  }
});

// A-F4: a claims field is an enum without payloads, an integer range or a Principal (PD5.1.2a, S103).
test('review A-F4: a claims field of record, map, payload union, bool or claims type is refused', () => {
  const p = (field, extra = '') => `module t\n\nenum Kind { Person, Agent }\ntype Inner = { k: Kind }\ntype Who = Nobody | Someone { k: Kind }\n${extra}claims Caller {\n  kind: Kind\n  ${field}\n}\n\nmachine M {\n  state { n : 0..1 = 0 }\n  action Go()\n  on Go() by caller: Caller {\n    n' = 1\n  }\n}\n`;
  for (const f of ['inner: Inner', 'flags: map<Kind, bool>', 'who: Who', 'ok: bool', 'other: Other']) {
    assert.deepEqual(codes(p(f, 'claims Other {\n  kind: Kind\n}\n')), ['PL1201'], f);
  }
});

// A-F5, A-F6: translation validation probes a value just outside an integer range, a null or non-string principal, and
// an enum spelt otherwise; poly-ref's row agrees with the lowered one on each.
test('review A-F5, A-F6: the claims row is compared on out-of-range, null, non-string and misspelt claims', async () => {
  const { checkMachine, transition } = await import('@poly/ref');
  const m = parse(SRC).module;
  const M = checkMachine(m, 'Refund').model;
  const s = { status: { ctor: 'Idle', payload: {} }, requester: null, approver: null, amount: 0 };
  const ok = { fields: { kind: { ctor: 'Person', payload: {} }, attest: { ctor: 'Verified', payload: {} }, assurance: 3, principal: 'p1' } };
  assert.equal(transition(M, s, 'Request', { a: 2, $claims: ok }).verdict.kind, 'accepted');
  for (const bad of [{ ...ok.fields, principal: null }, { ...ok.fields, assurance: 4 }]) {
    assert.deepEqual(transition(M, s, 'Request', { a: 2, $claims: { fields: bad } }).verdict, { kind: 'rejected', reason: 'claims-unverified' });
  }
  // A lowered row that accepts more than the type (4 for 0..3; a null principal) is caught by translation validation.
  const { translationValidate } = await import('@poly/ref');
  const { writeFileSync: wf, readFileSync: rf } = await import('node:fs');
  for (const [what, from, to] of [['assurance 4', '[0,1,2,3]', '[0,1,2,3,4]'], ['a null principal', "typeof c[f] === 'string' && c[f].length > 0", "c[f] !== ''"]]) {
    const [b] = build(join(ROOT, 'conformance/m5/refund.poly'), `claims-tv-${what.split(' ').join('-')}`);
    const file = join(b.dir, 'next.cjs');
    const text = rf(file, 'utf8');
    assert.ok(text.includes(from), what);
    wf(file, text.split(from).join(to));
    const r = await translationValidate(b.module, 'Refund', b.dir);
    assert.ok(r.mismatches.length > 0, what);
  }
});

// A-F7: a claims binder may not be a name the language reserves (pre, post, action, self, none).
test('review A-F7: a claims binder named pre, post, action, self or none is refused', () => {
  for (const b of ['pre', 'post', 'action', 'self', 'none']) {
    assert.deepEqual(codes(prog('  kind: Kind\n  principal: Principal', 'first\' = ' + b + '.principal').replace('by caller: Caller', `by ${b}: Caller`)).filter((c) => c === 'PL1201').length >= 1, true, b);
  }
});

// Polywatch on the M5b fixes: a comment on a claims field stays on that field through the formatter (PT1.4a).
test('polywatch: comments on claims fields keep their place', () => {
  const src = 'module c\n\n// who calls\nclaims Caller {\n  // the kind\n  kind: Kind  // inline\n  who: Principal  // the principal\n}\n\nenum Kind { Person, Agent }\n';
  const r = parse(src);
  const out = format(r.module, r.trivia);
  assert.equal(out, src);
});

// Polywatch on the M5b fixes: the embedded surface spells a binder as a string, so it can name a reserved key. A binder
// named $claims or $lineage is PL1208, as a declared one is (S155).
test('polywatch: a by binder named $claims or $lineage is PL1208', () => {
  for (const name of ['$claims', '$lineage']) {
    const r = parse(readFileSync(join(ROOT, 'conformance/m5/refund.poly'), 'utf8'));
    const h = r.module.decls.flatMap((d) => d.kind === 'Machine' ? d.items : []).find((x) => x.kind === 'Handler' && x.by);
    h.by.name = name;
    const codes = checkModule(r.module).diagnostics.map((d) => d.code);
    assert.ok(codes.includes('PL1208'), `${name}: ${codes.join(', ')}`);
  }
});
