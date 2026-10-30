// PT14a, in the serial group: the heavy examples (test/serial-sources.mjs) give the same report cold, warm and with no
// cache. Their parallel sweep is test/check-cache.test.mjs.
import { test } from 'node:test';
import { join, relative } from 'node:path';
import { ROOT } from '../helpers.mjs';
import { exampleFiles } from '../examples-expected.mjs';
import { serial } from '../serial-sources.mjs';
import { sweep } from '../check-cache-helpers.mjs';

for (const file of exampleFiles(join(ROOT, 'examples')).filter(serial)) {
  test(`PT14a: cold, warm and with no cache, the same report: ${relative(ROOT, file)}`, { timeout: 3_600_000 }, () => sweep(file));
}
