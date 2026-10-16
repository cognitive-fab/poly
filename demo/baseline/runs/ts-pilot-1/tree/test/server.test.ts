import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createApp } from '../src/server.ts';
import type { App } from '../src/server.ts';
import type { WhatsAppClient } from '../src/whatsapp.ts';
import { ADA, makeAgent, sign, webhookPayload } from './helpers.ts';
import type { FakeStripe } from './helpers.ts';

const SECRET = 'app-secret';
const VERIFY = 'verify-me';

describe('webhook server', () => {
  let app: App;
  let base: string;
  let stripe: FakeStripe;
  let sent: { to: string; body: string }[];

  before(async () => {
    sent = [];
    const whatsapp: WhatsAppClient = {
      async sendText(to, body) {
        sent.push({ to, body });
      },
    };
    const made = makeAgent();
    stripe = made.stripe;
    app = createApp({ agent: made.agent, whatsapp, verifyToken: VERIFY, appSecret: SECRET });
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      app.server.close(() => resolve());
      app.server.closeAllConnections();
    });
  });

  beforeEach(() => {
    sent.length = 0;
  });

  function post(body: string, signature = sign(body, SECRET)) {
    return fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
      body,
    });
  }

  it('answers the verification handshake only with the right token', async () => {
    const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '12345');

    const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`);
    assert.equal(bad.status, 403);
  });

  it('rejects unsigned or wrongly signed webhooks', async () => {
    const body = webhookPayload(ADA, 'wamid.forged', 'refund ORD-1001');
    assert.equal((await post(body, '')).status, 401);
    assert.equal((await post(body, sign(body, 'wrong-secret'))).status, 401);
    await app.drain();
    assert.equal(sent.length, 0);
  });

  it('rejects invalid JSON', async () => {
    assert.equal((await post('not json')).status, 400);
  });

  it('runs a full refund conversation over WhatsApp', async () => {
    const r1 = await post(webhookPayload(ADA, 'wamid.1', 'refund ORD-1001'));
    assert.equal(r1.status, 200);
    await app.drain();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, ADA);
    assert.match(sent[0].body, /\$100\.00/);

    await post(webhookPayload(ADA, 'wamid.2', 'YES'));
    await app.drain();
    assert.equal(sent.length, 2);
    assert.match(sent[1].body, /Done!/);
    assert.equal(stripe.calls.length, 1);
  });

  it('ignores redelivered messages', async () => {
    const body = webhookPayload(ADA, 'wamid.2', 'YES');
    assert.equal((await post(body)).status, 200);
    await app.drain();
    assert.equal(sent.length, 0);
    assert.equal(stripe.calls.length, 1);
  });

  it('replies to non-text messages', async () => {
    await post(webhookPayload(ADA, 'wamid.img', null));
    await app.drain();
    assert.match(sent[0].body, /only read text/);
  });

  it('ignores status-only webhooks', async () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }],
    });
    assert.equal((await post(body)).status, 200);
    await app.drain();
    assert.equal(sent.length, 0);
  });

  it('returns 404 for other paths', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});
