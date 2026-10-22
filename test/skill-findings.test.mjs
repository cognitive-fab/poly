// v1.3.1 documentation: adapters/claude-code/skills/poly/findings.md is generated from the diagnostics table (CODES) by
// scripts/make-skill-findings.mjs. This test fails when the table and the file disagree: a code added to the table with
// no note or no row, a row for a code the table no longer has, a name, severity or stage that differs, or a file edited
// by hand. The fix is to write the note and run `node scripts/make-skill-findings.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CODES } from '@poly/core';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { NOTES_FILE, OUT_FILE, OUTSIDE_TABLE, disagreement, render } from '../scripts/make-skill-findings.mjs';

// The dashes are built from their code points, so this file holds none itself.
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');

const notes = JSON.parse(readFileSync(NOTES_FILE, 'utf8'));
const file = readFileSync(OUT_FILE, 'utf8').replace(/\r\n/g, '\n');

test('every code of the diagnostics table has a note, and every note has a code', () => {
  assert.deepEqual(disagreement(CODES, notes), { missingNotes: [], unknownNotes: [] });
  for (const [code, n] of Object.entries(notes)) {
    for (const k of ['meaning', 'fix']) {
      assert.equal(typeof n[k], 'string', `${code}.${k}`);
      assert.ok(n[k].length >= 10, `${code}.${k} is empty`);
      assert.ok(!/UNGROUNDED/.test(n[k]), `${code}.${k} is not grounded`);
      assert.ok(!DASHES.test(n[k]), `${code}.${k} holds a dash`);
    }
  }
});

test('findings.md has one row for each code of the table, with the table\'s name, severity and stage', () => {
  const rows = [...file.matchAll(/^\| `(PL\d{4})` \| `([A-Z0-9_]+)` \| ([a-z]+), ([a-z-]+) \|/gm)].map((m) => ({ code: m[1], name: m[2], severity: m[3], stage: m[4] }));
  assert.deepEqual(rows.map((r) => r.code), Object.keys(CODES).sort(), 'the rows are the codes of the table, sorted');
  for (const r of rows) assert.deepEqual({ name: r.name, severity: r.severity, stage: r.stage }, { name: CODES[r.code].name, severity: CODES[r.code].severity, stage: CODES[r.code].stage }, r.code);
});

test('findings.md is exactly what the generator writes from the table and the notes', () => {
  assert.equal(file, render(CODES, notes), 'findings.md is stale: run node scripts/make-skill-findings.mjs');
});

test('the generator refuses a table and notes that disagree', () => {
  const extra = { ...CODES, PL0999: { name: 'INVENTED', stage: 'parse', severity: 'error' } };
  assert.throws(() => render(extra, notes), /missing PL0999/);
  const { PL0001: _drop, ...fewer } = notes;
  assert.throws(() => render(CODES, fewer), /missing PL0001/);
  assert.throws(() => render(CODES, { ...notes, PL0998: { meaning: 'x', fix: 'y' } }), /unknown PL0998/);
  const renamed = { ...CODES, PL0001: { ...CODES.PL0001, name: 'RENAMED' } };
  assert.notEqual(render(renamed, notes), file, 'a renamed code changes the file');
});

test('the codes the runtime raises outside the table are listed apart, and are not in the table', () => {
  assert.deepEqual(Object.keys(OUTSIDE_TABLE).sort(), ['PL6411', 'PL6412']);
  for (const [code, o] of Object.entries(OUTSIDE_TABLE)) {
    assert.ok(!(code in CODES), `${code} is in CODES now: drop it from OUTSIDE_TABLE`);
    assert.ok(file.includes(`| \`${code}\` | \`${o.name}\` |`), `${code} is not in findings.md`);
    assert.ok(readFileSync(join(ROOT, 'packages', 'poly-runtime', 'src', code === 'PL6411' ? 'runtime.ts' : 'capabilities.ts'), 'utf8').includes(`${code} ${o.name}`), `the runtime no longer raises ${code} ${o.name}`);
  }
});
