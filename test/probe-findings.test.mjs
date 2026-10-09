// Findings F4 and F3 of the probe review of V1 to V5, written from the specification text before the fix.
//   F4 (PS13.6, PS3.2, PT3.4a): a message whose data lies outside the receiving action's strict check domain is
//      PL5408 MESSAGE_OUTSIDE_DOMAIN, a finding, in a configuration that reaches the delivery and on a machine alone
//      for a send to a Ref<M>, a spawn's creation action or a signal to an attached child. A disclosed receiver
//      parameter is not reported.
//   F3 (PT3.4a, "Through fields"): a disclosed parameter whose value flows through state fields into the payload of
//      an irreversible emit is PL1301, its message naming the chain.
// The programs are in test/fixtures/probe-findings; variants are made by replacing text and written under the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkFile, render } from '@poly/check';
import { ROOT, BUILD } from './helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'probe-findings');
const OUT = join(BUILD, 'probe-findings');
const src = (name) => readFileSync(join(FIX, `${name}.poly`), 'utf8');
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
const show = (r) => `${r.error ?? ''}\n${render(r)}`;
const witnessLength = (d) => (Array.isArray(d.witness) ? d.witness.length : d.witness?.trace?.length ?? 0);

/** Checks a program text from a file of its own, so each variant has its own build. */
async function check(name, text) {
  const dir = join(OUT, 'sources');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.poly`);
  writeFileSync(file, text);
  return checkFile(file, { root: join(OUT, name) });
}

const replaced = (text, a, b) => {
  assert.ok(text.includes(a), `the fixture contains ${a}`);
  return text.replaceAll(a, b);
};

// ── F4 ─────────────────────────────────────────────────────────────────────

test('F4 (a): in a configuration, a send whose data lies outside the receiver\'s strict domain is PL5408 with a witness, and the configuration is not CLEAN', { timeout: 300_000 }, async () => {
  const r = await check('f4-config', src('f4-config'));
  const cfg = r.configurations.find((c) => c.configuration === 'pair');
  assert.ok(cfg, show(r));
  const f = cfg.diagnostics.find((d) => d.code === 'PL5408');
  assert.ok(f, show(r));
  assert.match(f.message, /Pay/, show(r));
  assert.ok(witnessLength(f) > 0, `PL5408 carries the path to the delivery as its witness\n${show(r)}`);
  assert.notEqual(cfg.verdict, 'CLEAN', show(r));
  assert.notEqual(r.verdict, 'CLEAN', show(r));
});

test('F4 (b): on Send alone, with no configuration, a send to a Ref<Recv> outside Pay\'s strict domain is PL5408 with the path to the step', { timeout: 300_000 }, async () => {
  const r = await check('f4-alone', src('f4-alone'));
  assert.deepEqual(r.configurations.map((c) => c.configuration), [], 'no configuration is declared');
  const send = r.machines.find((m) => m.machine === 'Send');
  assert.ok(send, show(r));
  const f = send.diagnostics.find((d) => d.code === 'PL5408');
  assert.ok(f, show(r));
  assert.ok(witnessLength(f) > 0, `PL5408 carries the path to the step\n${show(r)}`);
  assert.notEqual(r.verdict, 'CLEAN', show(r));
});

test('F4 (c): a spawn\'s creation action carrying a value outside the child\'s strict domain is PL5408 on the parent alone', { timeout: 300_000 }, async () => {
  const r = await check('f4-spawn', src('f4-spawn'));
  const parent = r.machines.find((m) => m.machine === 'Parent');
  assert.ok(parent, show(r));
  const f = parent.diagnostics.find((d) => d.code === 'PL5408');
  assert.ok(f, show(r));
  assert.match(f.message, /Start/, show(r));
  assert.notEqual(r.verdict, 'CLEAN', show(r));
});

test('F4 (d): a range parameter 1..3 sent into a range 1..2 is PL5408, in the configuration and on the sender alone', { timeout: 300_000 }, async () => {
  let text = replaced(src('f4-config'), 'Go(v: int check { 1, 2, 3 })', 'Go(v: 1..3)');
  text = replaced(text, 'Pay(a: int check { 1, 2 })', 'Pay(a: 1..2)');
  const r = await check('f4-range', text);
  assert.ok(r.configurations.find((c) => c.configuration === 'pair')?.diagnostics.some((d) => d.code === 'PL5408'), show(r));
  assert.ok(r.machines.find((m) => m.machine === 'Send')?.diagnostics.some((d) => d.code === 'PL5408'), show(r));
});

test('F4 (e), confirmation: a receiver that declares its parameter disclosed gives no PL5408', { timeout: 300_000 }, async () => {
  const r = await check('f4-disclosed', replaced(src('f4-config'), 'Pay(a: int check { 1, 2 })', 'Pay(a: int check { 1, 2 } disclosed)'));
  assert.equal(r.error, undefined, show(r));
  assert.deepEqual(all(r).filter((d) => d.code === 'PL5408'), [], show(r));
});

test('F4 (f), confirmation: a sender that sends only values inside the receiver\'s domain gives no PL5408', { timeout: 300_000 }, async () => {
  const r = await check('f4-inside', replaced(src('f4-config'), 'Go(v: int check { 1, 2, 3 })', 'Go(v: int check { 1, 2 })'));
  assert.equal(r.error, undefined, show(r));
  assert.deepEqual(all(r).filter((d) => d.code === 'PL5408'), [], show(r));
  const spawn = await check('f4-spawn-inside', replaced(src('f4-spawn'), 'Plan(n: int check { 1, 2, 3 })', 'Plan(n: int check { 1, 2 })'));
  assert.deepEqual(all(spawn).filter((d) => d.code === 'PL5408'), [], show(spawn));
});

// ── F3 ─────────────────────────────────────────────────────────────────────

const diagnostics = (text) => {
  const p = parse(text);
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  return checkModule(p.module).diagnostics;
};
const codes = (text) => diagnostics(text).map((d) => d.code);
const program = (state, handlers, cls = 'irreversible') => `module f3\nmachine M {\n  state {\n${state}\n  }\n${handlers}\n  effect charge(a: int) {\n    labels { egress:external }\n    class ${cls}\n  }\n}\n`;

const ONE_FIELD = program(
  '    owed : 0..2 = 0',
  '  action Set(amt: int check { 1, 2 } disclosed)\n  action Pay()\n  on Set(amt) { owed\' = amt }\n  on Pay { require owed > 0 else reject "nothing"  emit charge(a: owed) }',
);

test('F3: a disclosed parameter stored in a field that an irreversible emit in another handler reads is PL1301, naming the chain', () => {
  const ds = diagnostics(ONE_FIELD).filter((d) => d.code === 'PL1301');
  assert.equal(ds.length, 1, JSON.stringify(diagnostics(ONE_FIELD)));
  assert.match(ds[0].message, /\bamt\b/);
  assert.match(ds[0].message, /\bowed\b/);
});

test('F3: the field read as pre.owed in the irreversible payload is PL1301 too', () => {
  const text = replaced(ONE_FIELD, 'emit charge(a: owed)', 'emit charge(a: pre.owed)');
  assert.deepEqual(codes(text).filter((c) => c === 'PL1301'), ['PL1301']);
});

test('F3: a value stored through a let is followed into the field', () => {
  const text = replaced(ONE_FIELD, 'on Set(amt) { owed\' = amt }', 'on Set(amt) { let x = amt  owed\' = x }');
  assert.deepEqual(codes(text).filter((c) => c === 'PL1301'), ['PL1301']);
});

test('F3: a chain through two fields (amt to held, held to owed, owed charged) is PL1301, its message naming each link', () => {
  const text = program(
    '    held : 0..2 = 0\n    owed : 0..2 = 0',
    '  action Set(amt: int check { 1, 2 } disclosed)\n  action Move()\n  action Pay()\n  on Set(amt) { held\' = amt }\n  on Move { owed\' = held }\n  on Pay { require owed > 0 else reject "nothing"  emit charge(a: owed) }',
  );
  const ds = diagnostics(text).filter((d) => d.code === 'PL1301');
  assert.equal(ds.length, 1, JSON.stringify(diagnostics(text)));
  for (const name of ['amt', 'held', 'owed']) assert.match(ds[0].message, new RegExp(`\\b${name}\\b`), ds[0].message);
});

test('F3, confirmation: a disclosed parameter stored in a field that no irreversible emit reads gives no PL1301', () => {
  const text = program(
    '    owed : 0..2 = 0\n    other : 0..2 = 1',
    '  action Set(amt: int check { 1, 2 } disclosed)\n  action Pay()\n  on Set(amt) { owed\' = amt }\n  on Pay { require other > 0 else reject "nothing"  emit charge(a: other) }',
  );
  assert.deepEqual(codes(text).filter((c) => c === 'PL1301'), []);
});

test('F3, confirmation: a compensable emit reading the field gives no PL1301 (PL1301 is for irreversible effects)', () => {
  const text = program(
    '    owed : 0..2 = 0',
    '  action Set(amt: int check { 1, 2 } disclosed)\n  action Pay()\n  on Set(amt) { owed\' = amt }\n  on Pay { require owed > 0 else reject "nothing"  emit charge(a: owed) }',
    'compensable',
  );
  assert.deepEqual(codes(text).filter((c) => c === 'PL1301'), []);
});
