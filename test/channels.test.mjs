// M8b step 1 (PS15): the channel, an expansion into a conversation instance, a spawn, a rewrite of sends and a
// generated configuration. The channel kind std.channels.test is the tests' own, found through the test-only std
// option, and never ships in std/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit, checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { loaded, makeKey, project } from './runtime-helpers.mjs';

const STD = join(ROOT, 'test', 'fixtures', 'std');
const SRC = readFileSync(join(ROOT, 'test', 'fixtures', 'channels', 'concierge.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-channels');
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
let n = 0;
async function check(src) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'concierge.poly'), src);
  return checkFile(join(d, 'concierge.poly'), { root: d, std: STD });
}
const codes = (r) => all(r).map((d) => d.code);

test('PS15: a channel expands into the application, its conversation and a configuration named after the channel', { timeout: 180_000 }, async () => {
  const r = await check(SRC);
  assert.equal(r.verdict, 'CLEAN', text(r));
  assert.deepEqual(r.machines.map((m) => m.machine).sort(), ['Ticket', 'support.Conversation']);
  assert.deepEqual(r.configurations.map((c) => c.configuration), ['support']);
  const build = join(OUT, `case-${n - 1}`, '.poly', 'build');
  assert.ok(existsSync(join(build, 'concierge.support.Conversation', 'next.cjs')));
  const descriptor = JSON.parse(readFileSync(join(build, 'channels', 'support.json'), 'utf8'));
  assert.deepEqual([descriptor.application, descriptor.conversation, descriptor.inbound, descriptor.starts, descriptor.effectKind], ['concierge.Ticket', 'concierge.support.Conversation', { to: 'conversation', action: 'Inbound' }, { action: 'Start', onInbound: true }, 'channel.support.send']);
  assert.deepEqual(descriptor.peer, { Message: 'Got', Delivered: 'Delivered', Rejected: 'SendRejected', Failed: 'SendFailed' });
  // PS15.3: emit support.reply is a send to the conversation; only the conversation emits channel.support.send.
  const effects = readFileSync(join(build, 'concierge.Ticket', 'effects.cjs'), 'utf8');
  assert.match(effects, /kind: "sendTo"[^\n]*action: "Reply"/);
  assert.match(readFileSync(join(build, 'concierge.support.Conversation', 'effects.manifest.json'), 'utf8'), /channel\.support\.send/);
});

test('PS15.1: the binding is total (PL6813), one-to-one (PL6814) and typed (PL6815)', { timeout: 180_000 }, async () => {
  let r = await check(swap(SRC, '  Failed -> Ticket.SendFailed\n', ''));
  assert.ok(codes(r).includes('PL6813'), text(r));
  r = await check(swap(SRC, 'Delivered -> Ticket.Delivered', 'Delivered -> Ticket.SendFailed'));
  assert.ok(codes(r).includes('PL6814'), text(r));
  r = await check(swap(SRC, 'Message -> Ticket.Got', 'Message -> Ticket.Delivered').replace('Delivered -> Ticket.Delivered', 'Delivered -> Ticket.Got'));
  assert.ok(codes(r).includes('PL6815'), text(r));
});

test('PT21.1: an unknown kind is PL6811, a thread key over a field the adapter does not declare PL6812', { timeout: 180_000 }, async () => {
  let r = await check(swap(SRC, 'channel support: test {', 'channel support: pigeon {'));
  assert.ok(codes(r).includes('PL6811'), text(r));
  r = await check(swap(SRC, 'thread "{from}"', 'thread "{to}"'));
  assert.ok(codes(r).includes('PL6812'), text(r));
});

test('PS15.2: the child key is the channel\'s name; another use of it in the application is PL1002', { timeout: 180_000 }, async () => {
  const r = await check(swap(SRC, '    status\' = Closed\n  }\n  on SendRejected', '    status\' = Closed\n    after 1m -> SendFailed() as support\n  }\n  on SendRejected'));
  assert.ok(codes(r).includes('PL1002'), text(r));
});

test('PS15.3, S178: a never on c.reply in the application is PL1001, pointing to the conversation', { timeout: 180_000 }, async () => {
  const r = await check(swap(SRC, '  terminal status is Closed\n', '  terminal status is Closed\n  never no-reply: emit support.reply\n'));
  const d = all(r).find((x) => x.code === 'PL1001');
  assert.ok(d && /conversation/.test(d.message), text(r));
});

test('PS15.5: a declared configuration that includes the application gets its conversation', { timeout: 180_000 }, async () => {
  const r = await check(`${SRC}\nconfiguration desk {\n  t : Ticket\n  inputs { t.Start }\n  bounds { transit 1, instances 1 }\n}\n`);
  const desk = r.configurations.find((c) => c.configuration === 'desk');
  assert.ok(desk, text(r));
  assert.ok(desk.instance.instances.some((i) => /support\.Conversation/.test(i)), JSON.stringify(desk.instance));
  assert.ok(desk.instance.states > 2, JSON.stringify(desk.instance));
});

// ── run time: inbound (PS15.4) ──
async function admitted(name, src) {
  const key = makeKey(name);
  const dir = project(name, [], key, 'test-channels-rt');
  writeFileSync(join(dir, 'src', 'concierge.poly'), src);
  const r = await admit(dir, { std: STD });
  return { key, a: { build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } } };
}
const ingress = async (rt) => (await rt.chain('runtime:ingress')).filter((e) => e.body?.stage === 'inbound').map((e) => [e.body.outcome, e.body.reason ?? null]);

// E13: polyrun 8.3.2 has no createInstance intent, so a detached spawn does not run under the kernel; the conversation
// cannot be created at run time until E13 is vendored. The path is written and waits, as E1's tests do.
test('PS15.4: inbound on an unknown thread creates the application, takes starts with its spawn, then delivers to the conversation, each journaled', { timeout: 300_000, todo: 'waiting on E13 (polyrun createInstance): the kernel cannot spawn the conversation' }, async () => {
  const { a } = await admitted('channels-inbound', SRC);
  const { rt } = await loaded(a, { std: STD });
  try {
    const body = await rt.putContent('where is my order');
    const r = await rt.inbound('support', { from: 'alice', body }, { messageId: 'm-1' });
    assert.deepEqual([r.outcome, r.application, r.conversation], ['delivered', 'support:alice', 'support:alice/support']);
    assert.deepEqual((await rt.getJournal('support:alice')).map((j) => [j.action, j.step_kind]), [['$create', 'accepted']]);
    assert.deepEqual((await rt.getJournal('support:alice/support')).map((j) => [j.action, j.step_kind]), [['$create', 'accepted'], ['Inbound', 'accepted']]);
    // A redelivered message is one step (PF8.2).
    await rt.inbound('support', { from: 'alice', body }, { messageId: 'm-1' });
    assert.equal((await rt.getJournal('support:alice/support')).filter((j) => j.action === 'Inbound').length, 1);
    await rt.advance();
    assert.ok((await rt.getJournal('support:alice')).some((j) => j.action === 'Got' && j.step_kind === 'accepted'));
  } finally { await rt.close(); }
});

test('PS15.4: without creation declared, an inbound message for an unknown thread is refused, unknown-thread, and journaled', { timeout: 300_000 }, async () => {
  const { a } = await admitted('channels-unknown', swap(SRC, 'starts Ticket.Start on inbound', 'starts Ticket.Start'));
  const { rt } = await loaded(a, { std: STD });
  try {
    const body = await rt.putContent('hello');
    const r = await rt.inbound('support', { from: 'bob', body }, { messageId: 'm-2' });
    assert.deepEqual([r.outcome, r.reason], ['refused', 'unknown-thread']);
    assert.deepEqual(await rt.getJournal('support:bob'), []);
    assert.deepEqual(await ingress(rt), [['refused', 'unknown-thread']]);
  } finally { await rt.close(); }
});

test('PS15.4: a refused starts refuses the inbound message, thread-not-started', { timeout: 300_000 }, async () => {
  // Start is rejected until Enable has run, which an inbound message never does; Ticket is a service, so the check does
  // not call it stuck.
  let src = swap(SRC, 'machine Ticket {', 'service machine Ticket {');
  src = swap(src, '  terminal status is Closed\n', '');
  src = swap(src, '    replies : 0..1 = 0\n', '    replies : 0..1 = 0\n    ready   : bool = false\n');
  src = swap(src, '    require status is New else reject "started"\n', '    require ready else reject "not-ready"\n    require status is New else reject "started"\n');
  src = swap(src, '  action Start()\n', '  action Start()\n  action Enable()\n');
  src = swap(src, '  on Start {', "  on Enable {\n    require !ready else reject \"ready\"\n    ready' = true\n  }\n  on Start {");
  const { a } = await admitted('channels-not-started', src);
  const { rt } = await loaded(a, { std: STD });
  try {
    const body = await rt.putContent('hello');
    const r = await rt.inbound('support', { from: 'alice', body }, { messageId: 'm-3' });
    assert.deepEqual([r.outcome, r.reason], ['refused', 'thread-not-started']);
    assert.deepEqual(await ingress(rt), [['refused', 'thread-not-started']]);
    // The creation and its rejected starts step are journaled; a later message on the thread is refused the same way.
    assert.deepEqual((await rt.getJournal('support:alice')).map((j) => [j.action, j.step_kind]), [['$create', 'accepted'], ['Start', 'rejected']]);
    assert.equal((await rt.inbound('support', { from: 'alice', body }, { messageId: 'm-4' })).reason, 'thread-not-started');
    assert.equal((await rt.getJournal('support:alice/support')).filter((j) => j.action === 'Inbound').length, 0);
  } finally { await rt.close(); }
});

test('PT21.1, S186: a channel prints and reads back on both surfaces to the same digest', async () => {
  const { parse, format } = await import('@poly/lang');
  const { digest } = await import('@poly/core');
  const { printModule, readEmbedded } = await import('@poly/embed');
  const a = parse(SRC).module;
  assert.equal(digest(parse(format(a)).module), digest(a));
  const ts = printModule(a);
  const back = readEmbedded(ts);
  assert.ok(back.module, JSON.stringify(back.diagnostics));
  assert.equal(digest(back.module), digest(a));
});
