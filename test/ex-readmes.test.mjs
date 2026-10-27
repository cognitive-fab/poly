// The README of each new example (docs/examples/*.md): the sections the owner asked for, house style, and the files
// and commands it names. A README that names a file that does not exist, or ends without a glossary, fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const names = readdirSync(join(ROOT, 'docs', 'examples')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).filter((n) => existsSync(join(ROOT, 'examples', n, 'README.md')));

test('at least one new example has a README to check', () => assert.ok(names.length > 0));

for (const name of names) {
  const text = readFileSync(join(ROOT, 'examples', name, 'README.md'), 'utf8');
  test(`${name}: the README has its sections, ends with a glossary, and follows house style`, () => {
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    for (const h of ['What it shows', 'Run it', 'What is checked', 'What is not checked', 'Conclusion', 'Glossary']) assert.ok(headings.includes(h), `${h} in ${headings.join(', ')}`);
    assert.equal(headings.at(-1), 'Glossary');
    assert.ok(headings.indexOf('Conclusion') < headings.indexOf('Glossary'));
    assert.ok(!text.includes('—') && !text.includes('–'), 'no em or en dashes');
    assert.ok(!/\bhonest/i.test(text), 'no "honest"');
  });
  test(`${name}: every file and test the README names exists`, () => {
    for (const m of text.matchAll(/(?<![\w/])(?:examples\/[\w./-]+|test\/[\w./-]+\.mjs)/g)) {
      const p = m[0].replace(/[.,;:)]+$/, '');
      assert.ok(existsSync(join(ROOT, p)), `${p} named in the README`);
    }
  });
}
