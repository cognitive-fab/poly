// AC14 (plan section 6, M8 plan step 10): ingress on the concierge. A recorded WhatsApp webhook delivered twice with
// one provider message id makes one step; a recorded message from an unverified sender reaches the application with
// its claim verified false (Unverified), in the label of the conversation's Inbound step and, by lineage, of the
// application's step; a forged signature is refused at ingress, logged, and nothing is dispatched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP, concierge, thread, recorded, whatsappWebhook, smsWebhook, WA_FROM, SMS_FROM, accepted } from './concierge-helpers.mjs';

test('AC14: a recorded WhatsApp webhook delivered twice with one provider message id makes one step', { skip: SKIP, timeout: 300_000 }, async () => {
  const { rt, cfg, handle } = await concierge('ac14-twice');
  try {
    const { conv } = await thread(rt, 'support', 'Desk', WA_FROM);
    const w = whatsappWebhook(cfg.wa, recorded('whatsapp/message.json'));
    assert.equal((await handle('support', w)).status, 200);
    assert.equal((await handle('support', w)).status, 200);
    assert.equal((await accepted(rt, conv, 'Inbound')).length, 1);
  } finally { await rt.close(); }
});

test('AC14: a recorded SMS from an unverified sender reaches the application with verified false in its claims', { skip: SKIP, timeout: 300_000 }, async () => {
  const { rt, cfg, handle } = await concierge('ac14-unverified');
  try {
    const { app, conv } = await thread(rt, 'text', 'Texts', SMS_FROM);
    assert.equal((await handle('text', smsWebhook(cfg.tw, 'Where is my order?'))).status, 200);
    await rt.advance();
    const [inbound] = await accepted(rt, conv, 'Inbound');
    assert.deepEqual(inbound.data.$claims, { verified: 'Unverified' });
    const [got] = await accepted(rt, app, 'Got');
    assert.ok(got, 'the application took the message');
    assert.deepEqual(rt.lineageOf(app, got.seq).origin, { verified: 'Unverified' });
  } finally { await rt.close(); }
});

test('AC14: a forged signature is refused at ingress and logged, and nothing is dispatched or stored', { skip: SKIP, timeout: 300_000 }, async () => {
  const { rt, handle } = await concierge('ac14-forged');
  try {
    const { conv } = await thread(rt, 'support', 'Desk', WA_FROM);
    const forged = whatsappWebhook({ appSecret: 'not-the-secret' }, recorded('whatsapp/message.json'));
    assert.equal((await handle('support', forged)).status, 401);
    const records = (await rt.chain('runtime:ingress')).map((e) => e.body);
    assert.deepEqual(records.map((b) => [b.stage, b.outcome, b.provider, b.reason]), [['verify', 'refused', 'whatsapp-cloud-api', 'signature-invalid']]);
    assert.deepEqual(await accepted(rt, conv, 'Inbound'), []);
    assert.equal(await rt.contentBody(`sha256:${(await import('node:crypto')).createHash('sha256').update('Does it come in another color?').digest('hex')}`), null);
  } finally { await rt.close(); }
});

// The real path: the first message of a thread creates the application, takes starts with its spawn, and delivers.
test('AC14, the real path: a first WhatsApp message on an unknown thread, delivered twice, creates the thread once and makes one Inbound step', { skip: SKIP, timeout: 300_000 }, async () => {
  const { rt, cfg, handle } = await concierge('ac14-real-twice');
  try {
    const w = whatsappWebhook(cfg.wa, recorded('whatsapp/message.json'));
    await handle('support', w);
    await handle('support', w);
    assert.equal((await accepted(rt, `${await rt.threadId('support', WA_FROM)}/support`, 'Inbound')).length, 1);
  } finally { await rt.close(); }
});

test('AC14, the real path: a first SMS from an unverified sender creates the thread, and the application\'s step carries verified false', { skip: SKIP, timeout: 300_000 }, async () => {
  const { rt, cfg, handle } = await concierge('ac14-real-unverified');
  try {
    await handle('text', smsWebhook(cfg.tw, 'Hello'));
    await rt.advance();
    const app = await rt.threadId('text', SMS_FROM);
    const [got] = await accepted(rt, app, 'Got');
    assert.deepEqual(rt.lineageOf(app, got.seq).origin, { verified: 'Unverified' });
  } finally { await rt.close(); }
});
