// S190 (ruled before M8b): enums across modules (PS1.0). An enum is m.E; use m admits m's enums and use m.E that one
// alone; a member is m.E.C, or bare where the expected type fixes the enum; ==, != and match work on it, with match
// covering every member. Records, unions with payloads and maps of another module's types stay PL0901. The build and
// the certificate record the digest of each module whose types they use, and a mismatch at load is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit, checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { loaded, makeKey, project } from './runtime-helpers.mjs';

const DIR = join(ROOT, 'conformance', 'm8', 'enums');
const KINDS = readFileSync(join(DIR, 'kinds.poly'), 'utf8');
const CHAT = readFileSync(join(DIR, 'chat.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-enums-across');
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
let n = 0;
async function pair(chat, kinds = KINDS) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'kinds.poly'), kinds);
  writeFileSync(join(d, 'chat.poly'), chat);
  return checkFile(join(d, 'chat.poly'), { root: d });
}
const codes = (r) => all(r).map((d) => d.code);

test('PS1.0, S190: another module\'s enum in a field, a parameter, a payload and a message; ==, != and a covering match', { timeout: 120_000 }, async () => {
  const r = await checkFile(join(DIR, 'chat.poly'), { root: join(OUT, 'chat') });
  assert.equal(r.verdict, 'CLEAN', text(r));
});

test('S190: two enums with the same members in different modules are different types (PL1201)', { timeout: 120_000 }, async () => {
  const own = swap(CHAT, 'service machine Chat {', 'enum Kind { FreeForm, Templated }\n\nservice machine Chat {');
  const r = await pair(swap(own, '    kind : kinds.Kind = kinds.Kind.Templated\n', '    kind : kinds.Kind = kinds.Kind.Templated\n    mine : Kind = Templated\n').replace("    kind' = k\n", "    kind' = k\n    mine' = k\n"));
  assert.ok(codes(r).includes('PL1201'), text(r));
});

test('S190: use kinds.Kind admits kinds.Kind and nothing else of kinds; use kinds admits every enum', { timeout: 120_000 }, async () => {
  const tone = swap(CHAT, '    sent : 0..2 = 0\n', '    sent : 0..2 = 0\n    tone : kinds.Tone = kinds.Tone.Calm\n');
  let r = await pair(tone);
  assert.ok(all(r).some((d) => d.code === 'PL1001' && /kinds\.Tone/.test(d.message)), text(r));
  r = await pair(swap(tone, 'use kinds.Kind\nuse kinds.Outbox\n', 'use kinds\n'));
  assert.equal(r.verdict, 'CLEAN', text(r));
});

test('S190: a bare member only where the expected type fixes the enum; elsewhere m.E.C; an ambiguous member is refused', { timeout: 120_000 }, async () => {
  // No expected type: a let takes the member's type from the member, so the member must be qualified.
  let r = await pair(swap(CHAT, "    kind' = k\n", "    let x = FreeForm\n    kind' = k\n"));
  assert.ok(codes(r).some((c) => c === 'PL1001' || c === 'PL1005'), text(r));
  r = await pair(swap(CHAT, "    kind' = k\n", "    let x = kinds.Kind.FreeForm\n    kind' = x\n"));
  assert.notEqual(r.verdict, 'REFUSED', text(r));
  // A member of this module's enum and of an admitted one, with no expected type to choose: refused.
  const both = swap(CHAT, 'service machine Chat {', 'enum Mood { FreeForm, Other }\n\nservice machine Chat {');
  r = await pair(swap(both, "    kind' = k\n", "    let x = FreeForm\n    kind' = k\n"));
  assert.ok(codes(r).includes('PL1005'), text(r));
});

test('S190: a match on another module\'s enum covers every member (PL1501)', { timeout: 120_000 }, async () => {
  const r = await pair(swap(CHAT, '      Templated => { emit post(kind: kinds.Kind.Templated) }\n', ''));
  assert.ok(codes(r).includes('PL1501'), text(r));
});

test('S190: records, unions with payloads and maps of another module\'s types stay PL0901', { timeout: 120_000 }, async () => {
  const kinds = swap(KINDS, 'enum Tone { Calm, Loud }\n', 'enum Tone { Calm, Loud }\ntype Pair = { a: bool, b: bool }\ntype Note = Text { n: 0..1 } | Blank\n');
  for (const [field, type, init] of [['pair', 'kinds.Pair', '{ a: true, b: true }'], ['note', 'kinds.Note', 'kinds.Note.Blank'], ['seen', 'map<kinds.Kind, bool>', '{ FreeForm: false, Templated: false }']]) {
    const r = await pair(swap(CHAT, 'use kinds.Kind\nuse kinds.Outbox\n', 'use kinds\n').replace('    sent : 0..2 = 0\n', `    sent : 0..2 = 0\n    ${field} : ${type} = ${init}\n`), kinds);
    assert.ok(codes(r).includes('PL0901'), `${type}: ${text(r)}`);
  }
});

test('B-F4 lifted, S190: in a configuration, == and != on another module\'s enum field work, typed by that module', { timeout: 120_000 }, async () => {
  const B = 'module b\n\nenum S { Idle, Busy }\n\nmachine W {\n  state { st: S = Idle }\n  terminal st is Busy\n  action Go()\n  on Go { require st is Idle else reject "busy"   st\' = Busy }\n}\n';
  const A = (inv) => `module a\nuse b\n\nenum S { Idle, Gone }\n\nmachine A {\n  state { st: S = Idle }\n  terminal st is Gone\n  action Leave()\n  on Leave { require st is Idle else reject "gone"   st' = Gone }\n}\n\nconfiguration c {\n  w : b.W\n  x : A\n  inputs { w.Go, x.Leave }\n  bounds { transit 2 }\n  invariant p: ${inv}\n}\n`;
  const run = async (inv) => {
    const d = join(OUT, `cfg-${n++}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'b.poly'), B);
    writeFileSync(join(d, 'a.poly'), A(inv));
    return checkFile(join(d, 'a.poly'), { root: d });
  };
  let r = await run('w.st == b.S.Busy implies x.st != Gone || x.st == Gone');
  assert.equal(r.verdict, 'CLEAN', text(r));
  r = await run('w.st != b.S.Busy || x.st == Idle');
  assert.equal(r.verdict, 'FINDINGS', text(r));
  r = await run('w.st == x.st');
  assert.ok(codes(r).includes('PL1201'), text(r));
  r = await run('w.st != Gone');
  assert.ok(codes(r).some((c) => c === 'PL1201' || c === 'PL1001'), text(r));
  assert.ok(!codes(r).includes('PL0901'), text(r));
});

test('S190: the build and the certificate record each type module\'s digest; a member added to a std enum makes a stale build fail at load', { timeout: 300_000 }, async () => {
  const std = join(OUT, 'std');
  rmSync(std, { recursive: true, force: true });
  mkdirSync(std, { recursive: true });
  const kinds = 'module std.kinds\n\nenum Kind { FreeForm, Templated }\n';
  writeFileSync(join(std, 'kinds.poly'), kinds);
  const key = makeKey('enums-std');
  const dir = project('enums-std', [], key, 'test-enums-across');
  writeFileSync(join(dir, 'src', 'chat.poly'), 'module chat\nuse std.kinds.Kind\n\nservice machine Chat {\n  state { kind : std.kinds.Kind = std.kinds.Kind.Templated }\n  action Set(k: std.kinds.Kind)\n  on Set(k) { require k != kind else reject "same"   kind\' = k }\n}\n');
  const r = await admit(dir, { std });
  const tm = r.certificate.poly.typeModules;
  assert.deepEqual(Object.keys(tm), ['std.kinds'], JSON.stringify(tm));
  const contract = JSON.parse(readFileSync(join(dir, '.poly', 'build', 'chat.Chat', 'contract.json'), 'utf8'));
  assert.equal(contract.typeModules['std.kinds'], tm['std.kinds'].digest);
  const a = { build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } };
  const ok = await loaded(a, { std });
  await ok.rt.close();
  writeFileSync(join(std, 'kinds.poly'), kinds.replace('Templated }', 'Templated, Voice }'));
  await assert.rejects(loaded(a, { std }), /PL6407[^]*std\.kinds/);
});

test('S190: the certificate\'s module paths are relative (to the project root, or std: to the std root), so an admitted project copied elsewhere loads with no PL6407', { timeout: 300_000 }, async () => {
  const { cpSync } = await import('node:fs');
  const std = join(OUT, 'std-copy');
  rmSync(std, { recursive: true, force: true });
  mkdirSync(std, { recursive: true });
  writeFileSync(join(std, 'kinds.poly'), 'module std.kinds\n\nenum Kind { FreeForm, Templated }\n');
  const key = makeKey('enums-copy');
  const dir = project('enums-copy', [], key, 'test-enums-across');
  writeFileSync(join(dir, 'src', 'tones.poly'), 'module tones\n\nenum Tone { Calm, Loud }\n');
  writeFileSync(join(dir, 'src', 'chat.poly'), 'module chat\nuse std.kinds.Kind\nuse tones.Tone\n\nservice machine Chat {\n  state { kind : std.kinds.Kind = std.kinds.Kind.Templated   tone : tones.Tone = tones.Tone.Calm }\n  action Set(k: std.kinds.Kind, t: tones.Tone)\n  on Set(k, t) { require k != kind || t != tone else reject "same"   kind\' = k   tone\' = t }\n}\n');
  const r = await admit(dir, { std });
  const tm = r.certificate.poly.typeModules;
  assert.deepEqual(Object.fromEntries(Object.entries(tm).map(([m, x]) => [m, x.path])), { 'std.kinds': 'std:kinds.poly', tones: 'src/tones.poly' });
  for (const x of Object.values(tm)) assert.ok(!/^[A-Za-z]:|^\//.test(x.path) && !x.path.includes('..'), x.path);
  // Another folder at the same depth: the certified lockfile (S154) is found by its path relative to the project too.
  const copy = join(ROOT, '.poly', 'test-enums-across-moved', 'enums-copy');
  rmSync(copy, { recursive: true, force: true });
  cpSync(dir, copy, { recursive: true });
  const a = { build: join(copy, '.poly', 'build'), certificate: join(copy, '.poly', 'certificate.json'), trust: { [key.id]: key.publicKey } };
  const ok = await loaded(a, { std });
  await ok.rt.close();
  // Only the hash decides: the copy's own tones.poly changed is refused, as the original's would be.
  writeFileSync(join(copy, 'src', 'tones.poly'), 'module tones\n\nenum Tone { Calm, Loud, Hushed }\n');
  await assert.rejects(loaded(a, { std }), /PL6407[^]*tones/);
});
