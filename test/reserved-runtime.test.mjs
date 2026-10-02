// S143: runtime.* is reserved for the runtime's own OutboxIntent model (PT9.7), under PL1208 with outcome.* and
// decision.*. A program machine with such an id is refused by the checker, whatever bounds a build declares and
// whatever intents a store holds, so the same program never loads one day and is refused the next. The one module
// the checker takes under the name is PT9.7's model, at each bound the runtime registers, pinned by digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { checkModule, digest, RUNTIME_MODEL_DIGESTS } from '@poly/core';
import { modelSource, BOUNDS } from '@poly/runtime/model';
import { ROOT } from './helpers.mjs';

const codes = (text) => checkModule(parse(text).module).diagnostics.map((d) => d.code);
const COLLIDE = readFileSync(join(ROOT, 'test', 'fixtures', 'review-m4', 'collide.poly'), 'utf8');

test('S143: a program machine in module runtime is PL1208', () => {
  assert.ok(codes(COLLIDE).includes('PL1208'), codes(COLLIDE).join(' '));
});

test('S143: the modules of the runtime\'s other bounds (runtime<m>) are reserved too', () => {
  assert.ok(codes(COLLIDE.replace('module runtime\n', 'module runtime5\n')).includes('PL1208'));
  assert.ok(!codes(COLLIDE.replace('module runtime\n', 'module runtimes\n')).includes('PL1208'));
});

test('S143: PT9.7\'s model at every bound is the runtime\'s own, and is not refused; the pinned digests are its digests', () => {
  for (const m of BOUNDS) assert.ok(!codes(modelSource(m)).includes('PL1208'), `bound ${m}`);
  assert.deepEqual([...RUNTIME_MODEL_DIGESTS].sort(), BOUNDS.map((m) => digest(parse(modelSource(m)).module)).sort());
  // One changed range is a program, not the model.
  assert.ok(codes(modelSource(3).replace('Allowed   { attempts: 0..2 }', 'Allowed   { attempts: 0..1 }')).includes('PL1208'));
});

test('S143: no conformance or evidence source is written in a reserved module any more', () => {
  for (const f of ['conformance/m2/seeded/liveness/unfixed.poly', 'conformance/m2/seeded/liveness/fixed.poly', 'examples/evidence/outbox-v02.poly', 'examples/evidence/outbox-v03.poly', 'examples/evidence/outbox-union.poly', 'examples/evidence/outbox-union-escape.poly', 'test/fixtures/cli/escape.poly']) {
    assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), /^module runtime\d*\s*$/m, f);
  }
});
