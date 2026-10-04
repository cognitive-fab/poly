// M6 step 2: the workflow front end (PT10, S166). A `workflow w runs M { input A  key "…" where f matches "…"
// tool "kind" -> t target "…" why "…" }` block parses on the standalone surface, reads to the same AST on the embedded
// one, formats back to itself, and is checked: the input is a handled action of M (PL6801); the key's fields are
// parameters of that action, its patterns compile and every declared value of a field matches (PL6802); every effect
// kind of M maps to exactly one tool, and every mapped kind is an effect of M (PL6803).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, format } from '@poly/lang';
import { checkModule } from '@poly/core';
import { printModule, readEmbedded } from '@poly/embed';
import { ROOT } from './helpers.mjs';

const SRC = readFileSync(join(ROOT, 'conformance', 'm6', 'brief.poly'), 'utf8');
const codes = (src) => { const r = parse(src); assert.ok(r.module, JSON.stringify(r.diagnostics)); return [...r.diagnostics, ...checkModule(r.module).diagnostics].map((d) => d.code); };
const strip = (x) => JSON.stringify(x, (k, v) => (k === 'span' || k === 'id' ? undefined : v));

test('PT10: a workflow parses, with its machine, input, key and tools, and formats back to itself', () => {
  const r = parse(SRC);
  assert.deepEqual(r.diagnostics, []);
  const w = r.module.decls.find((d) => d.kind === 'Workflow');
  assert.equal(w.name, 'daily-brief');
  assert.equal(w.machine, 'Brief');
  assert.equal(w.input, 'Start');
  assert.equal(w.key.template, '{date}');
  assert.deepEqual(w.key.fields.map((f) => [f.name, f.pattern]), [['date', '^\\d{4}-\\d{2}-\\d{2}$']]);
  assert.deepEqual(w.tools.map((t) => [t.effect, t.tool, t.target, t.why]), [['brief.fetch', 'github_search_issues', null, 'gather the day\'s tickets'], ['brief.post', 'slack_send', '#cs', 'publish the brief']]);
  assert.equal(format(r.module, r.trivia), SRC);
  assert.deepEqual(codes(SRC), []);
});

test('PT10, PT2.5: the embedded surface reads a workflow to the same AST, and prints it back', () => {
  const m = parse(SRC).module;
  const ts = printModule(m);
  assert.match(ts, /workflow\("daily-brief"/);
  const back = readEmbedded(ts, 'brief.ts');
  assert.ok(back.module, JSON.stringify(back.diagnostics));
  assert.equal(strip(back.module), strip(m));
});

test('S166: the input is a handled action of the machine (PL6801), and the machine exists (PL1001)', () => {
  assert.ok(codes(SRC.replace('  input Start', '  input Begin')).includes('PL6801'));
  assert.ok(codes(SRC.replace('workflow daily-brief runs Brief', 'workflow daily-brief runs Nothing')).includes('PL1001'));
});

test('S166: the key names parameters of the input, its patterns compile, and every declared value matches (PL6802)', () => {
  assert.ok(codes(SRC.replace('key "{date}" where date', 'key "{day}" where day')).includes('PL6802'), 'a key field that is no parameter');
  assert.ok(codes(SRC.replace('key "{date}"', 'key "today"').replace(' where date matches "^\\\\d{4}-\\\\d{2}-\\\\d{2}$"', '')).includes('PL6802'), 'a template that names no field');
  assert.ok(codes(SRC.replace('"^\\\\d{4}-\\\\d{2}-\\\\d{2}$"', '"^(\\\\d{4}"')).includes('PL6802'), 'a pattern that does not compile');
  assert.ok(codes(SRC.replace('"2026-10-05"', '"tomorrow"')).includes('PL6802'), 'a declared value the pattern refuses');
  assert.ok(codes(SRC.replace('where date matches', 'where day matches')).includes('PL6802'), 'a where field the template does not name');
});

test('S166: every effect kind maps to exactly one tool, and every mapped kind is an effect (PL6803)', () => {
  assert.ok(codes(SRC.replace('  tool "brief.post" -> slack_send target "#cs" why "publish the brief"\n', '')).includes('PL6803'), 'an unmapped kind');
  assert.ok(codes(SRC.replace('tool "brief.post"', 'tool "brief.posted"')).includes('PL6803'), 'a kind that is no effect');
  assert.ok(codes(SRC.replace('  tool "brief.post" -> slack_send', '  tool "brief.fetch" -> ask why "again"\n  tool "brief.post" -> slack_send')).includes('PL6803'), 'a kind mapped twice');
});

test('S166: two workflows with one name are PL1002', () => {
  const w = SRC.slice(SRC.indexOf('workflow daily-brief'));
  assert.ok(codes(SRC + '\n' + w).includes('PL1002'));
});

// Polywatch on step 2: a key field over an integer range has its declared values tested against the pattern too.
test('S166: a key field over an integer range is tested against its pattern (PL6802)', () => {
  const src = SRC.replace('action Start(date: string check { "2026-10-04", "2026-10-05" })', 'action Start(date: 0..3)');
  const pattern = '"^\\\\d{4}-\\\\d{2}-\\\\d{2}$"';
  assert.ok(src.includes(pattern) && src !== SRC);
  assert.ok(codes(src.replace(pattern, '"^[a-z]+$"')).includes('PL6802'), 'a range the pattern refuses');
  assert.ok(!codes(src.replace(pattern, '"^[0-9]$"')).includes('PL6802'), 'a range the pattern accepts');
});
