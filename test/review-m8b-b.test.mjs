// The M8b review, part B: the std conversation machines. Each test failed on the tree before its fix. The rules the
// review added (the queue's order, WhatsApp's window on every message, Slack's held reply, email's bounces) each have
// their seeded mutant in test/std-channels.test.mjs; these tests check the behaviour the findings named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { checkFile, resolveUses } from '@poly/check';
import { checkMachine } from '@poly/ref';
import { email } from '@poly/io';
import { ROOT } from './helpers.mjs';

const STD = join(ROOT, 'std', 'channels');
const OUT = join(ROOT, '.poly', 'test-review-m8b-b');
const source = (k) => readFileSync(join(STD, `${k}.poly`), 'utf8');
async function check(name, src) {
  const d = join(OUT, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), src);
  return checkFile(join(d, 'm.poly'), { root: d });
}
const graph = (k) => { const file = join(STD, `${k}.poly`); const mod = parse(source(k)).module; return checkMachine(mod, 'Conversation', { program: resolveUses(mod, file).program }).graph; };

test('B-F1: a Plain or Help message that changes consent breaks consent-changes-only-by-keyword', { timeout: 300_000 }, async () => {
  const src = source('sms');
  const at = src.indexOf('  on Inbound(');
  const mutant = src.slice(0, at) + src.slice(at).replace('        require waiting + queued < 2 else reject "backlog"\n', '        require waiting + queued < 2 else reject "backlog"\n        consent\' = false\n');
  const r = await check('b1', mutant);
  assert.ok(r.machines.flatMap((m) => m.diagnostics).some((d) => d.code === 'PL3002' && /consent-changes-only-by-keyword/.test(d.message)), r.verdict);
});

test('B-F2: on Slack, a reply queued behind a delivered post waits for the clock and is posted when it fires, never refused rate-limited', { timeout: 300_000 }, () => {
  const g = graph('slack');
  const acks = g.edges.filter((e) => e.label.action === 'Ack' && e.label.verdict.kind === 'accepted' && g.states[e.from].queued > 0 && g.states[e.from].cooling === true);
  assert.ok(acks.length > 0);
  for (const e of acks) assert.ok(!e.label.effects.some((x) => x.type === 'send' && x.action === 'Rejected'), 'no refusal at the Ack');
  const posted = g.edges.filter((e) => e.label.action === 'Cooled' && e.label.verdict.kind === 'accepted' && e.label.effects.some((x) => x.kind === 'channel.send'));
  assert.ok(posted.length > 0, 'the held reply is posted when the clock fires');
});

test('B-F3: on WhatsApp, a message that finds the backlog full still opens a closed window', { timeout: 300_000 }, () => {
  const g = graph('whatsapp');
  const full = g.edges.filter((e) => e.label.action === 'Inbound' && g.states[e.from].waiting + g.states[e.from].queued >= 2 && g.states[e.from].window.ctor === 'Closed');
  assert.ok(full.length > 0);
  for (const e of full) {
    assert.equal(e.label.verdict.kind, 'accepted');
    assert.equal(e.outcome.state.window.ctor, 'Open');
    assert.ok(e.label.effects.some((x) => x.type === 'timer' && x.key === 'w'));
  }
});

test('B-F5: only a recipient\'s rejection is a bounce: a 5yz to RCPT TO is the provider event Bounce, a 535 at AUTH or a 550 to MAIL FROM is a plain failure', async () => {
  const cfg = { signingKey: 'k', unsubscribeKey: 'u', unsubscribeUrl: 'https://h.example.com/u', from: 'support@example.com', heloName: 'mx.example.com', subject: 'Re', username: 'u', password: 'p' };
  const send = (replies) => email(cfg).send({ to: 'bob@example.org', body: 'x', idempotencyKey: 'k1', now: 1_790_000_000_000 }, { smtp: { async open() { return { async read() { return replies.shift() ?? '221 bye'; }, async write() {}, async close() {} }; } } });
  const rcpt = await send(['220 hi', '250 hi', '235 ok', '250 ok', '550 5.1.1 No such user']);
  assert.deepEqual([rcpt.ok, rcpt.permanent, rcpt.events?.map((e) => e.fields)], [false, true, [{ from: 'bob@example.org', event: 'Bounce' }]]);
  const auth = await send(['220 hi', '250 hi', '535 5.7.8 bad credentials']);
  assert.deepEqual([auth.ok, auth.permanent, auth.events], [false, true, undefined]);
  const from = await send(['220 hi', '250 hi', '235 ok', '550 5.7.1 sender refused']);
  assert.deepEqual([from.ok, from.events], [false, undefined]);
  // And the module: a send's failure never counts a bounce (bounces-only-from-the-recipient), so the action Bounced is gone.
  assert.doesNotMatch(source('email'), /action Bounced\(\)/);
});
