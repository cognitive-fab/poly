// S178 (M8a step 5): never emit … while (PS5.2a), and a step property that reads the step's intents through emits
// (PS5.2). `while` reads the pre-state; emits names effects only, with constant field values. A witness that needs an
// environment nothing provides is marked environment: unconstrained, and a configuration that includes the machine
// confirms it or rules it out. No model runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkFile } from '@poly/check';
import { checkMachine } from '@poly/ref';
import { ROOT } from './helpers.mjs';

const DIR = join(ROOT, 'conformance', 'm8', 'never');
const WINDOW = readFileSync(join(DIR, 'window.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-never');
const codes = (src) => { const r = parse(src); assert.ok(r.module, JSON.stringify(r.diagnostics)); return [...r.diagnostics, ...checkModule(r.module).diagnostics].map((d) => d.code); };
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
const messages = (r) => JSON.stringify([...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)].map((d) => `${d.code} ${d.message}`));
let n = 0;
async function checkSource(src) {
  const dir = join(OUT, `case-${n++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'window.poly'), src);
  return checkFile(join(dir, 'window.poly'), { root: dir });
}
const findingsOf = (r, property) => r.machines.flatMap((m) => m.diagnostics).filter((d) => d.code === 'PL3002' && d.property === property);

test('PS5.2a: the window rule holds where every free-form send leaves an open window, and the instance is CLEAN', { timeout: 120_000 }, async () => {
  const r = await checkFile(join(DIR, 'window.poly'), { root: join(OUT, 'window') });
  assert.equal(r.verdict, 'CLEAN', messages(r));
});

test('PS5.2a, choice 1: while reads the pre-state; a step from an open window that opens it and sends is allowed, one from a closed window that opens it and sends is a finding', { timeout: 120_000 }, async () => {
  // Allowed: Reply in window.poly sends from Open and writes Open; Close sends from Open and writes Closed (above, CLEAN).
  assert.ok(WINDOW.includes("    window' = Open\n    sent' = true\n    emit send(kind: FreeForm)"));
  // A finding: Inbound sends from Closed, though it opens the window in the same step.
  const r = await checkSource(swap(WINDOW, "    window' = Open\n  }\n  on Reply", "    window' = Open\n    emit send(kind: FreeForm)\n  }\n  on Reply"));
  assert.equal(r.verdict, 'FINDINGS', messages(r));
  const [f] = findingsOf(r, 'free-when-closed');
  assert.ok(f, messages(r));
  assert.equal(f.witness.trace.at(-1).action, 'Inbound');
});

test('PS5.2a: the field filter: a templated send while closed is allowed, a free-form one is a finding', { timeout: 120_000 }, async () => {
  const r = await checkSource(swap(WINDOW, '    emit send(kind: Templated)', '    emit send(kind: FreeForm)'));
  assert.equal(r.verdict, 'FINDINGS', messages(r));
  assert.equal(findingsOf(r, 'free-when-closed')[0]?.witness.trace.at(-1).action, 'Template');
  // PS5.2: the step property that reads emits sees it too.
  assert.ok(findingsOf(r, 'templated-only-when-closed').length, messages(r));
});

test('PS5.2a: without while, P is true: any matching send is a finding', { timeout: 120_000 }, async () => {
  const r = await checkSource(swap(WINDOW, '  never free-when-closed:', '  never no-templated: emit send(kind: Templated)\n  never free-when-closed:'));
  assert.equal(findingsOf(r, 'no-templated')[0]?.witness.trace.at(-1).action, 'Template', messages(r));
});

test('PS5.2, PS5.2a: emits names an effect: a send, a timer and a spawn are PL1001, each', () => {
  const base = [
    'module errors',
    'machine Job {',
    '  state { done : bool = false }',
    '  terminal done',
    '  action Finish()',
    '  on Finish { require !done else reject "done"  done\' = true }',
    '}',
    'machine M {',
    '  state { x : bool = false  peer : Ref<M> = none }',
    '  action A()  action Tick()  action Ping()  action Finished()',
    '  on A { require !x else reject "x"  x\' = true  after 1m -> Tick() as hold  send peer <- Ping()  spawn Job as job on complete -> Finished }',
    '  on Tick { require x else reject "idle"  x\' = false }',
    '  on Ping { require x else reject "idle"  x\' = false }',
    '  on Finished { require x else reject "idle"  x\' = false }',
    '  PROPERTY',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(codes(base.replace('  PROPERTY', '')), []);
  for (const name of ['Ping', 'hold', 'Tick', 'job']) {
    assert.ok(codes(base.replace('PROPERTY', `step property p: !emits(${name})`)).includes('PL1001'), `emits(${name})`);
    assert.ok(codes(base.replace('PROPERTY', `never p: emit ${name}`)).includes('PL1001'), `never emit ${name}`);
  }
});

test('PS5.2a: a field that is not the payload\'s is PL1001, a value outside its type PL1201, and while reads only the pre-state\'s fields', () => {
  assert.deepEqual(codes(WINDOW), []);
  assert.ok(codes(swap(WINDOW, 'emit send(kind: FreeForm) while', 'emit send(tone: FreeForm) while')).includes('PL1001'));
  assert.ok(codes(swap(WINDOW, 'emit send(kind: FreeForm) while', 'emit send(kind: Open) while')).includes('PL1201'));
  assert.ok(codes(swap(WINDOW, 'emit send(kind: FreeForm) while', 'emit send(kind: 3) while')).includes('PL1201'));
  assert.ok(codes(swap(WINDOW, 'emit send(kind: FreeForm) while','emit nosuch(kind: FreeForm) while')).includes('PL1001'));
  for (const p of ['post.window is Closed', 'pre.window is Closed', 'action == Reply', 'window is Closed && emits(send)']) {
    assert.ok(codes(swap(WINDOW, 'while window is Closed', `while ${p}`)).includes('PL1201'), p);
  }
  // A field filter reads no field or parameter: its value is a constant.
  assert.ok(codes(swap(WINDOW, '  step property templated-only-when-closed: (pre.window is Closed && emits(send)) implies emits(send, kind: Templated)', '  step property p: !emits(send, kind: pre.window)')).includes('PL1201'));
  // A name is required, and a never and a property share one namespace.
  assert.ok(codes(swap(WINDOW, '  never free-when-closed:', '  never templated-only-when-closed:')).includes('PL1002'));
});

test('PS5.2a, PS4.4: alone, a witness that needs a message nothing sent is marked environment: unconstrained', () => {
  const r = parse(readFileSync(join(DIR, 'chat-ruled-out.poly'), 'utf8'));
  const rep = checkMachine(r.module, 'Chat');
  const f = rep.findings.find((d) => d.code === 'PL3002' && d.property === 'free-when-closed');
  assert.ok(f, JSON.stringify(rep.findings.map((d) => d.message)));
  assert.equal(f.witness.environment, 'unconstrained');
  assert.equal(f.witness.trace.at(-1).action, 'Reply');
});

test('PS5.2a: a configuration that cannot reach the violation rules the unconstrained witness out, and it is not counted', { timeout: 180_000 }, async () => {
  const r = await checkFile(join(ROOT, 'test', 'fixtures', 'm9', 'chat-ruled-out-plain.poly'), { root: join(OUT, 'ruled-out') });
  // PS5.2a: the declared configuration pair never offers Expired, so it never takes Reply from a closed window: the
  // never is untested there, listed vacuous, and the verdict is INCONCLUSIVE, not CLEAN.
  assert.equal(r.verdict, 'INCONCLUSIVE', messages(r));
  assert.deepEqual(r.configurations[0].vacuous.map((v) => v.property), ['chat.free-when-closed']);
  const chat = r.machines.find((m) => m.machine === 'Chat');
  assert.deepEqual(chat.diagnostics.filter((d) => d.code === 'PL3002'), []);
  assert.deepEqual(chat.ruledOut?.map((x) => [x.property, x.configurations]), [['free-when-closed', ['pair']]]);
  assert.equal(chat.ruledOut[0].witness.environment, 'unconstrained');
  assert.deepEqual(r.configurations[0].diagnostics.filter((d) => d.code === 'PL3002'), []);
});

test('PS5.2a: a configuration that reaches the violation confirms the unconstrained witness', { timeout: 180_000 }, async () => {
  const r = await checkFile(join(DIR, 'chat-confirmed.poly'), { root: join(OUT, 'confirmed') });
  assert.equal(r.verdict, 'FINDINGS', messages(r));
  const chat = r.machines.find((m) => m.machine === 'Chat');
  const f = chat.diagnostics.find((d) => d.code === 'PL3002' && d.property === 'free-when-closed');
  assert.ok(f, messages(r));
  assert.equal(f.witness.environment, 'unconstrained');
  assert.deepEqual(chat.ruledOut ?? [], []);
  const g = r.configurations[0].diagnostics.find((d) => d.code === 'PL3002');
  assert.ok(g, messages(r));
  assert.equal(g.property, 'chat.free-when-closed');
  assert.equal(g.witness.trace.at(-1).action, 'Reply');
});

// PS15.5, S206 as ruled: the window's timer fires in the declared configuration pair, so the window can close before
// the reply, and the witness the configuration used to rule out is reached and counted.
test('S206: with timers firing in every configuration, chat-ruled-out\'s never violation is a finding of pair', { timeout: 180_000 }, async () => {
  const r = await checkFile(join(DIR, 'chat-ruled-out.poly'), { root: join(OUT, 's206') });
  assert.equal(r.verdict, 'FINDINGS', messages(r));
  assert.ok(r.configurations[0].diagnostics.some((d) => d.code === 'PL3002' && d.property === 'chat.free-when-closed'), messages(r));
  assert.deepEqual(r.configurations[0].vacuous, []);
});
