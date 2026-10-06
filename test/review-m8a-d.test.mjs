// The M8a review, part D: never emit … while (S178, PS5.2, PS5.2a). Each test failed on the tree before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkFile } from '@poly/check';
import { checkMachine } from '@poly/ref';
import { ROOT } from './helpers.mjs';

const OUT = join(ROOT, '.poly', 'test-review-m8a-d');
const FIX = join(ROOT, 'test', 'fixtures', 'review-m8a');
const CHAT = readFileSync(join(ROOT, 'conformance', 'm8', 'never', 'chat-ruled-out.poly'), 'utf8');
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
async function run(name, src) {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.poly`), src);
  return checkFile(join(dir, `${name}.poly`), { root: dir });
}
const findings = (r, m) => r.machines.find((x) => x.machine === m).diagnostics.filter((d) => d.code === 'PL3002');
const codes = (src) => { const r = parse(src); assert.ok(r.module, JSON.stringify(r.diagnostics)); return checkModule(r.module).diagnostics.map((d) => d.code); };

test('D-F1, PS5.2a: a constrained witness is the never\'s finding, and no configuration rules it out', { timeout: 180_000 }, async () => {
  let src = swap(CHAT, '  action Reply()\n', '  action Reply()\n  action Poke()\n');
  src = swap(src, '  effect send(kind: Kind) {', '  on Poke {\n    require !sent else reject "sent"\n    sent\' = true\n    emit send(kind: FreeForm)\n  }\n\n  effect send(kind: Kind) {');
  const r = await run('f1', src);
  assert.equal(r.verdict, 'FINDINGS');
  const [f] = findings(r, 'Chat');
  assert.equal(f?.witness.environment, undefined, JSON.stringify(f?.witness));
  assert.equal(f.witness.trace.at(-1).action, 'Poke');
});

test('D-F2, PS5.2: emits on an effect whose kind another effect shares is refused, since an intent carries the kind', () => {
  const src = readFileSync(join(FIX, 'samekind.poly'), 'utf8');
  assert.ok(codes(src).includes('PL1201'), JSON.stringify(codes(src)));
});

test('D-F3, PS4.4: a timer cancelled before it fires asks for nothing, so a witness that takes it is unconstrained', { timeout: 180_000 }, async () => {
  const src = readFileSync(join(FIX, 'cancelled.poly'), 'utf8');
  const f = checkMachine(parse(src).module, 'Alarm').findings.find((d) => d.code === 'PL3002');
  assert.equal(f?.witness.environment, 'unconstrained', JSON.stringify(f?.witness.trace.map((s) => s.action)));
  const r = await run('f3', src);
  // PS5.2a, ruled on M8 plan step 10: the declared configuration offers no timer (S61), so the never is untested there:
  // vacuous, and the verdict INCONCLUSIVE, with no finding.
  assert.equal(r.verdict, 'INCONCLUSIVE', JSON.stringify(r.machines.flatMap((m) => m.diagnostics.map((d) => d.message))));
  assert.deepEqual(r.machines.flatMap((m) => m.diagnostics.filter((d) => d.code === 'PL3002')), []);
  assert.deepEqual(r.configurations.flatMap((c) => c.vacuous.map((v) => v.property)), ['alarm.no-bell-when-disarmed']);
});

test('D-F4, PS4.4: a completion that an effect and a timer both deliver is asked for by the emitted effect', { timeout: 180_000 }, async () => {
  const src = readFileSync(join(FIX, 'shared.poly'), 'utf8');
  const f = checkMachine(parse(src).module, 'Shop').findings.find((d) => d.code === 'PL3002');
  assert.ok(f);
  assert.equal(f.witness.environment, undefined);
  const r = await run('f4', src);
  assert.equal(r.verdict, 'FINDINGS');
});

test('D-F5, PS4.4: a message sent through a let-bound address is a message too', { timeout: 180_000 }, async () => {
  const r = await run('f5', swap(CHAT, '    send chat <- Reply()\n', '    let c = chat\n    send c <- Reply()\n'));
  // PS5.2a, ruled on M8 plan step 10: ruled out, and untested in the declared configuration (no timer, S61).
  assert.equal(r.verdict, 'INCONCLUSIVE', JSON.stringify(r.machines.flatMap((m) => m.diagnostics.map((d) => d.message))));
  assert.deepEqual(r.machines.find((m) => m.machine === 'Chat').ruledOut.map((x) => x.property), ['free-when-closed']);
});

test('D-F6, PS5.2: a filter constant named like a field is the constructor, and T.C is a constant too', { timeout: 180_000 }, async () => {
  const src = readFileSync(join(FIX, 'shadow.poly'), 'utf8');
  const r = await run('f6', src);
  assert.equal(r.verdict, 'CLEAN', JSON.stringify([...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].map((d) => `${d.code} ${d.message}`)));
  assert.deepEqual(codes(src.replace('emit post(k: Loud)', 'emit post(k: Kind.Loud)')), []);
  const q = await run('f6q', src.replace('emit post(k: Loud)', 'emit post(k: Kind.Loud)'));
  assert.equal(q.verdict, 'CLEAN');
});

test('D-F7, PS5.2a: two never findings ruled out leave the model-check stage CLEAN', { timeout: 180_000 }, async () => {
  const from = '  never free-when-closed: emit send(kind: FreeForm) while window is Closed\n';
  const r = await run('f7', swap(CHAT, from, from + '  never any-when-closed: emit send while window is Closed\n'));
  const chat = r.machines.find((m) => m.machine === 'Chat');
  assert.deepEqual(chat.ruledOut.map((x) => x.property).sort(), ['any-when-closed', 'free-when-closed']);
  assert.equal(chat.stages.find((s) => s.stage === 'model-check').verdict, 'CLEAN');
  // PS5.2a, ruled on M8 plan step 10: both untested in the declared configuration (no timer, S61): INCONCLUSIVE.
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.deepEqual(r.configurations[0].vacuous.map((v) => v.property).sort(), ['chat.any-when-closed', 'chat.free-when-closed']);
});
