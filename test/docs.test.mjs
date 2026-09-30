// The specifications are the source of truth, so an edit that damages one is a defect. db71051 applied a
// replacement whose text held "$`", which JavaScript's String.replace expands to everything before the match:
// PT2.5's table swallowed a second copy of the document's first 130 lines. These checks catch that shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { ROOT } from './helpers.mjs';

const DOCS = join(ROOT, 'docs');
const files = [...readdirSync(DOCS).filter((f) => f.endsWith('.md')).map((f) => join(DOCS, f)), ...readdirSync(join(DOCS, 'proposals')).filter((f) => f.endsWith('.md')).map((f) => join(DOCS, 'proposals', f))];

for (const f of files) {
  test(`${f.slice(ROOT.length + 1)}: its title and its byline appear once`, () => {
    const lines = readFileSync(f, 'utf8').split('\n');
    const title = lines[0].replace(/^# /, '');
    const text = lines.join('\n');
    assert.equal(text.split(title).length - 1, 1, `the title "${title}" appears more than once`);
    const byline = lines.find((l) => l.startsWith('*Cognitive Fab'));
    if (byline) assert.equal(text.split(byline).length - 1, 1, 'the byline appears more than once');
  });
}

test('PT2.5: every row of the embedded mapping table is one line', () => {
  const lines = readFileSync(join(DOCS, '03-technical-spec.md'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('  | AST node | Embedded form |'));
  assert.ok(start > 0);
  for (let i = start; lines[i].trim() !== ''; i++) assert.match(lines[i], /^ {2}\|.*\|$/, `line ${i + 1} is not a table row`);
});
