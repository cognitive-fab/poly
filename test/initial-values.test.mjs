// Decision M1-4: a generated test over every initial-value shape. For each
// shape, one value inside its type and one outside. The outside value must be
// PL1201 at its own line; the inside value must lower and pass strict
// validate(). Two of the follow-up defects after the M0 review were initial
// values the finding 3 fix should have caught; this closes the class.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { ROOT, build, requireModule } from './helpers.mjs';

const TYPES = `enum Door { Open, Shut }
enum Tone { Loud, Soft }
type Job = Idle | Busy { n: 0..3 }
`;

// [shape, field type, value inside, value outside]
const SHAPES = [
  ['range', '0..3', '2', '5'],
  ['range, negative literal', '-2..3', '-2', '-3'],
  ['range, folded arithmetic', '0..3', '1 + 2', '2 * 2'],
  ['int with a check range', 'int check 0..3', '1', '7'],
  ['int with a check set', 'int check { 10, 20 }', '20', '15'],
  ['string with a check set', 'string check { "a", "b" }', '"a"', '"c"'],
  ['enum', 'Door', 'Open', 'Loud'],
  ['enum, qualified', 'Door', 'Door.Shut', 'Tone.Soft'],
  ['union without payload', 'Job', 'Idle', 'Soft'],
  ['union with payload', 'Job', 'Busy { n: 3 }', 'Busy { n: 4 }'],
  ['union with payload, qualified', 'Job', 'Job.Busy { n: 0 }', 'Job.Busy { n: -1 }'],
  ['map key, range', 'map<0..1, 0..3>', '{ 0: 1, 1: 2 }', '{ 0: 1, 1: 2, 2: 0 }'],
  ['map key, enum', 'map<Door, 0..3>', '{ Open: 1, Shut: 2 }', '{ Open: 1, Loud: 2 }'],
  ['map value, array', 'map<0..1, 0..3>', '[1, 2]', '[1, 9]'],
  ['map value, enum keys', 'map<Door, 0..3>', '{ Open: 1, Shut: 3 }', '{ Open: 1, Shut: 4 }'],
  ['nested union in a map', 'map<0..1, Job>', '[Idle, Busy { n: 1 }]', '[Idle, Busy { n: 9 }]'],
];
const source = (type, value) => `module gen
${TYPES}
machine M {
  state {
    k : 0..1 = 0
    x : ${type} = ${value}
  }
  action Go()
  on Go {
    require k < 1 else reject "done"
    k' = 1
  }
}
`;

test('the generator covers every shape M1-4 lists', () => {
  const names = SHAPES.map(([s]) => s).join(' | ');
  for (const needed of ['range', 'union without payload', 'union with payload', 'map key', 'map value', 'nested union in a map']) {
    assert.ok(names.includes(needed), needed);
  }
});

for (const [shape, type, inside, outside] of SHAPES) {
  test(`outside its type is PL1201 at its line: ${shape} (${outside})`, () => {
    const src = source(type, outside);
    const FIELD_LINE = src.split('\n').findIndex((l) => l.trim().startsWith('x :')) + 1;
    const p = parse(src);
    assert.ok(p.module, JSON.stringify(p.diagnostics));
    const d = checkModule(p.module).diagnostics;
    assert.ok(d.length > 0 && d.every((x) => x.code === 'PL1201' && x.at.line === FIELD_LINE), JSON.stringify(d.map((x) => [x.code, x.at.line, x.message])));
  });

  test(`inside its type lowers and passes strict validate(): ${shape} (${inside})`, () => {
    const dir = join(ROOT, '.poly', 'test-build', 'initial-values');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${shape.replace(/[^a-z]+/g, '-')}.poly`);
    writeFileSync(file, source(type, inside));
    const [b] = build(file, 'initial-values');
    const mod = requireModule(b.dir);
    assert.deepEqual(mod.instance({}).validate(), []);
    mod.init();
    assert.deepEqual(mod.getState(), b.lowered.contract.initState);
  });
}

test('polywatch: an unknown or non-constant map-literal key gets one diagnostic', () => {
  const src = (lit) => `module gen\n${TYPES}\nmachine M {\n  state {\n    k : 0..1 = 0\n    x : map<Door, 0..3> = ${lit}\n  }\n  action Go()\n  on Go {\n    require k < 1 else reject "done"\n    k' = 1\n  }\n}\n`;
  const codes = (lit) => checkModule(parse(src(lit)).module).diagnostics.map((d) => d.code);
  assert.deepEqual(codes('{ Open: 1, Ajar: 2 }'), ['PL1001']);
  assert.deepEqual(codes('{ Open: 1, k: 2 }'), ['PL1001']);
});

test('polywatch: a map-literal key that is not a constant gets one diagnostic, not a missing or a duplicate key', () => {
  // PT2.2: a map literal lists every key exactly once, which is decidable only when each key is a constant.
  const src = (lit) => `module gen\nmachine M {\n  state {\n    k : 0..1 = 0\n    x : map<0..1, 0..3> = { 0: 0, 1: 0 }\n  }\n  action Go()\n  on Go {\n    require k < 1 else reject "done"\n    k' = 1\n    x' = ${lit}\n  }\n}\n`;
  const diags = (lit) => checkModule(parse(src(lit)).module).diagnostics.map((d) => [d.code, d.message]);
  const one = diags('{ 0: 1, pre.k: 2 }');
  assert.equal(one.length, 1, JSON.stringify(one));
  assert.equal(one[0][0], 'PL1502');
  assert.match(one[0][1], /not a constant/);
  const two = diags('{ pre.k: 1, 1 - pre.k: 2 }');
  assert.deepEqual(two.map(([c]) => c), ['PL1502', 'PL1502'], JSON.stringify(two));
  assert.ok(two.every(([, m]) => /not a constant/.test(m)), JSON.stringify(two));
  assert.deepEqual(diags('{ 0 + 0: 1, 1: 2 }'), []);
});
