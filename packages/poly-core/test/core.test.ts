import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize, digest, assignIds, triAnd, triOr, triNot, ruleOutcome, fold, verdictOf, diag, EXIT_CODES,
  type Tri,
} from '../src/index.js';

test('RFC 8785 §3.2.2: the example document canonicalises as the RFC prints it', () => {
  const input = JSON.parse(
    '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
      '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
  );
  assert.equal(
    canonicalize(input),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  );
});

test('RFC 8785 §3.2.3: keys sort by UTF-16 code units', () => {
  const obj: Record<string, string> = {};
  for (const k of ['€', '\r', 'דּ', '1', '😀', '\u0080', 'ö']) obj[k] = k;
  // Read the order off the text: Object.keys would put the integer-like key first.
  const text = canonicalize(obj);
  const order = ['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ'].map((k) => text.indexOf(JSON.stringify(k) + ':'));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((i) => i >= 0));
});

test('RFC 8785: values JSON cannot carry are refused, not digested', () => {
  assert.throws(() => canonicalize(Number.NaN));
  assert.throws(() => canonicalize(Infinity));
  assert.throws(() => canonicalize(() => 1));
});

test('the digest ignores ids and spans (PT1.4a)', () => {
  const a = { kind: 'Int', value: 1, id: 'n:1', span: { line: 1, col: 1, endLine: 1, endCol: 2 } };
  const b = { kind: 'Int', value: 1, id: 'n:2' };
  assert.equal(digest(a), digest(b));
  assert.notEqual(digest(a), digest({ kind: 'Int', value: 2 }));
});

test('ids derive from names where the grammar names things, and stay unique', () => {
  const m = {
    kind: 'Module', name: 'm', decls: [
      { kind: 'Machine', name: 'A', fields: [{ kind: 'Field', name: 'x' }], items: [] },
      { kind: 'Machine', name: 'A', fields: [], items: [] },
    ],
  };
  const paths = assignIds(m);
  const all = [...paths.values()];
  assert.ok(all.includes('module:m/machine:A/field:x'));
  assert.ok(all.includes('module:m/machine:A#1'));
  assert.equal(new Set(paths.keys()).size, paths.size);
});

test('Kleene strong logic (PS8.1)', () => {
  const V: Tri[] = ['T', 'F', 'U'];
  const and: Record<string, Tri> = { TT: 'T', TF: 'F', TU: 'U', FT: 'F', FF: 'F', FU: 'F', UT: 'U', UF: 'F', UU: 'U' };
  const or: Record<string, Tri> = { TT: 'T', TF: 'T', TU: 'T', FT: 'T', FF: 'F', FU: 'U', UT: 'T', UF: 'U', UU: 'U' };
  for (const a of V) for (const b of V) {
    assert.equal(triAnd(a, b), and[a + b], `${a} and ${b}`);
    assert.equal(triOr(a, b), or[a + b], `${a} or ${b}`);
  }
  assert.deepEqual(V.map(triNot), ['F', 'T', 'U']);
});

test('the rule table of PS8.2, with its defaults for an unknown condition', () => {
  assert.equal(ruleOutcome('F', 'F', 'deny'), 'not-applicable');
  assert.equal(ruleOutcome('T', 'T', 'deny'), 'satisfied');
  assert.equal(ruleOutcome('T', 'U', 'deny'), 'deny'); // an unknown never satisfies
  assert.equal(ruleOutcome('U', 'T', 'deny'), 'escalate'); // a deny rule never passes silently
  assert.equal(ruleOutcome('U', 'T', 'warn'), 'warn');
  assert.equal(ruleOutcome('U', 'T', 'deny', 'skip'), 'skip');
});

test('the verdict fold and the exit codes (02 §5, PT12.3)', () => {
  assert.equal(fold([]), 'CLEAN');
  assert.equal(fold(['CLEAN', 'INCONCLUSIVE', 'FINDINGS']), 'FINDINGS'); // S5: a finding inside the bound
  assert.equal(fold(['FINDINGS', 'REFUSED']), 'REFUSED');
  assert.equal(verdictOf([diag('PL3901', {}, 'bound')]), 'INCONCLUSIVE');
  assert.equal(verdictOf([diag('PL3901', {}, 'bound'), diag('PL3001', {}, 'inv')]), 'FINDINGS');
  assert.deepEqual([EXIT_CODES.CLEAN, EXIT_CODES.FINDINGS, EXIT_CODES.REFUSED, EXIT_CODES.INCONCLUSIVE, EXIT_CODES.USAGE], [0, 1, 2, 2, 64]);
  assert.throws(() => diag('PL9999', {}, 'no such code'));
});
