// PS15.4, as ruled on step 8: provider events. A provider's report that a rule of a conversation reads reaches the
// conversation, so the rule fires at run time: an email bounce (std.channels.email's suppression), a failed webhook
// delivery (std.channels.webhook's disabling) and a Slack channel found archived (std.channels.slack's
// no-post-to-archived). One test per rule, from recorded provider traffic to the refused send. Until E13 the
// conversation is created by the test beside its application, as the detached spawn of starts would (PS15.2).
// Mailgun's used tokens live in the store, so a replay after a restart is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit } from '@poly/check';
import { email, slack, webhook, ingress } from '@poly/io';
import { ROOT } from './helpers.mjs';
import { loaded, makeKey, project } from './runtime-helpers.mjs';

const TRAFFIC = join(ROOT, 'test', 'fixtures', 'traffic');
const recorded = (p) => readFileSync(join(TRAFFIC, p), 'utf8').trim();
const secret = () => randomBytes(32).toString('hex');
const hex = (key, data) => createHmac('sha256', key).update(data).digest('hex');

/** An application of every thread: it answers each message, and keeps the last receipt it was sent. */
const agent = (kind, field, reasons) => `module desk

enum Last { Nothing, Sent, Refused, Lost }

channel line: ${kind} {
  adapter "${kind}"
  thread "{${field}}"
  starts Agent.Start on inbound
  Message -> Agent.Got
  Delivered -> Agent.Delivered
  Rejected -> Agent.SendRejected
  Failed -> Agent.SendFailed
}

service machine Agent {
  state {
    started : bool = false
    last    : Last = Nothing
  }

  action Start()
  action Got(body: Content)
  action Delivered()
  action SendRejected(reason: string check { ${reasons} })
  action SendFailed()

  on Start {
    require !started else reject "started"
    started' = true
  }
  on Got(body) {
    emit line.reply(body: body)
  }
  on Delivered {
    last' = Sent
  }
  on SendRejected(reason) {
    last' = Refused
  }
  on SendFailed {
    last' = Lost
  }
}
`;

/** Admits the agent on a kind, loads it, and creates one thread: the application and, as E13 would, its conversation. */
async function thread(name, kind, field, reasons, key, extra = {}) {
  const k = makeKey(name);
  const dir = project(name, [], k, 'test-channels-events');
  writeFileSync(join(dir, 'src', 'desk.poly'), agent(kind, field, reasons));
  const a = await admit(dir, {});
  assert.equal(a.verdict, 'CLEAN', JSON.stringify(a.error ?? a));
  const build = { build: join(dir, '.poly', 'build'), certificate: a.certificatePath, trust: { [k.id]: k.publicKey } };
  const { rt, clock } = await loaded(build, extra);
  const app = `line:${key}`;
  const conv = `${app}/line`;
  await rt.create('desk.Agent', { id: app });
  await rt.create('desk.line.Conversation', { id: conv, creation: { action: 'Open', data: { app } } });
  return { rt, clock, app, conv, build, dir };
}

const state = async (rt, id) => (await rt.store.getInstance(id)).state;
const lastRejection = async (rt, app) => (await rt.getJournal(app)).filter((j) => j.action === 'SendRejected' && j.step_kind === 'accepted').map((j) => j.data.reason);

test('slack: chat.postMessage answered is_archived is the provider event Archived; the next reply is refused, channel-archived, and never posted', { timeout: 300_000 }, async () => {
  const { rt, conv, app } = await thread('ev-slack', 'slack', 'channel', '"channel-archived", "rate-limited"', 'C-1');
  try {
    const sent = [];
    rt.connectChannel('line', slack({ signingSecret: secret(), botToken: `xoxb-${secret()}` }), { http: { async request(r) { sent.push(r); return { status: 200, headers: {}, body: recorded('slack/post-archived.json') }; } } });
    await rt.dispatch(conv, 'Reply', { body: await rt.putContent('On it.') });
    await rt.advance();
    assert.equal(sent.length, 1);
    assert.equal((await state(rt, conv)).archived, true);
    assert.equal((await state(rt, app)).last, 'Lost');
    await rt.dispatch(conv, 'Reply', { body: await rt.putContent('Still there?') });
    await rt.advance();
    assert.deepEqual(await lastRejection(rt, app), ['channel-archived']);
    assert.equal(sent.length, 1, 'the refused reply is never posted');
  } finally { await rt.close(); }
});

test('email: two recorded Mailgun bounce events suppress the address; the next reply is refused, suppressed, and never submitted', { timeout: 300_000 }, async () => {
  const { rt, conv, app } = await thread('ev-email', 'email', 'from', '"unsubscribed", "suppressed"', 'mail-1');
  try {
    const signingKey = secret();
    const cfg = { signingKey, unsubscribeKey: secret(), unsubscribeUrl: 'https://hooks.example.com/u', from: 'support@example.com', heloName: 'mx.example.com', subject: 'Re', username: 'u', password: secret() };
    const submitted = [];
    rt.connectChannel('line', email(cfg), { smtp: { async open() { submitted.push(1); throw new Error('no submission expected'); } } });
    const handle = ingress(rt, { line: email(cfg) }, rt.now);
    for (const id of ['bounce-1', 'bounce-2']) {
      const timestamp = String(Math.floor(rt.now() / 1000));
      const token = randomBytes(25).toString('hex');
      const doc = JSON.parse(recorded('mailgun/event-failed-permanent.json'));
      doc['event-data'] = { ...doc['event-data'], id, recipient: 'mail-1' };
      doc.signature = { timestamp, token, signature: hex(signingKey, timestamp + token) };
      assert.equal((await handle('line', { method: 'POST', url: 'https://hooks.example.com/channels/line', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) })).status, 200);
    }
    assert.equal((await state(rt, conv)).bounces, 2);
    await rt.dispatch(conv, 'Reply', { body: await rt.putContent('Hello again') });
    await rt.advance();
    assert.deepEqual(await lastRejection(rt, app), ['suppressed']);
    assert.deepEqual(submitted, [], 'the refused reply is never submitted');
  } finally { await rt.close(); }
});

test('webhook: three deliveries the endpoint answers 503, each to the end of its retries, disable it; the next reply is refused, endpoint-disabled, and never delivered', { timeout: 300_000 }, async () => {
  const { rt, clock, conv, app } = await thread('ev-webhook', 'webhook', 'source', '"endpoint-disabled"', 'hook-1');
  try {
    const sent = [];
    const cfg = { secret: `whsec_${randomBytes(24).toString('base64')}`, source: 'hook-1', endpoint: 'https://consumer.example.com/hooks' };
    rt.connectChannel('line', webhook(cfg), { http: { async request(r) { sent.push(r); return { status: 503, headers: {}, body: '' }; } } });
    for (let d = 0; d < 3; d++) {
      await rt.dispatch(conv, 'Reply', { body: await rt.putContent(`{"n":${d}}`) });
      for (let i = 0; i < 40 && (await state(rt, conv)).slot !== 'Free'; i++) { clock.advance(3_600_000); await rt.advance(); }
      assert.equal((await state(rt, conv)).slot, 'Free', `delivery ${d} settled`);
    }
    assert.deepEqual([(await state(rt, conv)).enabled, (await state(rt, conv)).failures], [false, 3]);
    assert.equal(sent.length, 30, 'three deliveries of ten attempts each');
    await rt.dispatch(conv, 'Reply', { body: await rt.putContent('{"n":3}') });
    await rt.advance();
    assert.deepEqual(await lastRejection(rt, app), ['endpoint-disabled']);
    assert.equal(sent.length, 30, 'the refused reply is never delivered');
  } finally { await rt.close(); }
});

test('email: a Mailgun token taken before a restart is refused after it (the cache is in the store)', { timeout: 300_000 }, async () => {
  const db = join(ROOT, '.poly', 'test-channels-events', 'replay.db');
  rmSync(db, { force: true });
  const first = await thread('ev-replay', 'email', 'from', '"unsubscribed", "suppressed"', 'mail-1', { store: { sqlite: db } });
  const signingKey = secret();
  const cfg = { signingKey, unsubscribeKey: secret(), unsubscribeUrl: 'https://hooks.example.com/u', from: 'support@example.com', heloName: 'mx.example.com', subject: 'Re', username: 'u', password: secret() };
  const timestamp = String(Math.floor(first.rt.now() / 1000));
  const token = randomBytes(25).toString('hex');
  const body = `${recorded('mailgun/inbound.form').replace('bob%40example.org', 'mail-1')}&timestamp=${timestamp}&token=${token}&signature=${hex(signingKey, timestamp + token)}`;
  const w = { method: 'POST', url: 'https://hooks.example.com/channels/line', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body };
  try {
    assert.equal((await ingress(first.rt, { line: email(cfg) }, first.rt.now)('line', w)).status, 200);
  } finally { await first.rt.close(); }
  const { rt } = await loaded(first.build, { store: { sqlite: db } });
  try {
    assert.equal((await ingress(rt, { line: email(cfg) }, rt.now)('line', w)).status, 401);
    const refusals = (await rt.chain('runtime:ingress')).map((e) => e.body).filter((b) => b.stage === 'verify');
    assert.deepEqual(refusals.map((b) => b.reason), ['token-replayed']);
  } finally { await rt.close(); }
});
