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

test('PS15.3: each handler bound to a receipt ends by acknowledging it, send support <- Ack(); a kind with no Ack is PL6811', { timeout: 180_000 }, async () => {
  const r = await check(SRC);
  assert.equal(r.verdict, 'CLEAN', text(r));
  // Delivered, SendRejected and SendFailed are bound to the receipts; Got (Message) and Start are not.
  const effects = readFileSync(join(OUT, `case-${n - 1}`, '.poly', 'build', 'concierge.Ticket', 'effects.cjs'), 'utf8');
  assert.equal(effects.match(/kind: "sendTo"[^\n]*action: "Ack"/g)?.length, 3, effects);
  // An author does not bind Ack: it is not a Peer action, so a binding of it names no Peer action.
  const bound = await check(swap(SRC, '  Failed -> Ticket.SendFailed\n', '  Failed -> Ticket.SendFailed\n  Ack -> Ticket.Got\n'));
  assert.notEqual(bound.verdict, 'CLEAN', text(bound));
  // A kind whose conversation declares no Ack cannot be expanded.
  const std = join(OUT, 'std-no-ack');
  rmSync(std, { recursive: true, force: true });
  mkdirSync(std, { recursive: true });
  const kind = readFileSync(join(STD, 'channels-test.poly'), 'utf8');
  writeFileSync(join(std, 'channels-test.poly'), swap(swap(kind, '  action Ack()\n', ''), "  on Ack {\n    require receipt else reject \"no-receipt\"\n    receipt' = false\n    pending' = 0\n  }\n", ''));
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'concierge.poly'), SRC);
  const none = await checkFile(join(d, 'concierge.poly'), { root: d, std });
  assert.ok(codes(none).includes('PL6811') && /Ack/.test(text(none)), text(none));
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

// E13, vendored with polygraph 8.4.0: the kernel runs a detached spawn, so an inbound message on an unknown thread
// creates the application, takes starts and spawns the conversation, in that order (PS15.4).
test('PS15.4: inbound on an unknown thread creates the application, takes starts with its spawn, then delivers to the conversation, each journaled', { timeout: 300_000 }, async () => {
  const { a } = await admitted('channels-inbound', SRC);
  const { rt } = await loaded(a, { std: STD });
  try {
    const body = await rt.putContent('where is my order');
    const r = await rt.inbound('support', { from: 'alice', body }, { messageId: 'm-1' });
    const alice = await rt.threadId('support', 'alice');
    assert.deepEqual([r.outcome, r.application, r.conversation], ['delivered', alice, `${alice}/support`]);
    assert.deepEqual((await rt.getJournal(alice)).map((j) => [j.action, j.step_kind]), [['$create', 'accepted'], ['Start', 'accepted']]);
    // The conversation's $create, then its creation action Open(app: self), then the message (plan-m8.md, E13 item 5).
    assert.deepEqual((await rt.getJournal(`${alice}/support`)).map((j) => [j.action, j.step_kind]), [['$create', 'accepted'], ['Open', 'accepted'], ['Inbound', 'accepted']]);
    // A redelivered message is one step (PF8.2).
    await rt.inbound('support', { from: 'alice', body }, { messageId: 'm-1' });
    assert.equal((await rt.getJournal(`${alice}/support`)).filter((j) => j.action === 'Inbound').length, 1);
    await rt.advance();
    assert.ok((await rt.getJournal(alice)).some((j) => j.action === 'Got' && j.step_kind === 'accepted'));
  } finally { await rt.close(); }
});

test('PS15.4: without creation declared, an inbound message for an unknown thread is refused, unknown-thread, and journaled', { timeout: 300_000 }, async () => {
  const { a } = await admitted('channels-unknown', swap(SRC, 'starts Ticket.Start on inbound', 'starts Ticket.Start'));
  const { rt } = await loaded(a, { std: STD });
  try {
    const body = await rt.putContent('hello');
    const r = await rt.inbound('support', { from: 'bob', body }, { messageId: 'm-2' });
    assert.deepEqual([r.outcome, r.reason], ['refused', 'unknown-thread']);
    assert.deepEqual(await rt.getJournal(await rt.threadId('support', 'bob')), []);
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
    assert.deepEqual((await rt.getJournal(await rt.threadId('support', 'alice'))).map((j) => [j.action, j.step_kind]), [['$create', 'accepted'], ['Start', 'rejected']]);
    assert.equal((await rt.inbound('support', { from: 'alice', body }, { messageId: 'm-4' })).reason, 'thread-not-started');
    assert.equal((await rt.getJournal(`${await rt.threadId('support', 'alice')}/support`)).filter((j) => j.action === 'Inbound').length, 0);
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

test('PS15.4, E13: until the kernel can create an instance, an inbound message that would create the application is refused, creation-unavailable, before the kernel is reached', { timeout: 300_000 }, async (t) => {
  const { a } = await admitted('channels-unavailable', SRC);
  const { rt } = await loaded(a, { std: STD });
  try {
    if (rt.kernelCreatesInstances) { t.skip('the vendored kernel has createInstance (E13): the real path is tested above'); return; }
    const body = await rt.putContent('hello');
    const r = await rt.inbound('support', { from: 'alice', body }, { messageId: 'm-5' });
    assert.deepEqual([r.outcome, r.reason], ['refused', 'creation-unavailable']);
    assert.deepEqual(await rt.getJournal(await rt.threadId('support', 'alice')), []);
    assert.deepEqual(await ingress(rt), [['refused', 'creation-unavailable']]);
  } finally { await rt.close(); }
});

// A Ping that replies with no precondition on starts, so a reply can be sent before the conversation exists.
const PING = swap(swap(SRC, '  action Start()\n', '  action Start()\n  action Ping()\n'), '  on Start {', "  on Ping {\n    require replies == 0 else reject \"replied\"\n    replies' = 1\n    emit support.reply(body: none)\n  }\n  on Start {");

test('PS15.4: before starts has run, c names no instance: in a configuration the send is PL5404, and at run time it is dead-lettered on the sender\'s run', { timeout: 300_000 }, async () => {
  const r = await check(`${PING}\nconfiguration early {\n  t : Ticket\n  inputs { t.Ping, t.Start }\n  bounds { transit 1, instances 1 }\n}\n`);
  const early = r.configurations.find((c) => c.configuration === 'early');
  const f = early?.diagnostics.find((d) => d.code === 'PL5404');
  assert.ok(f && /names no instance/.test(f.message), text(r));
  const { a } = await admitted('channels-early', PING);
  const { rt } = await loaded(a, { std: STD });
  try {
    await rt.create('concierge.Ticket', { id: 't-1' });
    assert.equal((await rt.dispatch('t-1', 'Ping')).stepKind, 'accepted');
    await rt.advance();
    const dead = (await rt.getJournal('t-1')).find((j) => j.action === '$undeliverable');
    assert.ok(dead && /no instance 't-1\/support'/.test(dead.reject_reason), JSON.stringify(await rt.getJournal('t-1')));
  } finally { await rt.close(); }
});

test('PS15.4: a thread whose starts never ran has no conversation and stays dead: every message on it is refused, thread-not-started', { timeout: 300_000 }, async () => {
  const { a } = await admitted('channels-dead', SRC);
  const { rt } = await loaded(a, { std: STD });
  try {
    // The host creates the application with no creation action, so starts never runs and no conversation exists.
    await rt.create('concierge.Ticket', { id: await rt.threadId('support', 'bob') });
    const body = await rt.putContent('hello');
    for (const id of ['m-6', 'm-7']) assert.equal((await rt.inbound('support', { from: 'bob', body }, { messageId: id })).reason, 'thread-not-started');
    assert.deepEqual(await ingress(rt), [['refused', 'thread-not-started'], ['refused', 'thread-not-started']]);
  } finally { await rt.close(); }
});

// PS15.5, as ruled on step 8: a receipt the application can reject, and a reply the conversation can refuse, are
// findings of the generated configuration, with their witnesses.
test('PS15.5: an application handler bound to a receipt that can be rejected in a reachable state is PL5406, with a witness', { timeout: 180_000 }, async () => {
  const r = await check(swap(SRC, '  on Delivered {\n    require status is Open else reject "closed"', '  on Delivered {\n    require status is New else reject "too-late"'));
  const f = all(r).find((d) => d.code === 'PL5406');
  assert.ok(f && /Delivered/.test(f.message) && f.witness.length > 0, text(r));
  assert.equal(r.configurations.find((c) => c.configuration === 'support').verdict, 'FINDINGS');
});

test('PS15.5: a Reply or Template the conversation can still refuse is PL5407, with a witness; the concierge has neither finding', { timeout: 180_000 }, async () => {
  // A template sent with the reply finds the conversation's one slot held, and is refused.
  const r = await check(swap(SRC, '    emit support.reply(body: body)\n', '    emit support.reply(body: body)\n    emit support.template()\n'));
  const f = all(r).find((d) => d.code === 'PL5407');
  assert.ok(f && /Template/.test(f.message) && f.witness.length > 0, text(r));
  const clean = await check(SRC);
  assert.deepEqual(all(clean).filter((d) => d.code === 'PL5406' || d.code === 'PL5407'), []);
});
