// S176 (M8a step 3): `use` lowered within a project and std/ (PS1.0). A program is a set of modules, a machine of
// another module is named m.M and only so, and `use` adds no behaviour: an unused use changes no verdict and no state
// count, and conformance/m2/detached.poly split in two modules gives the original's verdicts and counts. A lone file's
// directory is a search path only, two files of one module refuse the check, and cycles are allowed. Attached spawns
// across modules stay PL0901, and a message across modules carries only types that need no module (S190 to come).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkFile, checkProject } from '@poly/check';
import { RefusedDispatch } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { admitted, loaded } from './runtime-helpers.mjs';

const USE = join(ROOT, 'conformance', 'm8', 'use');
const ROOT_OUT = join(ROOT, '.poly', 'test-use');
let n = 0;
const out = () => join(ROOT_OUT, String(n++));
/** A file's verdict, its diagnostics' codes, and each machine's and configuration's counts. */
const counts = (r) => ({
  verdict: r.verdict,
  codes: [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)].map((d) => d.code).sort(),
  machines: Object.fromEntries(r.machines.map((m) => [m.machine, [m.verdict, m.instance?.states ?? null, m.instance?.transitions ?? null]])),
  configurations: Object.fromEntries(r.configurations.map((c) => [c.configuration, [c.verdict, c.instance?.states ?? null, c.instance?.transitions ?? null]])),
});
const codes = (r) => counts(r).codes;
const messages = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].map((d) => `${d.code} ${d.message}`);
/** A directory holding the given files: [name, text] pairs. */
function dir(files) {
  const d = mkdtempSync(join(tmpdir(), 'poly-use-'));
  for (const [name, text] of files) writeFileSync(join(d, name), text);
  return d;
}
const src = (name) => readFileSync(join(USE, name), 'utf8');

test('PS1.0, S176: detached.poly split in two modules that use each other gives the original\'s verdicts and state counts', { timeout: 300_000 }, async () => {
  const one = counts(await checkFile(join(ROOT, 'conformance', 'm2', 'detached.poly'), { root: out() }));
  const workers = counts(await checkFile(join(USE, 'workers.poly'), { root: out() }));
  const dispatch = counts(await checkFile(join(USE, 'dispatch.poly'), { root: out() }));
  assert.equal(workers.verdict, 'CLEAN');
  assert.equal(dispatch.verdict, 'CLEAN');
  assert.deepEqual(workers.machines.Worker, one.machines.Worker);
  assert.deepEqual(dispatch.machines.Dispatcher, one.machines.Dispatcher);
  assert.deepEqual(dispatch.configurations.pool, one.configurations.pool);
});

test('S176: the configuration explores the other module\'s machine: breaking its property gives a finding', { timeout: 300_000 }, async () => {
  const d = dir([['workers.poly', src('workers.poly')], ['dispatch.poly', src('dispatch.poly').replace('count(workers.Worker[*] is Finished) <= 1', 'count(workers.Worker[*] is Finished) < 1')]]);
  try {
    const r = await checkFile(join(d, 'dispatch.poly'), { root: out() });
    assert.equal(r.configurations[0].verdict, 'FINDINGS', JSON.stringify(counts(r)));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('S176 (ruled): adding an unused use changes no verdict and no state count', { timeout: 600_000 }, async () => {
  const helper = 'module helper\n\nmachine Spare {\n  state { n: 0..1 = 0 }\n  terminal n == 1\n  action Bump()\n  on Bump { require n == 0 else reject "done"   n\' = 1 }\n}\n';
  for (const f of ['conformance/m2/detached.poly', 'conformance/m6/customer-brief.poly', 'examples/orders/orders.poly', 'conformance/m2/completions.poly']) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    const name = f.split('/').pop();
    const plain = dir([[name, text]]);
    const used = dir([[name, text.replace(/^(module [\w.]+)$/m, '$1\nuse helper')], ['helper.poly', helper]]);
    try {
      assert.notEqual(readFileSync(join(used, name), 'utf8'), text, f);
      assert.deepEqual(counts(await checkFile(join(used, name), { root: out() })), counts(await checkFile(join(plain, name), { root: out() })), f);
    } finally { rmSync(plain, { recursive: true, force: true }); rmSync(used, { recursive: true, force: true }); }
  }
});

test('S176: qualified names only: a used module\'s machine is m.M, never M, and a module not used cannot be named', async () => {
  const ledger = src('ledger.poly');
  const till = (head, ref) => `module teller\n${head}\nmachine Till {\n  state { account: Ref<${ref}> = none }\n  action Open(account: Ref<${ref}>)\n  on Open(account) { account' = account }\n}\n`;
  for (const [head, ref, want] of [['use ledger', 'Account', /unknown|no machine Account in module teller/], ['use ledger.Account', 'Account', /no machine Account in module teller/], ['', 'ledger.Account', /not used here/]]) {
    const d = dir([['teller.poly', till(head, ref)], ['ledger.poly', ledger]]);
    try {
      const r = await checkFile(join(d, 'teller.poly'), { root: out() });
      assert.equal(r.verdict, 'REFUSED', `${head} ${ref}`);
      assert.ok(messages(r).some((m) => m.startsWith('PL1001') && want.test(m)), JSON.stringify(messages(r)));
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('S176: a module that uses itself, or a module not found, is refused at the use', async () => {
  for (const [text, code] of [['module teller\nuse teller\n', 'PL1201'], ['module teller\nuse nothere\n', 'PL1001']]) {
    const d = dir([['teller.poly', text]]);
    try { assert.ok(codes(await checkFile(join(d, 'teller.poly'), { root: out() })).includes(code), text); } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('S176: an attached spawn of another module\'s machine stays PL0901', async () => {
  const d = dir([['workers.poly', src('workers.poly')], ['boss.poly', 'module boss\nuse workers\n\nmachine Boss {\n  state { n: 0..1 = 0 }\n  action Go()\n  on Go { n\' = 1   spawn workers.Worker as w -> Start(n: 1) }\n}\n']]);
  try {
    const r = await checkFile(join(d, 'boss.poly'), { root: out() });
    assert.ok(messages(r).some((m) => m.startsWith('PL0901') && /attached spawn of another module/.test(m)), JSON.stringify(messages(r)));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('S176: a message across modules may not carry a type its module declares (S190 to come)', async () => {
  const flags = 'module flags\n\nenum Colour { Red, Blue }\n\nservice machine Lamp {\n  state { c: Colour = Red }\n  action Paint(c: Colour)\n  on Paint(c) { c\' = c }\n}\n';
  const user = 'module user\nuse flags\n\nmachine User {\n  state { lamp: Ref<flags.Lamp> = none   done: bool = false }\n  action Use(l: Ref<flags.Lamp>)\n  on Use(l) { done\' = true   lamp\' = l   send l <- Paint(c: Red) }\n}\n';
  const d = dir([['flags.poly', flags], ['user.poly', user]]);
  try {
    const r = await checkFile(join(d, 'user.poly'), { root: out() });
    assert.ok(messages(r).some((m) => m.startsWith('PL0901') && /types that need no module/.test(m)), JSON.stringify(messages(r)));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('S176 (ruled): a lone file\'s directory is a search path only: an unrelated broken file changes nothing', { timeout: 300_000 }, async () => {
  const clean = dir([['teller.poly', src('teller.poly')], ['ledger.poly', src('ledger.poly')]]);
  const noisy = dir([['teller.poly', src('teller.poly')], ['ledger.poly', src('ledger.poly')], ['broken.poly', 'module broken\nmachine { this is not poly'], ['other.poly', 'module other\nuse nothere\nmachine X { state { a: 0..1 = 0 } }\n'], ['notes.poly', 'not even a header']]);
  try {
    const a = await checkFile(join(clean, 'teller.poly'), { root: out() });
    const b = await checkFile(join(noisy, 'teller.poly'), { root: out() });
    assert.equal(a.verdict, 'CLEAN');
    assert.deepEqual(counts(b), counts(a));
  } finally { rmSync(clean, { recursive: true, force: true }); rmSync(noisy, { recursive: true, force: true }); }
});

test('S176 (ruled): two files that declare one used module refuse the check with PL1002, naming both; one is never picked', async () => {
  const d = dir([['teller.poly', src('teller.poly')], ['ledger.poly', src('ledger.poly')], ['ledger-copy.poly', src('ledger.poly')]]);
  try {
    const r = await checkFile(join(d, 'teller.poly'), { root: out() });
    assert.equal(r.verdict, 'REFUSED');
    assert.ok(messages(r).some((m) => m.startsWith('PL1002') && /ledger\.poly/.test(m) && /ledger-copy\.poly/.test(m)), JSON.stringify(messages(r)));
  } finally { rmSync(d, { recursive: true, force: true }); }
  // In a project too.
  const p = dir([['teller.poly', src('teller.poly')], ['ledger.poly', src('ledger.poly')], ['ledger-copy.poly', src('ledger.poly')], ['poly.json', JSON.stringify({ poly: '1', name: 'dup', modules: ['*.poly'] })]]);
  try {
    const r = await checkProject(p, { root: out() });
    const teller = r.files.find((f) => f.module === 'teller');
    assert.ok(teller.diagnostics.some((d) => d.code === 'PL1002' && /ledger-copy\.poly/.test(d.message)), JSON.stringify(teller.diagnostics));
  } finally { rmSync(p, { recursive: true, force: true }); }
});

test('S176, polywatch: a duplicate or broken module reached through another module\'s use refuses the check too', async () => {
  const mid = 'module mid\nuse leaf\n\nmachine Mid {\n  state { n: 0..1 = 0 }\n  action Go()\n  on Go { n\' = 1 }\n}\n';
  const leaf = 'module leaf\n\nmachine Leaf {\n  state { n: 0..1 = 0 }\n  action Go()\n  on Go { n\' = 1 }\n}\n';
  const top = 'module top\nuse mid\n\nmachine Top {\n  state { n: 0..1 = 0 }\n  action Go()\n  on Go { n\' = 1 }\n}\n';
  for (const [extra, code] of [[[['leaf-copy.poly', leaf]], 'PL1002'], [[], 'PL1001']]) {
    const files = [['top.poly', top], ['mid.poly', mid], ...(code === 'PL1001' ? [['leaf.poly', 'module leaf\nmachine { broken']] : [['leaf.poly', leaf]]), ...extra];
    const d = dir(files);
    try {
      const r = await checkFile(join(d, 'top.poly'), { root: out() });
      assert.equal(r.verdict, 'REFUSED', code);
      assert.ok(messages(r).some((m) => m.startsWith(code) && /leaf/.test(m)), JSON.stringify(messages(r)));
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('S176: in a project, a module that uses another is checked with it, cycles included', { timeout: 300_000 }, async () => {
  const p = dir([['workers.poly', src('workers.poly')], ['dispatch.poly', src('dispatch.poly')], ['poly.json', JSON.stringify({ poly: '1', name: 'pair', modules: ['*.poly'] })]]);
  try {
    const r = await checkProject(p, { root: out() });
    assert.deepEqual(r.files.map((f) => [f.module, f.verdict]).sort(), [['dispatch', 'CLEAN'], ['workers', 'CLEAN']]);
  } finally { rmSync(p, { recursive: true, force: true }); }
});

test('S176: at runtime a message crosses modules, and an address of a used module\'s machine is checked against its instances', { timeout: 300_000 }, async () => {
  const a = await admitted('use-runtime', ['conformance/m8/use/ledger.poly', 'conformance/m8/use/teller.poly']);
  const { rt } = await loaded(a);
  try {
    await rt.create('ledger.Account', { id: 'acc-1' });
    await rt.create('teller.Till', { id: 't-1' });
    await assert.rejects(rt.dispatch('t-1', 'Open', { account: 'nope' }), (e) => e instanceof RefusedDispatch && e.rule === 'S140');
    assert.equal((await rt.dispatch('t-1', 'Open', { account: 'acc-1' })).stepKind, 'accepted');
    assert.equal((await rt.dispatch('t-1', 'Pay')).stepKind, 'accepted');
    await rt.advance();
    assert.equal((await rt.getState('acc-1')).state.balance, 1);
  } finally { await rt.close(); }
});

