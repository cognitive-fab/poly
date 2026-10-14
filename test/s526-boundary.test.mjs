// PT33.5b: the helper that forges an unsafe build (test/fixtures/s526/forge-unsafe-build.mjs) bypasses the checker on
// purpose, so nothing that ships may reach it. This extends the import-boundary checks of test/boundaries.test.mjs:
// no source or built file under packages/ or scripts/ imports a file under test/ or names the helper or its folder.
// These guards pass before the feature and must keep passing: they are CONTROLs, and their detectors are shown to
// detect (the last test) so that a green run means something.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const HELPER = join(ROOT, 'test', 'fixtures', 's526', 'forge-unsafe-build.mjs');
const NAMES_HELPER = (text) => /forge-unsafe-build|fixtures[\/]s526/.test(text);
const IMPORTS_TEST_DIR = (text) => /from\s+['"][^'"]*(\.\.[\/])+test[\/]/.test(text) || /require\(['"][^'"]*(\.\.[\/])+test[\/]/.test(text);

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const f = join(dir, name);
    if (statSync(f).isDirectory()) files(f, out);
    else if (/\.(ts|mts|js|mjs|cjs|json)$/.test(name)) out.push(f);
  }
  return out;
}
const offenders = (roots, pred) => roots.flatMap((r) => files(r)).filter((f) => pred(readFileSync(f, 'utf8'))).map((f) => f.slice(ROOT.length + 1));

test('CONTROL: PT33.5b: the forge helper exists, so the boundary below is about a real file', () => {
  assert.ok(existsSync(HELPER));
});

test('CONTROL: PT33.5b: nothing under packages/ or scripts/ names the forge helper or its folder', () => {
  assert.deepEqual(offenders([join(ROOT, 'packages'), join(ROOT, 'scripts')], NAMES_HELPER), []);
});

test('CONTROL: PT33.5b: nothing under packages/ imports a file under test/', () => {
  assert.deepEqual(offenders([join(ROOT, 'packages')], IMPORTS_TEST_DIR), []);
});

test('CONTROL: PT33.5b: the detectors detect (a green boundary is not an empty scan)', () => {
  assert.ok(NAMES_HELPER("import { forgeUnsafeBuild } from './forge-unsafe-build.mjs'"));
  assert.ok(NAMES_HELPER("const p = 'test/fixtures/s526/x'"));
  assert.ok(IMPORTS_TEST_DIR("import { x } from '../../../test/fixtures/s526/forge-unsafe-build.mjs'"));
  assert.ok(IMPORTS_TEST_DIR("const x = require('../../test/helpers.cjs')"));
  assert.ok(!IMPORTS_TEST_DIR("import { x } from './testing.js'"));
  assert.ok(files(join(ROOT, 'packages')).length > 50, 'the scan reads the packages');
});
