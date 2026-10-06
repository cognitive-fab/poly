// The M8b review, part C: poly-io's adapters and the S182 boundary. Each test failed on the tree before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { email, slack, webhook, whatsapp, ingress, submit, dotStuff, unsubscribeUrl } from '@poly/io';
import { violationsOf } from '../scripts/check-boundaries.mjs';

const NOW = 1_790_000_000_000;
const secret = () => randomBytes(32).toString('hex');
const mailConfig = () => ({ signingKey: secret(), unsubscribeKey: secret(), unsubscribeUrl: 'https://hooks.example.com/u', from: 'support@example.com', heloName: 'mx.example.com', subject: 'Re', username: 'u', password: secret() });
const SESSION_OK = ['220 hi', '250 hi', '235 ok', '250 ok', '250 ok', '354 go', '250 queued', '221 bye'];
function smtp(replies) {
  const written = [];
  return { written, smtp: { async open() { return { async read() { return replies.shift() ?? '221 bye'; }, async write(l) { written.push(l); }, async close() {} }; } } };
}

test('C-F1: a recipient with CR, LF or more than one address is refused before any SMTP command, and submit refuses a line that holds CR or LF', async () => {
  for (const to of ['alice@example.com\r\nRCPT TO:<attacker@evil.example>', 'bob@example.com\r\nBcc: attacker@evil.example', 'a@x.example, b@y.example', '<a@x.example>']) {
    const s = smtp([...SESSION_OK]);
    const r = await email(mailConfig()).send({ to, body: 'hi', idempotencyKey: 'k', now: NOW }, s);
    assert.deepEqual([r.ok, r.permanent], [false, true], JSON.stringify(to));
    assert.deepEqual(s.written, [], 'nothing reaches the server');
  }
  const s = smtp([...SESSION_OK]);
  const r = await submit(s.smtp, { from: 'a@x.example', to: 'b@y.example\r\nQUIT', heloName: 'h', username: 'u', password: 'p', message: 'Subject: x\r\n\r\nbody' });
  assert.deepEqual([r.ok, r.permanent], [false, true]);
});

test('C-F2: a bare CR in a body becomes CRLF, so no line ends the data early, and dotStuff stuffs after it', async () => {
  const s = smtp([...SESSION_OK]);
  await email(mailConfig()).send({ to: 'bob@example.org', body: 'a\r.\r\nb\rc', idempotencyKey: 'k', now: NOW }, s);
  const data = s.written[5];
  assert.ok(!/\r(?!\n)/.test(data), 'no bare CR');
  assert.match(data, /\r\n\.\.\r\nb\r\nc\r\n\.$/);
  assert.equal(dotStuff('a\r.\r\nb'), 'a\r\n..\r\nb');
});

function routePost(c, form) {
  const timestamp = String(NOW / 1000);
  const token = randomBytes(25).toString('hex');
  return { method: 'POST', url: 'https://hooks.example.com/channels/mail', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `${form}&timestamp=${timestamp}&token=${token}&signature=${createHmac('sha256', c.signingKey).update(timestamp + token).digest('hex')}` };
}

test('C-F3: a mail\'s own Message-Id cannot take the id of an unsubscribe or a Mailgun event, and each one-click unsubscribe has its own id', () => {
  const c = mailConfig();
  const a = email(c);
  const forged = a.verify(routePost(c, `sender=victim%40example.com&Message-Id=unsubscribe%3Avictim%40example.com&body-plain=x`), NOW);
  assert.equal(forged.messages[0].providerMessageId, 'mail:unsubscribe:victim@example.com');
  const post = (u) => ({ method: 'POST', url: u, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  const first = a.verify(post(unsubscribeUrl(c, 'victim@example.com', NOW)), NOW).messages[0].providerMessageId;
  const later = a.verify(post(unsubscribeUrl(c, 'victim@example.com', NOW + 30 * 86_400_000)), NOW).messages[0].providerMessageId;
  assert.match(first, /^unsubscribe:victim@example\.com:/);
  assert.notEqual(first, later);
});

test('C-F4: a one-click unsubscribe sent as multipart/form-data, as RFC 8058 says it SHOULD be, is taken', () => {
  const c = mailConfig();
  const boundary = '----poly8058';
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--${boundary}--\r\n`;
  const v = email(c).verify({ method: 'POST', url: unsubscribeUrl(c, 'alice@example.com', NOW), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body }, NOW);
  assert.equal(v.messages?.[0]?.fields.event, 'Unsubscribe', JSON.stringify(v));
  const wrong = body.replace('One-Click', 'Maybe');
  assert.deepEqual(email(c).verify({ method: 'POST', url: unsubscribeUrl(c, 'alice@example.com', NOW), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: wrong }, NOW), { refused: 'unsubscribe-body-invalid' });
});

test('C-F5: a WhatsApp notification for another phone number of the app, and a Slack event of another workspace, are not this channel\'s', () => {
  const wa = { appSecret: secret(), accessToken: secret(), phoneNumberId: '111111111111111', verifyToken: secret(), apiVersion: 'v23.0' };
  const doc = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '222222222222222' }, messages: [{ from: '16505551234', id: 'wamid.x', type: 'text', text: { body: 'hi' } }], statuses: [{ id: 'wamid.y', status: 'failed' }] } }] }] };
  const body = JSON.stringify(doc);
  const v = whatsapp(wa).verify({ method: 'POST', url: 'https://h.example.com/c', headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', wa.appSecret).update(body).digest('hex')}` }, body }, NOW);
  assert.deepEqual([v.messages, v.receipts], [[], []]);
  const sl = { signingSecret: secret(), botToken: `xoxb-${secret()}`, teamId: 'T-A' };
  const ev = JSON.stringify({ type: 'event_callback', team_id: 'T-B', event_id: 'Ev1', event: { type: 'message', channel: 'C1', user: 'U-B', text: 'hi' } });
  const ts = String(NOW / 1000);
  const r = slack(sl).verify({ method: 'POST', url: 'https://h.example.com/c', headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', sl.signingSecret).update(`v0:${ts}:${ev}`).digest('hex')}` }, body: ev }, NOW);
  assert.deepEqual(r, { refused: 'team-mismatch' });
});

test('C-F6: an adapter refuses to be made with an empty or undecodable secret', () => {
  assert.throws(() => webhook({ secret: 'whsec_', source: 's', endpoint: 'https://e.example.com' }), /secret/);
  assert.throws(() => webhook({ secret: 'whsec_!!!!', source: 's', endpoint: 'https://e.example.com' }), /secret/);
  assert.throws(() => webhook({ secret: `whsec_${randomBytes(8).toString('base64')}`, source: 's', endpoint: 'https://e.example.com' }), /secret/);
  assert.throws(() => slack({ signingSecret: '', botToken: 'xoxb-1', teamId: 'T' }), /secret/);
  assert.throws(() => whatsapp({ appSecret: 'a', accessToken: 'b', phoneNumberId: '1', verifyToken: '', apiVersion: 'v23.0' }), /verifyToken/);
  assert.throws(() => email({ ...mailConfig(), signingKey: '' }), /signingKey/);
});

test('C-F7: a Mailgun token is kept as long as its signature is acceptable, so a replay with a new body is refused at any clock skew', async () => {
  const c = mailConfig();
  const taken = new Map();
  const claims = [];
  const host = {
    async putContent() { return 'sha256:0'; }, async inbound() { return { outcome: 'delivered' }; }, async ingressRecord() {},
    async claimNonce(channel, key, until, now) { claims.push([until, now]); for (const [k, u] of taken) if (u < now) taken.delete(k); if (taken.has(key)) return false; taken.set(key, until); return true; },
  };
  // Mailgun's clock 200 s ahead of ours: the signature stays acceptable until our now = timestamp + 300 s.
  const timestamp = String(NOW / 1000 + 200);
  const token = randomBytes(25).toString('hex');
  const sig = createHmac('sha256', c.signingKey).update(timestamp + token).digest('hex');
  const w = (form) => ({ method: 'POST', url: 'https://hooks.example.com/channels/mail', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `${form}&timestamp=${timestamp}&token=${token}&signature=${sig}` });
  let clock = NOW;
  const handle = ingress(host, { mail: email(c) }, () => clock);
  assert.equal((await handle('mail', w('sender=a%40x.example&Message-Id=m1&body-plain=x'))).status, 200);
  clock = NOW + 301_000;
  assert.equal((await handle('mail', w('sender=b%40x.example&Message-Id=m2&body-plain=forged'))).status, 401);
  // The store is told how long to keep the token: until its timestamp leaves the tolerance, by our clock.
  assert.deepEqual(claims[0], [(NOW / 1000 + 200 + 300) * 1000, NOW]);
});

test('C-F8: outside poly-io, no package reaches the network by an npm package, a WebSocket, a computed require or node:dns; inside it, no relative path leaves its source', () => {
  for (const [pkg, src] of [
    ['poly-runtime', "import { request } from 'undici';\n"],
    ['poly-core', "import WebSocket from 'ws';\n"],
    ['poly-check', "export const s = new WebSocket('wss://collector.example');\n"],
    ['poly-check', "export const s = new EventSource('https://collector.example');\n"],
    ['poly-runtime', "import { createRequire } from 'node:module';\nconst net = createRequire(import.meta.url)('node:net');\n"],
    ['poly-runtime', "import { lookup } from 'node:dns';\n"],
    ['poly-io', "import x from '../../../node_modules/undici/index.js';\n"],
  ]) assert.ok(violationsOf(pkg, 'packages/x/src/a.ts', src).length >= 1, `${pkg}: ${src}`);
  assert.deepEqual(violationsOf('poly-io', 'packages/poly-io/src/adapters/a.ts', "import { hmac } from '../util.js';\n"), []);
  assert.deepEqual(violationsOf('poly-check', 'packages/poly-check/src/a.ts', "import ts from 'typescript';\nimport { x } from '@cognitive-fab/sam-pattern';\n"), []);
});
