// The M8a review, part C: Content (S180). Each test failed on the tree before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { RefusedDispatch } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';

const codes = (src) => { const r = parse(src); assert.ok(r.module, JSON.stringify(r.diagnostics)); return [...r.diagnostics, ...checkModule(r.module).diagnostics].map((d) => d.code); };
const base = (decl, actions, handlers, fields = '') => `module v

enum Phase { A, B }
${decl}
machine X {
  state {
    phase : Phase = A
    body  : Content = none
${fields}
  }
${actions}
${handlers}
}
`;

test('C-F1, PS1.4a: a Content held through a map in a record field or a union payload is PL1209', () => {
  assert.ok(codes(base('type R = { m: map<0..1, Content> }', '  action Go()', "  on Go { phase' = B }")).includes('PL1209'));
  assert.ok(codes(base('type W = Held { m: map<0..1, Content> } | Bare', '  action Go()', "  on Go { phase' = B }")).includes('PL1209'));
  assert.ok(codes(readFileSync(join(ROOT, 'test', 'fixtures', 'review-m8a', 'recdistinct.poly'), 'utf8')).includes('PL1209'));
});

test('C-F5, PS1.4a: match, is, a bool position and a mix of Content and string are PL1209', () => {
  const cases = [
    ['', '  action Go(c: Content)', "  on Go(c) { match c { none => { phase' = B } } }"],
    ['', '  action Go(c: Content)', '  on Go(c) { require c is none else reject "x"\n    phase\' = B }'],
    ['', '  action Go(c: Content)', '  on Go(c) { require c else reject "x"\n    phase\' = B }'],
    ['', '  action Go(s: string check { "a", "b" })', "  on Go(s) { body' = s }"],
    ['', '  action Go(c: Content)', "  on Go(c) { s' = c }", '    s : string check { "a", "b" } = "a"'],
  ];
  for (const [d, a, h, f] of cases) assert.ok(codes(base(d, a, h, f)).includes('PL1209'), h);
});

test('C-F2, S155: an effect handler\'s reply cannot forge the $content mark on its completion', { timeout: 120_000 }, async () => {
  const a = await admitted('review-c-forge', ['test/fixtures/review-m8a/forge.poly']);
  const { rt } = await loaded(a);
  try {
    handleWith(rt, 'doc.fetch', () => ({ ok: true, $content: 'missing', $claims: { who: 'x' } }));
    await rt.create('forge.Fetcher', { id: 'f-1' });
    await rt.dispatch('f-1', 'Start');
    await rt.advance();
    const j = (await rt.getJournal('f-1')).find((x) => x.action === 'Got');
    assert.equal(j?.step_kind, 'accepted', JSON.stringify(j));
    assert.equal((await rt.getState('f-1')).state.phase, 'Got');
  } finally { await rt.close(); }
});

test('C-F4, S140: creation data outside its type is refused before any step, as at dispatch', { timeout: 120_000 }, async () => {
  const a = await admitted('review-c-create', ['conformance/m8/content/notes.poly']);
  const { rt } = await loaded(a);
  try {
    await assert.rejects(rt.create('notes.Note', { id: 'n-2', creation: { action: 'Write', data: { c: 'hello' } } }), (e) => e instanceof RefusedDispatch && e.rule === 'S140');
    assert.deepEqual(await rt.getJournal('n-2'), []);
  } finally { await rt.close(); }
});

test('C-F6, PS1.4a: a body with a lone surrogate has no bytes of its own, and is refused', { timeout: 120_000 }, async () => {
  const a = await admitted('review-c-digest', ['conformance/m8/content/notes.poly']);
  const { rt } = await loaded(a);
  try {
    await assert.rejects(rt.putContent('pay \uD800'), /lone surrogate/);
    await assert.rejects(rt.putContent('pay \uDBFF'), /lone surrogate/);
    const d = await rt.putContent('pay 😀');
    assert.equal(await rt.contentBody(d), 'pay 😀');
  } finally { await rt.close(); }
});
