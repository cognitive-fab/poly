// S459 (c), as ruled on 2026-10-09: the examples' checks resolve `use`, provider profiles and route files as
// `poly check` does, from std/ and beside the source. This replaces the check in packages/poly-lang/test, which read
// each example with checkModule alone and so could not check one that uses a credential, a route or a channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT, TEST_STD, polyFiles, load, stdFor } from './helpers.mjs';

test('S459 (c): a source under examples/ resolves from std/, any other from the tests\' own std', () => {
  assert.equal(stdFor(join(ROOT, 'examples', 'hello', 'hello.poly')), join(ROOT, 'std'));
  assert.equal(stdFor(join(ROOT, 'conformance', 'm0', 'strict-param.poly')), TEST_STD);
  assert.equal(stdFor(join(ROOT, 'test', 'fixtures', 'cut-ranges', 'refunds.poly')), TEST_STD);
  // A directory whose name only begins with examples is not under it.
  assert.equal(stdFor(join(ROOT, 'examples-old', 'x.poly')), TEST_STD);
});

test('every example checks with no diagnostic, liveness included (M1-2, S459)', () => {
  // load throws on any diagnostic of the parse, the uses, the expansions or the check.
  for (const f of polyFiles(join(ROOT, 'examples'))) assert.doesNotThrow(() => load(f), f);
});
