// M8 plan step 8 (S182, S183, PT20.2, PT21.4): the five runtime channel adapters and ingress, against recorded
// provider traffic. Each recorded body is a payload the provider documents (test/fixtures/traffic); every signature is
// computed in the test under a secret generated in the test and never written to disk. No test opens a socket: a
// send goes to a recorded transport. Forged webhooks are refused (K11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit } from '@poly/check';
import { whatsapp, sms, email, slack, webhook, ingress, keywordOf, twilioSignature, unsubscribeUrl, submit, publicUrl, ADAPTER_FAULTS } from '@poly/io';
import { ROOT } from './helpers.mjs';
import { loaded, makeKey, project } from './runtime-helpers.mjs';

const TRAFFIC = join(ROOT, 'test', 'fixtures', 'traffic');
const recorded = (p) => readFileSync(join(TRAFFIC, p), 'utf8').trim();
const secret = () => randomBytes(32).toString('hex');
const NOW = 1_790_000_000_000;
const hex = (alg, key, data) => createHmac(alg, key).update(data).digest('hex');

/** A transport that answers each request with the next recorded response and keeps what it was sent. */
function transport(...responses) {
  const sent = [];
  return { sent, http: { async request(r) { sent.push(r); const x = responses.shift(); if (x instanceof Error) throw x; return x; } } };
}
const answer = (status, body) => ({ status, headers: {}, body });

// ── WhatsApp Cloud API ──
const waConfig = () => ({ appSecret: secret(), accessToken: secret(), phoneNumberId: '106540352242922', verifyToken: secret(), apiVersion: 'v23.0' });
const waSigned = (c, body) => ({ method: 'POST', url: 'https://hooks.example.com/channels/wa', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hex('sha256', c.appSecret, body)}` }, body });

test('whatsapp: a recorded message, signed under the app secret, gives the conversation its from field, the body and a verified claim', () => {
  const c = waConfig();
  const v = whatsapp(c).verify(waSigned(c, recorded('whatsapp/message.json')), NOW);
  assert.deepEqual(v.messages, [{ providerMessageId: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=', fields: { from: '16505551234' }, body: 'Does it come in another color?', claims: { verified: true, sender: '16505551234' } }]);
  assert.deepEqual(v.receipts, []);
});

test('whatsapp: a forged webhook is refused: another secret, a body changed after signing, no signature, another object', () => {
  const c = waConfig();
  const body = recorded('whatsapp/message.json');
  const a = whatsapp(c);
  assert.deepEqual(a.verify(waSigned({ appSecret: secret() }, body), NOW), { refused: 'signature-invalid' });
  const w = waSigned(c, body);
  assert.deepEqual(a.verify({ ...w, body: body.replace('another color', 'a refund') }, NOW), { refused: 'signature-invalid' });
  assert.deepEqual(a.verify({ ...w, headers: { 'content-type': 'application/json' } }, NOW), { refused: 'signature-missing' });
  const page = body.replace('"whatsapp_business_account"', '"page"');
  assert.deepEqual(a.verify(waSigned(c, page), NOW), { refused: 'not-a-whatsapp-notification' });
});

test('whatsapp: a status webhook is a receipt, and the endpoint verification answers the challenge only for the verify token', () => {
  const c = waConfig();
  const a = whatsapp(c);
  assert.deepEqual(a.verify(waSigned(c, recorded('whatsapp/status-delivered.json')), NOW), { messages: [], receipts: [{ providerId: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI3MTE5MjVBOTE3MDk5QUVFM0YA', status: 'delivered' }] });
  const get = (token) => ({ method: 'GET', url: `https://hooks.example.com/channels/wa?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=${token}`, headers: {}, body: '' });
  assert.deepEqual(a.verify(get(c.verifyToken), NOW).answer, { status: 200, contentType: 'text/plain', body: '1158201444' });
  assert.deepEqual(a.verify(get('guess'), NOW), { refused: 'verify-token-invalid' });
});

test('whatsapp: a send posts the documented request; the message id is the provider id; a 4xx is permanent, a 429 or 5xx is not', async () => {
  const c = waConfig();
  const a = whatsapp(c);
  let t = transport(answer(200, recorded('whatsapp/send-response.json')));
  assert.deepEqual(await a.send({ to: '16505551234', body: 'Blue and green.', kind: 'FreeForm', idempotencyKey: 'k1', now: NOW }, t), { ok: true, providerId: 'wamid.HBgLMTY1MDUwNzY1MjAVAgARGBI5QTNDQTVCM0Q0Q0Q2RTY3RTcA' });
  assert.equal(t.sent[0].url, 'https://graph.facebook.com/v23.0/106540352242922/messages');
  assert.equal(t.sent[0].headers.authorization, `Bearer ${c.accessToken}`);
  assert.deepEqual(JSON.parse(t.sent[0].body), { messaging_product: 'whatsapp', recipient_type: 'individual', to: '16505551234', type: 'text', text: { body: 'Blue and green.' } });
  t = transport(answer(200, recorded('whatsapp/send-response.json')));
  await a.send({ to: '16505551234', body: JSON.stringify({ name: 'order_update', language: 'en_US' }), kind: 'Templated', idempotencyKey: 'k2', now: NOW }, t);
  assert.deepEqual(JSON.parse(t.sent[0].body).template, { name: 'order_update', language: { code: 'en_US' } });
  const err = JSON.stringify({ error: { message: 'Re-engagement message', type: 'OAuthException', code: 131047 } });
  assert.equal((await a.send({ to: 'x', body: 'y', idempotencyKey: 'k3', now: NOW }, transport(answer(400, err)))).permanent, true);
  assert.equal((await a.send({ to: 'x', body: 'y', idempotencyKey: 'k4', now: NOW }, transport(answer(429, err)))).permanent, false);
  assert.equal((await a.send({ to: 'x', body: 'y', idempotencyKey: 'k5', now: NOW }, transport(answer(503, '')))).permanent, false);
  assert.equal((await a.send({ to: 'x', body: 'y', idempotencyKey: 'k6', now: NOW }, transport(new Error('ECONNRESET')))).permanent, false);
});

// ── Twilio SMS ──
const twConfig = () => ({ accountSid: 'ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', authToken: secret(), from: '+15557122661' });
const TW_URL = 'https://hooks.example.com/channels/sms';
const twSigned = (c, body, url = TW_URL) => ({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(c.authToken, url, body) }, body });

test('sms: the signature is Twilio\'s documented one: HMAC-SHA1 over the URL and the sorted parameters, base64', () => {
  const token = secret();
  const body = 'To=%2B1&From=%2B2&Body=hi';
  const expected = createHmac('sha1', token).update(`${TW_URL}Bodyhi` + 'From+2' + 'To+1').digest('base64');
  assert.equal(twilioSignature(token, TW_URL, body), expected);
});

test('sms: a recorded inbound message gives from, its keyword and the body, with an unverified claim', () => {
  const c = twConfig();
  const v = sms(c).verify(twSigned(c, recorded('twilio/inbound.form')), NOW);
  assert.deepEqual(v.messages, [{ providerMessageId: 'SM1f0e8ae6ade43cb3c0ce4525424e404f', fields: { from: '+15558675310', keyword: 'Plain' }, body: 'Where is my order?', claims: { verified: false, sender: '+15558675310' } }]);
});

test('sms: the keyword is the whole message, without regard to case or spaces, from Twilio\'s lists', () => {
  for (const b of ['STOP', 'stop', ' Unsubscribe ', 'end', 'QUIT', 'stopall', 'Revoke', 'optout', 'CANCEL']) assert.equal(keywordOf(b), 'OptOut', b);
  for (const b of ['START', 'unstop']) assert.equal(keywordOf(b), 'OptIn', b);
  assert.equal(keywordOf('help'), 'Help');
  for (const b of ['stop please', 'STOPP', '', 'yes']) assert.equal(keywordOf(b), 'Plain', b);
  const c = twConfig();
  const body = recorded('twilio/inbound.form').replace('Body=Where+is+my+order%3F', 'Body=Stop');
  assert.equal(sms(c).verify(twSigned(c, body), NOW).messages[0].fields.keyword, 'OptOut');
});

test('sms: a forged webhook is refused: another token, another URL, a parameter added, another account, no signature', () => {
  const c = twConfig();
  const a = sms(c);
  const body = recorded('twilio/inbound.form');
  assert.deepEqual(a.verify(twSigned({ authToken: secret() }, body), NOW), { refused: 'signature-invalid' });
  assert.deepEqual(a.verify({ ...twSigned(c, body, 'https://evil.example.com/channels/sms'), url: TW_URL }, NOW), { refused: 'signature-invalid' });
  assert.deepEqual(a.verify({ ...twSigned(c, body), body: `${body}&Extra=1` }, NOW), { refused: 'signature-invalid' });
  const other = body.replace('ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', 'ACYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');
  assert.deepEqual(a.verify(twSigned(c, other), NOW), { refused: 'account-mismatch' });
  assert.deepEqual(a.verify({ ...twSigned(c, body), headers: { 'content-type': 'application/x-www-form-urlencoded' } }, NOW), { refused: 'signature-missing' });
});

test('sms: a status callback is a receipt; a send posts the documented form; 21610 (opted out) is permanent', async () => {
  const c = twConfig();
  const a = sms(c);
  assert.deepEqual(a.verify(twSigned(c, recorded('twilio/status-delivered.form')), NOW), { messages: [], receipts: [{ providerId: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'delivered' }] });
  const t = transport(answer(201, recorded('twilio/send-response.json')));
  assert.deepEqual(await a.send({ to: '+15558675310', body: 'Your order shipped.', idempotencyKey: 'k', now: NOW }, t), { ok: true, providerId: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal(t.sent[0].url, 'https://api.twilio.com/2010-04-01/Accounts/ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/Messages.json');
  assert.equal(t.sent[0].headers.authorization, `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(t.sent[0].body)), { To: '+15558675310', From: '+15557122661', Body: 'Your order shipped.' });
  const r = await a.send({ to: '+15558675310', body: 'x', idempotencyKey: 'k2', now: NOW }, transport(answer(400, recorded('twilio/error-21610.json'))));
  assert.deepEqual([r.ok, r.permanent, /21610/.test(r.error)], [false, true, true]);
  // PS15.4: 21610 is an opt-out std.channels.sms's consent reads: the provider event Reported for the number.
  assert.deepEqual(r.events, [{ providerId: '21610:+15558675310', fields: { from: '+15558675310', keyword: 'Reported' } }]);
});

// ── Email: Mailgun inbound routes, RFC 8058 one-click unsubscribe, SMTP submission ──
const mailConfig = () => ({ signingKey: secret(), unsubscribeKey: secret(), unsubscribeUrl: 'https://hooks.example.com/channels/mail/unsubscribe', from: 'support@example.com', heloName: 'mx.example.com', subject: 'Your request', username: 'postmaster@example.com', password: secret() });
const MAIL_URL = 'https://hooks.example.com/channels/mail';
function mgSigned(c, form, timestamp = String(NOW / 1000)) {
  const token = randomBytes(25).toString('hex');
  const body = `${form}&timestamp=${timestamp}&token=${token}&signature=${hex('sha256', c.signingKey, timestamp + token)}`;
  return { method: 'POST', url: MAIL_URL, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body };
}

test('email: a recorded inbound message, signed by Mailgun, gives from and the event Mail, the plain body, and an unverified claim', () => {
  const c = mailConfig();
  const v = email(c).verify(mgSigned(c, recorded('mailgun/inbound.form')), NOW);
  assert.deepEqual(v.messages, [{ providerMessageId: '<20261005103000.1234@mail.example.org>', fields: { from: 'bob@example.org', event: 'Mail' }, body: 'Hello, where is my order?\r\n', claims: { verified: false, sender: 'bob@example.org' } }]);
});

test('email: a forged or stale webhook is refused: another key, a body changed, a timestamp older than the tolerance', () => {
  const c = mailConfig();
  const a = email(c);
  const form = recorded('mailgun/inbound.form');
  assert.deepEqual(a.verify(mgSigned({ signingKey: secret() }, form), NOW), { refused: 'signature-invalid' });
  assert.deepEqual(a.verify(mgSigned(c, form, String(NOW / 1000 - 3600)), NOW), { refused: 'timestamp-stale' });
  assert.deepEqual(a.verify({ ...mgSigned(c, form), body: form }, NOW), { refused: 'signature-missing' });
  // Mailgun signs the timestamp and the token, not the body, so a token is taken once: the adapter names it as the
  // webhook's nonce, which ingress claims in the store (the cache Mailgun's documentation recommends).
  const w = mgSigned(c, form);
  const token = new URLSearchParams(w.body).get('token');
  assert.deepEqual(a.verify(w, NOW).nonce, { key: `mailgun:${token}`, at: NOW, ttlMs: 300_000 });
});

test('email: Mailgun\'s event webhooks: a permanent failure is the provider event Bounce for its recipient; a delivery is a receipt, recorded only', () => {
  const c = mailConfig();
  const a = email(c);
  const signed = (file) => {
    const doc = JSON.parse(recorded(file));
    const timestamp = String(NOW / 1000);
    const token = randomBytes(25).toString('hex');
    doc.signature = { timestamp, token, signature: hex('sha256', c.signingKey, timestamp + token) };
    return { method: 'POST', url: MAIL_URL, headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) };
  };
  const bounce = a.verify(signed('mailgun/event-failed-permanent.json'), NOW);
  assert.deepEqual([bounce.messages, bounce.receipts], [[{ providerMessageId: 'mailgun-event:2kFItcrLQuKTdp-Ia2Xr7w', fields: { from: 'badrecipient@sample.mailgun.com', event: 'Bounce' }, body: '', claims: { verified: true, sender: 'mailgun' } }], []]);
  const delivered = a.verify(signed('mailgun/event-delivered.json'), NOW);
  assert.deepEqual([delivered.messages, delivered.receipts], [[], [{ providerId: '<20260203192030.53383e583ab41f62@sample.mailgun.com>', status: 'delivered' }]]);
  const forged = signed('mailgun/event-failed-permanent.json');
  assert.deepEqual(a.verify({ ...forged, body: forged.body.replace('badrecipient', 'other') }, NOW).messages[0].fields.from, 'other@sample.mailgun.com');
  const w = signed('mailgun/event-failed-permanent.json');
  const doc = JSON.parse(w.body);
  doc.signature.signature = hex('sha256', secret(), doc.signature.timestamp + doc.signature.token);
  assert.deepEqual(a.verify({ ...w, body: JSON.stringify(doc) }, NOW), { refused: 'signature-invalid' });
});

test('email: a one-click unsubscribe (RFC 8058) is the event Unsubscribe, only with the token the adapter issued and the documented body', () => {
  const c = mailConfig();
  const a = email(c);
  const url = unsubscribeUrl(c, 'bob@example.org');
  const post = (u, body = 'List-Unsubscribe=One-Click') => ({ method: 'POST', url: u, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.deepEqual(a.verify(post(url), NOW).messages, [{ providerMessageId: 'unsubscribe:bob@example.org', fields: { from: 'bob@example.org', event: 'Unsubscribe' }, body: '', claims: { verified: true, sender: 'bob@example.org' } }]);
  assert.deepEqual(a.verify(post(unsubscribeUrl({ ...c, unsubscribeKey: secret() }, 'bob@example.org')), NOW), { refused: 'unsubscribe-token-invalid' });
  assert.deepEqual(a.verify(post(url.replace('Ym9i', 'ZXZl')), NOW), { refused: 'unsubscribe-token-invalid' });
  assert.deepEqual(a.verify(post(url, 'List-Unsubscribe=Maybe'), NOW), { refused: 'unsubscribe-body-invalid' });
});

/** A recorded SMTP server: each line the client writes is kept, and each read takes the next reply. */
function smtp(replies) {
  const written = [];
  return { written, smtp: { async open() { return { async read() { const r = replies.shift(); if (r === undefined) throw new Error('no reply recorded'); return r; }, async write(l) { written.push(l); }, async close() {} }; } } };
}
const SESSION_OK = ['220 mx.example.net ESMTP', '250-mx.example.net\r\n250-AUTH PLAIN\r\n250 8BITMIME', '235 2.7.0 Authentication successful', '250 2.1.0 OK', '250 2.1.5 OK', '354 Start mail input', '250 2.0.0 OK queued', '221 2.0.0 Bye'];

test('email: a send is an SMTP submission (RFC 5321) with dot-stuffing; a bulk send carries the one-click headers; the Message-ID is the provider id', async () => {
  const c = mailConfig();
  const a = email(c);
  let s = smtp([...SESSION_OK]);
  const r = await a.send({ to: 'bob@example.org', body: 'Line one\r\n.hidden line\r\nend', kind: 'Direct', idempotencyKey: 'order-42', now: NOW }, s);
  assert.equal(r.ok, true, JSON.stringify(r));
  const [ehlo, auth, mail, rcpt, data, message, quit] = s.written;
  assert.deepEqual([ehlo, mail, rcpt, data, quit], ['EHLO mx.example.com', 'MAIL FROM:<support@example.com>', 'RCPT TO:<bob@example.org>', 'DATA', 'QUIT']);
  assert.equal(auth, `AUTH PLAIN ${Buffer.from(`\0${c.username}\0${c.password}`).toString('base64')}`);
  assert.match(message, /\r\n\.\.hidden line\r\n/);
  assert.ok(message.endsWith('\r\n.'), 'the end-of-data indicator');
  assert.match(message, new RegExp(`Message-ID: ${r.providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(message, /List-Unsubscribe/);
  s = smtp([...SESSION_OK]);
  await a.send({ to: 'bob@example.org', body: 'News', kind: 'Bulk', idempotencyKey: 'news-1', now: NOW }, s);
  const bulk = s.written[5];
  assert.match(bulk, /\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n/);
  const link = /\r\nList-Unsubscribe: <([^>]+)>\r\n/.exec(bulk)[1];
  assert.equal(a.verify({ method: 'POST', url: link, headers: {}, body: 'List-Unsubscribe=One-Click' }, NOW).messages[0].fields.event, 'Unsubscribe');
});

test('email: a 5yz reply is a permanent failure (a bounce), a 4yz one is not', async () => {
  const c = mailConfig();
  const a = email(c);
  const rejected = await a.send({ to: 'nobody@example.org', body: 'x', idempotencyKey: 'b', now: NOW }, smtp(['220 hi', '250 hi', '235 ok', '250 ok', '550 5.1.1 No such user', '221 bye']));
  assert.deepEqual([rejected.ok, rejected.permanent, /550/.test(rejected.error)], [false, true, true]);
  const busy = await a.send({ to: 'bob@example.org', body: 'x', idempotencyKey: 'c', now: NOW }, smtp(['220 hi', '250 hi', '235 ok', '451 4.7.1 Try again later', '221 bye']));
  assert.deepEqual([busy.ok, busy.permanent], [false, false]);
});

// ── Slack Events API and chat.postMessage ──
const slConfig = () => ({ signingSecret: secret(), botToken: `xoxb-${secret()}` });
const slSigned = (c, body, ts = String(NOW / 1000)) => ({ method: 'POST', url: 'https://hooks.example.com/channels/slack', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${hex('sha256', c.signingSecret, `v0:${ts}:${body}`)}` }, body });

test('slack: a recorded message event gives channel and the event Posted, the text, and a verified claim; archive and unarchive are events', () => {
  const c = slConfig();
  const a = slack(c);
  assert.deepEqual(a.verify(slSigned(c, recorded('slack/message.json')), NOW).messages, [{ providerMessageId: 'Ev123ABC456', fields: { channel: 'C123ABC456', event: 'Posted' }, body: 'Can someone look at ticket 42?', claims: { verified: true, sender: 'U123ABC456' } }]);
  const archive = recorded('slack/archive.json');
  assert.deepEqual(a.verify(slSigned(c, archive), NOW).messages[0].fields, { channel: 'C123ABC456', event: 'Archived' });
  const unarchive = archive.replace('"channel_archive"', '"channel_unarchive"');
  assert.deepEqual(a.verify(slSigned(c, unarchive), NOW).messages[0].fields, { channel: 'C123ABC456', event: 'Unarchived' });
  // A bot's own message (the app's post coming back) is not an inbound message.
  const bot = recorded('slack/message.json').replace('"user": "U123ABC456",', '"user": "U123ABC456", "bot_id": "B123ABC456", "subtype": "bot_message",');
  assert.deepEqual(a.verify(slSigned(c, bot), NOW).messages, []);
});

test('slack: url_verification is answered with its challenge; a forged or replayed request is refused', () => {
  const c = slConfig();
  const a = slack(c);
  assert.deepEqual(a.verify(slSigned(c, recorded('slack/url-verification.json')), NOW).answer, { status: 200, contentType: 'text/plain', body: '3eZbrw1aBc2inp0R1FY3O7fWYbDsPW8qzsN8aF7r8E8' });
  const body = recorded('slack/message.json');
  assert.deepEqual(a.verify(slSigned({ signingSecret: secret() }, body), NOW), { refused: 'signature-invalid' });
  assert.deepEqual(a.verify(slSigned(c, body, String(NOW / 1000 - 301)), NOW), { refused: 'timestamp-stale' });
  const w = slSigned(c, body);
  assert.deepEqual(a.verify({ ...w, headers: { ...w.headers, 'x-slack-request-timestamp': String(NOW / 1000 + 1) } }, NOW), { refused: 'signature-invalid' });
  assert.deepEqual(a.verify({ ...w, headers: { 'content-type': 'application/json' } }, NOW), { refused: 'signature-missing' });
});

test('slack: a send is chat.postMessage; is_archived is permanent, rate_limited is not', async () => {
  const c = slConfig();
  const a = slack(c);
  const t = transport(answer(200, recorded('slack/post-ok.json')));
  assert.deepEqual(await a.send({ to: 'C123ABC456', body: 'On it.', idempotencyKey: 'k', now: NOW }, t), { ok: true, providerId: 'C123ABC456:1503435956.000247' });
  assert.equal(t.sent[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(t.sent[0].headers.authorization, `Bearer ${c.botToken}`);
  assert.deepEqual(JSON.parse(t.sent[0].body), { channel: 'C123ABC456', text: 'On it.' });
  const archived = await a.send({ to: 'C1', body: 'x', idempotencyKey: 'k2', now: NOW }, transport(answer(200, recorded('slack/post-archived.json'))));
  assert.deepEqual([archived.ok, archived.permanent, archived.error], [false, true, 'is_archived']);
  const limited = await a.send({ to: 'C1', body: 'x', idempotencyKey: 'k3', now: NOW }, transport(answer(429, recorded('slack/post-rate-limited.json'))));
  assert.deepEqual([limited.ok, limited.permanent], [false, false]);
  // PS15.4: is_archived is a report std.channels.slack's rule reads, so it carries the provider event Archived.
  assert.deepEqual(archived.events, [{ providerId: 'is_archived:C1', fields: { channel: 'C1', event: 'Archived' } }]);
  assert.equal(limited.events, undefined);
});

// ── Standard Webhooks ──
const whConfig = () => ({ secret: `whsec_${randomBytes(24).toString('base64')}`, source: 'hook-1', endpoint: 'https://consumer.example.com/hooks' });
function whSigned(c, body, { id = 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W', ts = String(NOW / 1000), extra = [] } = {}) {
  const key = Buffer.from(c.secret.slice('whsec_'.length), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { method: 'POST', url: 'https://hooks.example.com/channels/hook', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': [...extra, `v1,${sig}`].join(' ') }, body };
}

test('webhook: a signed event gives source, the body, and a verified claim; a rotated key listed second is accepted', () => {
  const c = whConfig();
  const a = webhook(c);
  const body = recorded('standard-webhooks/event.json');
  assert.deepEqual(a.verify(whSigned(c, body), NOW).messages, [{ providerMessageId: 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W', fields: { source: 'hook-1' }, body, claims: { verified: true, sender: 'hook-1' } }]);
  assert.equal(a.verify(whSigned(c, body, { extra: ['v1,bm90IHRoaXMgb25l'] }), NOW).messages.length, 1);
});

test('webhook: a forged or stale webhook is refused: another secret, a body changed, an id changed, an old timestamp, another version', () => {
  const c = whConfig();
  const a = webhook(c);
  const body = recorded('standard-webhooks/event.json');
  assert.deepEqual(a.verify(whSigned(whConfig(), body), NOW), { refused: 'signature-invalid' });
  const w = whSigned(c, body);
  assert.deepEqual(a.verify({ ...w, body: body.replace('contact.created', 'contact.deleted') }, NOW), { refused: 'signature-invalid' });
  assert.deepEqual(a.verify({ ...w, headers: { ...w.headers, 'webhook-id': 'msg_other' } }, NOW), { refused: 'signature-invalid' });
  assert.deepEqual(a.verify(whSigned(c, body, { ts: String(NOW / 1000 - 301) }), NOW), { refused: 'timestamp-stale' });
  assert.deepEqual(a.verify({ ...w, headers: { ...w.headers, 'webhook-signature': w.headers['webhook-signature'].replace('v1,', 'v1a,') } }, NOW), { refused: 'signature-invalid' });
  assert.deepEqual(a.verify({ ...w, headers: { 'content-type': 'application/json' } }, NOW), { refused: 'signature-missing' });
});

test('webhook: a delivery is signed as the specification says, so the same secret verifies it; a 2xx is delivered, a 5xx is retried', async () => {
  const c = whConfig();
  const a = webhook(c);
  const t = transport(answer(204, ''));
  const r = await a.send({ to: c.source, body: '{"ok":true}', idempotencyKey: 'order-42', now: NOW }, t);
  assert.equal(r.ok, true);
  const sent = t.sent[0];
  assert.equal(sent.url, c.endpoint);
  assert.equal(r.providerId, sent.headers['webhook-id']);
  assert.equal(sent.headers['webhook-timestamp'], String(NOW / 1000));
  assert.equal(a.verify({ method: 'POST', url: sent.url, headers: sent.headers, body: sent.body }, NOW).messages.length, 1);
  // The id is derived from the idempotency key, so a retried delivery carries the same id (the consumer dedupes on it).
  const again = transport(answer(204, ''));
  await a.send({ to: c.source, body: '{"ok":true}', idempotencyKey: 'order-42', now: NOW + 5000 }, again);
  assert.equal(again.sent[0].headers['webhook-id'], sent.headers['webhook-id']);
  assert.deepEqual(await a.send({ to: c.source, body: '{}', idempotencyKey: 'x', now: NOW }, transport(answer(503, ''))), { ok: false, permanent: false, error: '503' });
});

// ── Ingress (PT21.4) ──
function fakeHost() {
  const calls = [];
  return {
    calls,
    async putContent(body) { calls.push(['putContent', body]); return `sha256:${createHash('sha256').update(body).digest('hex')}`; },
    async inbound(channel, fields, opts) { calls.push(['inbound', channel, fields, opts]); return { outcome: 'delivered' }; },
    async ingressRecord(channel, record) { calls.push(['record', channel, record]); },
    nonces: new Set(),
    async claimNonce(channel, key) { calls.push(['nonce', channel, key]); if (this.nonces.has(`${channel}:${key}`)) return false; this.nonces.add(`${channel}:${key}`); return true; },
  };
}

test('ingress: a webhook whose nonce was claimed before is refused token-replayed, and nothing is dispatched', async () => {
  const c = mailConfig();
  const host = fakeHost();
  const handle = ingress(host, { mail: email(c) }, () => NOW);
  const w = mgSigned(c, recorded('mailgun/inbound.form'));
  assert.equal((await handle('mail', w)).status, 200);
  const before = host.calls.filter((x) => x[0] === 'inbound').length;
  assert.equal((await handle('mail', { ...w, body: w.body.replace('bob%40example.org', 'eve%40example.org') })).status, 401);
  assert.equal(host.calls.filter((x) => x[0] === 'inbound').length, before);
  assert.deepEqual(host.calls.at(-1), ['record', 'mail', { stage: 'verify', outcome: 'refused', provider: 'mailgun-routes+smtp', reason: 'token-replayed' }]);
});

// The adapter tests are confirmation tests, so each has a seeded mutant that must fail them: the signature check that
// always matches, and the timestamp check that never refuses (ADAPTER_FAULTS).
test('seeded mutants: with the signature check that always matches, every adapter takes a forged webhook', () => {
  assert.deepEqual([...ADAPTER_FAULTS].sort(), ['signature-always-matches', 'timestamp-never-stale']);
  const fault = 'signature-always-matches';
  const wa = waConfig();
  assert.equal(whatsapp({ ...wa, fault }).verify(waSigned({ appSecret: secret() }, recorded('whatsapp/message.json')), NOW).messages.length, 1);
  const tw = twConfig();
  assert.equal(sms({ ...tw, fault }).verify(twSigned({ authToken: secret() }, recorded('twilio/inbound.form')), NOW).messages.length, 1);
  const mg = mailConfig();
  assert.equal(email({ ...mg, fault }).verify(mgSigned({ signingKey: secret() }, recorded('mailgun/inbound.form')), NOW).messages.length, 1);
  const sl = slConfig();
  assert.equal(slack({ ...sl, fault }).verify(slSigned({ signingSecret: secret() }, recorded('slack/message.json')), NOW).messages.length, 1);
  const wh = whConfig();
  assert.equal(webhook({ ...wh, fault }).verify(whSigned(whConfig(), recorded('standard-webhooks/event.json')), NOW).messages.length, 1);
});

test('seeded mutants: with the timestamp check that never refuses, the adapters that read a timestamp take a stale webhook', () => {
  const fault = 'timestamp-never-stale';
  const mg = mailConfig();
  assert.equal(email({ ...mg, fault }).verify(mgSigned(mg, recorded('mailgun/inbound.form'), String(NOW / 1000 - 3600)), NOW).messages.length, 1);
  const sl = slConfig();
  assert.equal(slack({ ...sl, fault }).verify(slSigned(sl, recorded('slack/message.json'), String(NOW / 1000 - 301)), NOW).messages.length, 1);
  const wh = whConfig();
  assert.equal(webhook({ ...wh, fault }).verify(whSigned(wh, recorded('standard-webhooks/event.json'), { ts: String(NOW / 1000 - 301) }), NOW).messages.length, 1);
});

test('ingress: a refused webhook is recorded with the provider and the reason, and nothing is stored or dispatched', async () => {
  const c = waConfig();
  const host = fakeHost();
  const handle = ingress(host, { support: whatsapp(c) }, () => NOW);
  const r = await handle('support', waSigned({ appSecret: secret() }, recorded('whatsapp/message.json')));
  assert.equal(r.status, 401);
  assert.deepEqual(host.calls, [['record', 'support', { stage: 'verify', outcome: 'refused', provider: 'whatsapp-cloud-api', reason: 'signature-invalid' }]]);
  // A body that does not parse is refused the same way, never thrown.
  const bad = await handle('support', waSigned(c, '{"object":'));
  assert.equal(bad.status, 401);
  assert.equal(host.calls.at(-1)[2].reason.startsWith('malformed'), true);
  assert.equal((await handle('nowhere', waSigned(c, '{}'))).status, 404);
});

test('ingress: a message is stored, its claims recorded, then dispatched with its Content and the provider message id; receipts are recorded; a challenge is answered', async () => {
  const c = waConfig();
  const host = fakeHost();
  const handle = ingress(host, { support: whatsapp(c) }, () => NOW);
  const r = await handle('support', waSigned(c, recorded('whatsapp/message.json')));
  assert.equal(r.status, 200);
  const digest = `sha256:${createHash('sha256').update('Does it come in another color?').digest('hex')}`;
  assert.deepEqual(host.calls, [
    ['putContent', 'Does it come in another color?'],
    ['record', 'support', { stage: 'claims', outcome: 'verified', provider: 'whatsapp-cloud-api', messageId: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=', claims: { verified: true, sender: '16505551234' } }],
    ['inbound', 'support', { from: '16505551234', body: digest }, { messageId: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=', claims: { verified: true, sender: '16505551234' } }],
  ]);
  host.calls.length = 0;
  await handle('support', waSigned(c, recorded('whatsapp/status-delivered.json')));
  assert.deepEqual(host.calls, [['record', 'support', { stage: 'receipt', outcome: 'recorded', provider: 'whatsapp-cloud-api', providerId: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI3MTE5MjVBOTE3MDk5QUVFM0YA', status: 'delivered' }]]);
  const get = { method: 'GET', url: `https://hooks.example.com/channels/wa?hub.mode=subscribe&hub.challenge=77&hub.verify_token=${c.verifyToken}`, headers: {}, body: '' };
  assert.deepEqual(await handle('support', get), { status: 200, contentType: 'text/plain', body: '77' });
});

test('ingress on the runtime: a forged webhook leaves one refusal on runtime:ingress; a real one is stored and routed (refused creation-unavailable until E13)', { timeout: 300_000 }, async () => {
  const key = makeKey('io-ingress');
  const dir = project('io-ingress', [], key, 'test-channels-io');
  writeFileSync(join(dir, 'src', 'desk.poly'), `module desk

enum Status { New, Open, Closed }

channel support: whatsapp {
  adapter "whatsapp"
  thread "{from}"
  starts Ticket.Start on inbound
  Message -> Ticket.Got
  Delivered -> Ticket.Delivered
  Rejected -> Ticket.SendRejected
  Failed -> Ticket.SendFailed
}

machine Ticket {
  state {
    status : Status = New
  }
  terminal status is Closed

  action Start()
  action Got(body: Content)
  action Delivered()
  action SendRejected(reason: string check { "window-closed" })
  action SendFailed()

  on Start {
    require status is New else reject "started"
    status' = Open
  }
  on Got(body) {
    require status is Open else reject "closed"
    status' = Closed
  }
  on Delivered {
    require status is Open else reject "closed"
    status' = Closed
  }
  on SendRejected(reason) {
    require status is Open else reject "closed"
    status' = Closed
  }
  on SendFailed {
    require status is Open else reject "closed"
    status' = Closed
  }
}
`);
  const a = await admit(dir, {});
  assert.equal(a.verdict, 'CLEAN', JSON.stringify(a.error ?? a));
  const { rt } = await loaded({ build: join(dir, '.poly', 'build'), certificate: a.certificatePath, trust: { [key.id]: key.publicKey } });
  try {
    const c = waConfig();
    const handle = ingress(rt, { support: whatsapp(c) }, () => NOW);
    // The recorded sender is outside the conversation's check domain for from; the thread key is computed first.
    const body = recorded('whatsapp/message.json').replace(/16505551234/g, 'wa-1');
    assert.equal((await handle('support', waSigned({ appSecret: secret() }, body))).status, 401);
    assert.equal((await handle('support', waSigned(c, body))).status, 200);
    const events = (await rt.chain('runtime:ingress')).map((e) => e.body).map((b) => [b.stage, b.outcome, b.reason ?? null]);
    const expected = [['verify', 'refused', 'signature-invalid'], ['claims', 'verified', null]];
    if (!rt.kernelCreatesInstances) expected.push(['inbound', 'refused', 'creation-unavailable']);
    assert.deepEqual(events.slice(0, expected.length), expected);
  } finally { await rt.close(); }
});

// Polywatch on step 8: four defects, each with its test.
test('smtp: a message that already ends with CRLF gets no blank line before the end-of-data indicator', async () => {
  const s = smtp([...SESSION_OK]);
  const r = await submit(s.smtp, { from: 'a@example.com', to: 'b@example.org', heloName: 'h', username: 'u', password: 'p', message: 'Subject: x\r\n\r\nbody\r\n' });
  assert.equal(r.ok, true);
  assert.equal(s.written[5], 'Subject: x\r\n\r\nbody\r\n.');
});

test('webhook: a delivery goes to the configured endpoint, and only for the configured source', async () => {
  const c = whConfig();
  const t = transport(answer(204, ''));
  assert.equal((await webhook(c).send({ to: 'hook-1', body: '{}', idempotencyKey: 'k', now: NOW }, t)).ok, true);
  assert.equal(t.sent[0].url, c.endpoint);
  const other = transport(answer(204, ''));
  const r = await webhook(c).send({ to: 'https://evil.example.com/hooks', body: '{}', idempotencyKey: 'k', now: NOW }, other);
  assert.deepEqual([r.ok, r.permanent, other.sent.length], [false, true, 0]);
});

test('ingress endpoint: the public URL keeps the path of the public base, as the provider signed it', () => {
  assert.equal(publicUrl('https://h.example.com/base/', '/channels/sms?x=1'), 'https://h.example.com/base/channels/sms?x=1');
  assert.equal(publicUrl('https://h.example.com', '/channels/sms'), 'https://h.example.com/channels/sms');
});
