// S67: an effects manifest's completion data may hold any constant of a finite type, encoded as a value of
// that type is encoded everywhere else; a field or a parameter is still not a constant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkFile, render } from '@poly/check';
import { ROOT, BUILD, build } from './helpers.mjs';

const FILE = join(ROOT, 'conformance', 'm2', 'completions.poly');
const SRC = readFileSync(FILE, 'utf8');
const codes = (src) => checkModule(parse(src).module).diagnostics.map((d) => d.code);

test('S67: a union with payloads and a record are completion data, encoded as values are everywhere else', async () => {
  assert.deepEqual(codes(SRC), []);
  const [b] = build(FILE, 'completions');
  const m = JSON.parse(readFileSync(join(b.dir, 'effects.manifest.json'), 'utf8')).effects.Ship;
  assert.deepEqual(m.onSuccess.data, { j: { $: 'Busy', n: 1 }, b: { n: 1 } });
  assert.deepEqual(m.onFailure.data, { j: { $: 'Idle' }, b: { n: 0 } });
  const r = await checkFile(FILE, { root: join(BUILD, 'completions-check') });
  assert.equal(r.verdict, 'CLEAN', render(r));
});

test('S67: a field or a parameter is still not a constant, and a constant outside its type is PL1201', () => {
  assert.deepEqual(codes(SRC.replace('b: { n: 1 })', 'b: { n: 3 })')), ['PL1201']);
  assert.deepEqual(codes(SRC.replace('ok -> Done(j: Busy { n: 1 }', 'ok -> Done(j: Busy { n: sent }')).length > 0, true);
  assert.deepEqual(codes(SRC.replace('b: { n: 1 })', 'b: { n: 1 }, j: Idle)')), ['PL1002']);
});
