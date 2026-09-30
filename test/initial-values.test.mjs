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
// Lowered from plan step 10 (maps of unions with payloads); until then the inside case is reported as todo, not passed.
const LOWERED_LATER = new Set(['nested union in a map']);

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

  test(`inside its type lowers and passes strict validate(): ${shape} (${inside})`, { todo: LOWERED_LATER.has(shape) ? 'lowered from plan step 10' : false }, () => {
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
