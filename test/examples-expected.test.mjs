// V10 item 4 (ruled 2026-10-10): each example's verdict equals the one its first line states. The serial group's
// examples (test/serial-sources.mjs) are compared in test/after/serial-sources.test.mjs instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { ROOT } from './helpers.mjs';
import { serial } from './serial-sources.mjs';
import { expectedOf, mismatch, exampleFiles, checkExample } from './examples-expected.mjs';

const FILES = exampleFiles(join(ROOT, 'examples'));
const OUT = join(ROOT, '.poly', 'test-build', 'examples-expected');

test('every file in examples/ states its expected verdict on its first line', () => {
  const without = FILES.filter((f) => expectedOf(f) === null).map((f) => relative(ROOT, f));
  assert.deepEqual(without, []);
  assert.ok(FILES.length >= 20, `${FILES.length} examples`);
});

for (const file of FILES.filter((f) => !serial(f))) {
  test(`the verdict is the one stated: ${relative(ROOT, file)}`, async () => {
    const expected = expectedOf(file);
    assert.ok(expected, 'the file states its expected verdict');
    const r = await checkExample(file, OUT, relative(ROOT, file).replace(/[^a-z0-9]+/gi, '-'));
    assert.equal(mismatch(expected, r), null);
  });
}
