// The M8b review, part A: the channel's language side (PS15, PT10a). Each test failed on the tree before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { expandChannels } from '@poly/core';
import { checkFile, resolveUses } from '@poly/check';
import { readChannels, translationValidate } from '@poly/ref';
import { ROOT } from './helpers.mjs';

const STD = join(ROOT, 'test', 'fixtures', 'std');
const CONCIERGE = readFileSync(join(ROOT, 'test', 'fixtures', 'channels', 'concierge.poly'), 'utf8');
const KIND = readFileSync(join(STD, 'channels-test.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-review-m8b-a');
const swap = (src, a, b) => { assert.ok(src.includes(a), a); return src.replace(a, b); };
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
const codes = (r) => all(r).map((d) => d.code);
async function run(name, src, kind = null) {
  const d = join(OUT, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  let std = STD;
  if (kind) { std = join(d, 'std'); mkdirSync(std, { recursive: true }); writeFileSync(join(std, 'channels-test.poly'), kind); }
  writeFileSync(join(d, 'concierge.poly'), src);
  return { r: await checkFile(join(d, 'concierge.poly'), { root: d, std }), dir: d, std };
}

test('A-F1: translation validation reads back the descriptor\'s thread key, adapter, kind and library digest', { timeout: 300_000 }, async () => {
  const { r, dir } = await run('a1', CONCIERGE);
  assert.equal(r.verdict, 'CLEAN');
  const ticket = r.machines.find((m) => m.machine === 'Ticket');
  const file = join(ticket.buildDir, '..', 'channels', 'support.json');
  const good = readFileSync(file, 'utf8');
  const mod = parse(readFileSync(join(dir, 'concierge.poly'), 'utf8')).module;
  const program = resolveUses(mod, join(dir, 'concierge.poly'), undefined, STD).program;
  for (const [what, tamper] of [
    ['thread', (d) => { d.thread = { template: '{body}', fields: ['body'] }; }],
    ['adapter', (d) => { d.adapter = 'whatsapp'; }],
    ['kind', (d) => { d.kind = 'whatsapp'; }],
    ['library digest', (d) => { d.library.digest = `sha256:${'0'.repeat(64)}`; }],
  ]) {
    const d = JSON.parse(good);
    tamper(d);
    writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
    const tv = await translationValidate(mod, 'Ticket', ticket.buildDir, { program });
    assert.ok(tv.mismatches.length > 0, what);
  }
  writeFileSync(file, good);
});

const TWO = (() => {
  let src = swap(CONCIERGE, 'machine Ticket {', 'channel help: test {\n  adapter "test"\n  thread "{from}"\n  starts Ticket.Start on inbound\n  Message -> Ticket.Got2\n  Delivered -> Ticket.Delivered2\n  Rejected -> Ticket.SendRejected2\n  Failed -> Ticket.SendFailed2\n}\n\nmachine Ticket {');
  src = swap(src, '  on Start {', '  action Got2(body: Content)\n  action Delivered2()\n  action SendRejected2(reason: string check { "window-closed" })\n  action SendFailed2()\n  on Got2(body) {\n    require status is Open else reject "closed"\n    emit help.reply(body: body)\n  }\n  on Delivered2 {\n    require true else reject "never"\n  }\n  on SendRejected2(reason) {\n    require true else reject "never"\n  }\n  on SendFailed2 {\n    require true else reject "never"\n  }\n  on Start {');
  return src;
})();

test('A-F2: a second channel on one application leaves the first channel\'s generated configuration as PS15.5 makes it, in the compiler and in poly-ref', { timeout: 300_000 }, async () => {
  const d = join(OUT, 'a2');
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'concierge.poly'), TWO);
  const mod = parse(TWO).module;
  const program = resolveUses(mod, join(d, 'concierge.poly'), undefined, STD).program;
  for (const decls of [expandChannels(mod, program).module.decls, readChannels(mod, program).module.decls]) {
    const support = decls.find((x) => x.kind === 'Configuration' && x.name === 'support');
    assert.ok(support.inputs.every((i) => !/help\.Conversation/.test(i.instance)), JSON.stringify(support.inputs.map((i) => `${i.instance}.${i.action}`)));
  }
});

test('A-F3: an action parameter of the application named after the channel is PL1002, read or not', { timeout: 300_000 }, async () => {
  const unread = swap(CONCIERGE, '  action SendFailed()\n', '  action SendFailed()\n  action Note(support: 0..1)\n');
  const withHandler = swap(unread, '  on SendFailed {', '  on Note(support) {\n    require status is Open else reject "closed"\n    replies\' = support\n  }\n  on SendFailed {');
  for (const src of [unread, withHandler]) assert.ok(codes((await run('a3', src)).r).includes('PL1002'));
});

test('A-F4: a check domain is a set: the same values in another order bind (PS15.1)', { timeout: 300_000 }, async () => {
  const kind = swap(KIND, 'action Rejected(reason: string check { "window-closed" })', 'action Rejected(reason: string check { "window-closed", "busy" })');
  const app = swap(CONCIERGE, 'action SendRejected(reason: string check { "window-closed" })', 'action SendRejected(reason: string check { "busy", "window-closed" })');
  assert.ok(!codes((await run('a4', app, kind)).r).includes('PL6815'));
});

test('A-F5: a kind whose conversation lacks the effect send, Inbound, Open, Reply or Template, or whose pending does not start at 0, is PL6811', { timeout: 300_000 }, async () => {
  const noSend = KIND.replace(/  effect send\(body: Content\) \{[\s\S]*?\n  \}\n/, '').replace('      emit send(body: body)\n', '      receipt\' = true\n').replace('    emit send(body: none)\n', '    receipt\' = true\n');
  const noTemplate = KIND.replace('  action Template()\n', '').replace(/  on Template \{[\s\S]*?\n  \}\n/, '');
  const pendingFromOne = KIND.replace('    pending : 0..2 = 0', '    pending : 1..2 = 1');
  for (const [what, kind] of [['no send', noSend], ['no Template', noTemplate], ['pending 1..2', pendingFromOne]]) {
    const { r } = await run('a5', CONCIERGE, kind);
    assert.ok(codes(r).includes('PL6811'), `${what}: ${JSON.stringify(codes(r))}`);
  }
});

test('A-F6: a repeated adapter, thread or starts clause in a channel is refused, not silently replaced', () => {
  for (const extra of ['  adapter "other"\n', '  thread "{from}"\n', '  starts Ticket.Start\n']) {
    const src = swap(CONCIERGE, '  Message -> Ticket.Got\n', `${extra}  Message -> Ticket.Got\n`);
    const p = parse(src);
    assert.ok(!p.module || p.diagnostics.length > 0, extra);
    assert.ok(p.diagnostics.some((d) => /once/.test(d.message)), JSON.stringify(p.diagnostics));
  }
});

test('A-F7: a configuration not checked because the program was refused reads INCONCLUSIVE, never CLEAN', { timeout: 300_000 }, async () => {
  const src = swap(swap(CONCIERGE, 'channel support: test {', 'channel Ticket: test {'), 'emit support.reply', 'emit Ticket.reply');
  const { r } = await run('a7', src);
  assert.equal(r.verdict, 'REFUSED');
  assert.ok(r.configurations.length > 0);
  for (const c of r.configurations) assert.deepEqual([c.configuration, c.stages[0].status, c.verdict], [c.configuration, 'not-run', 'INCONCLUSIVE']);
});

// A-F2, as ruled (owner, 2026-10-06): the generated configuration of a channel of an application bound to n channels
// has the instance bound 1 + n, the application and every conversation its starts handler spawns (PS15.5).
const BOTH = `module desk

enum Last { Nothing, Sent, Refused, Lost }

channel text: sms {
  adapter "sms"
  thread "{from}"
  starts Agent.Start on inbound
  Message -> Agent.GotText
  Delivered -> Agent.TextDelivered
  Rejected -> Agent.TextRejected
  Failed -> Agent.TextFailed
}

channel mail: email {
  adapter "email"
  thread "{from}"
  starts Agent.Start
  Message -> Agent.GotMail
  Delivered -> Agent.MailDelivered
  Rejected -> Agent.MailRejected
  Failed -> Agent.MailFailed
}

service machine Agent {
  state {
    started : bool = false
    last    : Last = Nothing
  }

  action Start()
  action GotText(body: Content)
  action TextDelivered()
  action TextRejected(reason: string check { "opted-out" })
  action TextFailed()
  action GotMail(body: Content)
  action MailDelivered()
  action MailRejected(reason: string check { "unsubscribed", "suppressed" })
  action MailFailed()

  on Start {
    require !started else reject "started"
    started' = true
  }
  on GotText(body) {
    emit text.reply(body: body)
  }
  on TextDelivered {
    last' = Sent
  }
  on TextRejected(reason) {
    last' = Refused
  }
  on TextFailed {
    last' = Lost
  }
  on GotMail(body) {
    emit mail.reply(body: body)
  }
  on MailDelivered {
    last' = Sent
  }
  on MailRejected(reason) {
    last' = Refused
  }
  on MailFailed {
    last' = Lost
  }
}
`;

async function checkBoth(name, opts = {}, src = BOTH) {
  const d = join(OUT, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'desk.poly'), src);
  return checkFile(join(d, 'desk.poly'), { root: d, ...opts });
}

test('A-F2, as ruled: an application bound to two channels is CLEAN in both generated configurations, three instances each, every never of each conversation tested', { timeout: 1_800_000 }, async () => {
  const r = await checkBoth('a2-bound');
  for (const name of ['text', 'mail']) {
    const c = r.configurations.find((x) => x.configuration === name);
    assert.ok(c, name);
    assert.deepEqual([name, c.verdict, c.notRun, c.vacuous], [name, 'CLEAN', [], []], JSON.stringify(c.diagnostics.map((d) => `${d.code} ${d.message}`)));
    assert.equal(c.instance.instances.length, 3, JSON.stringify(c.instance.instances));
    // Each conversation's never statements are checked, and tested, in its own channel's configuration.
    assert.ok(c.nevers.length > 0 && c.nevers.every((x) => x.machine === `desk.${name}.Conversation` && !x.violated), JSON.stringify(c.nevers));
    // Ruled (2): the report names, per configuration, whose nevers were checked there and whose were left to their own.
    const other = name === 'text' ? 'mail' : 'text';
    assert.deepEqual(c.neverInstances, { checked: ['app', `app/${name}`], elsewhere: [{ instance: `app/${other}`, configuration: other }] });
    assert.deepEqual(c.instance.bounds, ['transit ≤ 4', 'instances ≤ 3']);
  }
  assert.equal(r.verdict, 'CLEAN');
});

test('A-F2, seeded control: with the instance bound left at two (fault instance-bound-two), the configurations stop at the bound', { timeout: 1_800_000 }, async () => {
  const r = await checkBoth('a2-bound-two', { refFault: 'instance-bound-two' });
  for (const name of ['text', 'mail']) assert.equal(r.configurations.find((x) => x.configuration === name).verdict, 'INCONCLUSIVE', name);
});

test('A-F2, seeded control: with the transit bound N alone (fault transit-bound-n), the other conversation\'s creation message gives PL5301', { timeout: 1_800_000 }, async () => {
  const r = await checkBoth('a2-transit-n', { refFault: 'transit-bound-n' });
  for (const name of ['text', 'mail']) {
    const c = r.configurations.find((x) => x.configuration === name);
    assert.deepEqual([name, c.verdict, c.diagnostics.some((d) => d.code === 'PL5301')], [name, 'INCONCLUSIVE', true]);
  }
});

// Ruled (1, third test): an application that answers a message from one channel on the other. In the configuration of
// text, the mail conversation gets no inputs, so a reply sent to it waits for receipts that never come; the check must
// say so (PL5301 at the bound) or be CLEAN over the whole space, never a silent CLEAN over a cut one.
test('A-F2, as ruled: an application that answers a message on the other channel is never a silent CLEAN (as measured: text FINDINGS with PL5407, mail CLEAN)', { timeout: 1_800_000 }, async () => {
  const cross = BOTH.replace('  on GotText(body) {\n    emit text.reply(body: body)\n  }', '  on GotText(body) {\n    emit mail.reply(body: body)\n  }');
  assert.notEqual(cross, BOTH);
  const r = await checkBoth('a2-cross', {}, cross);
  for (const c of r.configurations) {
    const capped = c.diagnostics.some((d) => d.code === 'PL5301' || d.code === 'PL5302');
    if (c.verdict === 'CLEAN') assert.ok(!capped && c.notRun.length === 0, `${c.configuration}: CLEAN with a capped space`);
    else assert.ok(c.verdict !== 'INCONCLUSIVE' || capped || c.vacuous.length > 0 || c.notRun.length > 0, `${c.configuration}: INCONCLUSIVE with no reason`);
  }
  // As measured on the review of M8b, and reported for a ruling: in text's configuration the mail conversation gets
  // no receipts, so its slot is never freed and the second cross reply is refused busy (PL5407); mail's is CLEAN.
  // S207, as ruled: the PL5407 is the program's (an email reply that answers no waiting message), and the application
  // also gets the joint configuration Agent, capped and INCONCLUSIVE at its cap (test/s206-s207.test.mjs).
  assert.deepEqual(r.configurations.map((c) => [c.configuration, c.verdict, [...new Set(c.diagnostics.map((d) => d.code))]]), [['text', 'FINDINGS', ['PL5407']], ['mail', 'CLEAN', []], ['Agent', 'INCONCLUSIVE', ['PL3901']]]);
  console.log(`a2-cross: ${r.configurations.map((c) => `${c.configuration} ${c.verdict} ${[...new Set(c.diagnostics.map((d) => d.code))].join(',')} ${c.instance?.states ?? ''}`).join('; ')}`);
});
