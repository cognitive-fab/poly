// S180 (M8a step 4): Content (PS1.4a, PS4.1f). An opaque body reference, or none: stored, passed and compared for
// equality, and nothing else (PL1209); no constant but none. Check explores it by representatives under PS4.1c's rule
// applied separately, and the instance prints the count. At run time a Content names a body in the content store, and
// one that names no body is rejected before the module, content-missing: journaled, the state unchanged, whether it
// arrives by dispatch, at creation or as an effect's completion. No model runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkFile } from '@poly/check';
import { RefusedDispatch } from '@poly/runtime';
import { ROOT, build } from './helpers.mjs';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';

const NOTES = readFileSync(join(ROOT, 'conformance', 'm8', 'content', 'notes.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-content');
const codes = (src) => { const r = parse(src); assert.ok(r.module, JSON.stringify(r.diagnostics)); return [...r.diagnostics, ...checkModule(r.module).diagnostics].map((d) => d.code); };
const swap = (from, to) => { assert.ok(NOTES.includes(from), from); return NOTES.replace(from, to); };
const readdirText = (d) => readdirSync(d).map((e) => join(d, e)).map((p) => (statSync(p).isDirectory() ? readdirText(p) : readFileSync(p, 'utf8'))).join('\n');
const MISSING = `sha256:${'0'.repeat(64)}`;

test('PS1.4a, PS4.1f: Content is checked by representatives, and the instance prints their count', { timeout: 120_000 }, async () => {
  const r = await checkFile(join(ROOT, 'conformance', 'm8', 'content', 'notes.poly'), { root: OUT });
  assert.equal(r.verdict, 'CLEAN', JSON.stringify(r.machines.flatMap((m) => m.diagnostics.map((d) => d.message))));
  assert.ok(r.machines[0].instance.domains.some((d) => /^2 content representatives/.test(d)), JSON.stringify(r.machines[0].instance.domains));
});

test('PS1.4a: a digest written in source is PL1209: the only constant of type Content is none', () => {
  assert.ok(codes(swap("body' = c", "body' = \"sha256:abc\"")).includes('PL1209'));
  assert.ok(codes(swap("same' = c == body", "same' = c == \"sha256:abc\"")).includes('PL1209'));
});

test('PS1.4a: an order, arithmetic, a comparison with a string, a map key, a record field and a check domain on Content are PL1209', () => {
  for (const [from, to] of [
    ["same' = c == body", "same' = c < body"],
    ["same' = c == body", "same' = c + 1 == 2"],
    ['body  : Content = none', 'body  : Content = none\n    seen  : map<Content, bool> = {}'],
    ['enum Phase { Empty, Holding, Compared }', 'enum Phase { Empty, Holding, Compared }\n\ntype Pair = { a: Content, b: bool }'],
    ['action Write(c: Content)', 'action Write(c: Content check { none })'],
    ['enum Phase { Empty, Holding, Compared }', 'enum Phase { Empty, Holding, Compared }\n\ntype Wrap = Held { c: Content } | Bare'],
  ]) assert.ok(codes(swap(from, to)).includes('PL1209'), to);
  assert.deepEqual(codes(NOTES), []);
});

test('PS3.2, PL1207: content-missing is a reserved reason no handler may use', () => {
  assert.ok(codes(swap('reject "no-body"', 'reject "content-missing"')).includes('PL1207'));
});

test('PS4.1f: two Content values compared for equality are explored with two representatives, so a property that fails only when they differ is found', { timeout: 120_000 }, async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const dir = join(OUT, 'two');
  mkdirSync(dir, { recursive: true });
  const src = swap('    require phase is Holding else reject "empty"\n', '    require phase is Holding else reject "empty"\n    require c != none else reject "no-body"\n')
    .replace('  invariant held-when-holding', '  step property always-same: action == Compare implies post.same\n  invariant held-when-holding');
  writeFileSync(join(dir, 'notes.poly'), src);
  const r = await checkFile(join(dir, 'notes.poly'), { root: dir });
  assert.equal(r.verdict, 'FINDINGS', JSON.stringify(r.machines.flatMap((m) => m.diagnostics.map((d) => d.message))));
  assert.ok(r.machines[0].diagnostics.some((d) => /always-same/.test(d.message)));
});

test('PS3.2, S180: at run time a Content names a body in the store; one that names none is rejected before the module, content-missing, journaled, the state unchanged', { timeout: 120_000 }, async () => {
  const a = await admitted('content-runtime', ['conformance/m8/content/notes.poly']);
  const { rt } = await loaded(a);
  try {
    const d = await rt.putContent('a customer message');
    assert.match(d, /^sha256:[0-9a-f]{64}$/);
    assert.equal(await rt.contentBody(d), 'a customer message');
    await rt.create('notes.Note', { id: 'n-1' });
    const missing = await rt.dispatch('n-1', 'Write', { c: MISSING });
    assert.deepEqual([missing.stepKind, missing.rejectReason], ['rejected', 'content-missing']);
    assert.equal((await rt.getState('n-1')).state.phase, 'Empty');
    const journal = await rt.getJournal('n-1');
    assert.ok(journal.some((j) => j.action === 'Write' && j.step_kind === 'rejected' && j.reject_reason === 'content-missing'), 'the step is journaled');
    assert.equal((await rt.dispatch('n-1', 'Write', { c: d })).stepKind, 'accepted');
    assert.equal((await rt.getState('n-1')).state.body, d);
    // Not a digest at all: outside the type, refused before any step (S140).
    await assert.rejects(rt.dispatch('n-1', 'Compare', { c: 'hello' }), (e) => e instanceof RefusedDispatch && e.rule === 'S140');
    // The marker is the runtime's; a caller that supplies it is refused (S155).
    await assert.rejects(rt.dispatch('n-1', 'Compare', { c: d, $content: 'missing' }), (e) => e instanceof RefusedDispatch && e.rule === 'S155');
    // polywatch muva0r1v-3c89f81a finding 2: creation refuses the marker as dispatch does.
    await assert.rejects(rt.create('notes.Note', { id: 'n-2', creation: { action: 'Write', data: { c: d, $content: 'missing' } } }), (e) => e instanceof RefusedDispatch && e.rule === 'S155' && /\$content/.test(e.message));
    assert.equal((await rt.dispatch('n-1', 'Compare', { c: d })).stepKind, 'accepted');
    assert.equal((await rt.getState('n-1')).state.same, true);
  } finally { await rt.close(); }
});

test('PS3.2, S180: an effect\'s completion that names no body is rejected before the module too', { timeout: 120_000 }, async () => {
  const a = await admitted('content-completion', ['conformance/m8/content/fetch.poly']);
  const { rt } = await loaded(a);
  try {
    handleWith(rt, 'doc.fetch', () => ({ body: MISSING }));
    await rt.create('fetch.Fetcher', { id: 'f-1' });
    await rt.dispatch('f-1', 'Start');
    await rt.advance();
    const j = (await rt.getJournal('f-1')).find((x) => x.action === 'Got');
    assert.deepEqual([j?.step_kind, j?.reject_reason], ['rejected', 'content-missing']);
    assert.equal((await rt.getState('f-1')).state.phase, 'Waiting');
  } finally { await rt.close(); }
});

test('polywatch muva0r1v-3c89f81a finding 1: a module that declares its own Content lowers no content-missing row and no $content key', () => {
  const dir = join(OUT, 'shadow');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'shadow.poly');
  writeFileSync(f, ['module shadow', '', 'enum Content { A, B }', '', 'machine S {', '  state { c : Content = A }', '  action Set(v: Content)', "  on Set(v) { c' = v }", '}', ''].join('\n'));
  const [{ dir: out }] = build(f, 'content-shadow');
  const text = readdirText(out);
  assert.ok(!text.includes('content-missing'), 'no content-missing row');
  assert.ok(!text.includes('$content'), 'no $content key');
});

test('PS3.2 (S180 ruling): an action with no handler is unhandled whatever its data, a missing body included', async () => {
  const { buildMachine, transition, initialState } = await import('@poly/ref');
  const r = parse(readFileSync(join(ROOT, 'conformance', 'm8', 'content', 'unhandled.poly'), 'utf8'));
  const M = buildMachine(r.module, 'Shelf');
  const s = initialState(M);
  const c = `sha256:${'0'.repeat(63)}1`;
  assert.equal(transition(M, s, 'Peek', { c, $content: 'missing' }).verdict.kind, 'unhandled');
  assert.equal(transition(M, s, 'Peek', { c }).verdict.kind, 'unhandled');
  assert.deepEqual(transition(M, s, 'Keep', { c, $content: 'missing' }).verdict, { kind: 'rejected', reason: 'content-missing' });
});

test('PS3.2, PS9.1a: translation validation probes the content row on an action with no handler, and the source is CLEAN', { timeout: 120_000 }, async () => {
  const r = await checkFile(join(ROOT, 'conformance', 'm8', 'content', 'unhandled.poly'), { root: join(OUT, 'unhandled') });
  assert.equal(r.verdict, 'CLEAN', JSON.stringify(r.machines.flatMap((m) => m.diagnostics.map((d) => `${d.code} ${d.message}`))));
});

test('PS3.2 (S180 ruling): at run time an action with no handler is unhandled with a missing body too, as in poly-ref', { timeout: 120_000 }, async () => {
  const a = await admitted('content-unhandled', ['conformance/m8/content/unhandled.poly']);
  const { rt } = await loaded(a);
  try {
    await rt.create('unhandled.Shelf', { id: 's-1' });
    assert.equal((await rt.dispatch('s-1', 'Peek', { c: MISSING })).stepKind, 'unhandled');
    assert.deepEqual(await rt.dispatch('s-1', 'Keep', { c: MISSING }).then((x) => [x.stepKind, x.rejectReason]), ['rejected', 'content-missing']);
    assert.equal((await rt.getState('s-1')).state.phase, 'Open');
  } finally { await rt.close(); }
});

test('PS3.2 (polywatch muvf62zx-3c89f81a): the content row comes before the guards, so a missing body is content-missing where a guard would reject', { timeout: 120_000 }, async () => {
  const r = await checkFile(join(ROOT, 'conformance', 'm8', 'content', 'guarded.poly'), { root: join(OUT, 'guarded') });
  assert.equal(r.verdict, 'CLEAN', JSON.stringify(r.machines.flatMap((m) => m.diagnostics.map((d) => `${d.code} ${d.message}`))));
});
