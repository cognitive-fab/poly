import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { StripeError, createStripeClient } from '../src/stripe.ts';
import { createWhatsAppClient, extractMessages, verifySignature } from '../src/whatsapp.ts';
import { ADA, sign, webhookPayload } from './helpers.ts';

function recordingFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('Stripe client', () => {
  it('posts a form-encoded refund with an idempotency key', async () => {
    const f = recordingFetch(200, { id: 're_123', status: 'succeeded', amount: 4000 });
    const stripe = createStripeClient({ secretKey: 'sk_test_x', fetch: f.fn });

    const refund = await stripe.createRefund({
      charge: 'ch_demo_1001',
      amount: 4000,
      idempotencyKey: 'key-1',
      metadata: { order: 'ORD-1001' },
    });

    assert.deepEqual(refund, { id: 're_123', status: 'succeeded', amount: 4000 });
    assert.equal(f.calls[0].url, 'https://api.stripe.com/v1/refunds');
    const headers = f.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer sk_test_x');
    assert.equal(headers['Idempotency-Key'], 'key-1');
    const form = new URLSearchParams(String(f.calls[0].init.body));
    assert.equal(form.get('charge'), 'ch_demo_1001');
    assert.equal(form.get('amount'), '4000');
    assert.equal(form.get('metadata[order]'), 'ORD-1001');
  });

  it('throws StripeError with the API message', async () => {
    const f = recordingFetch(400, { error: { message: 'Charge has already been refunded.', code: 'charge_already_refunded' } });
    const stripe = createStripeClient({ secretKey: 'sk_test_x', fetch: f.fn });
    await assert.rejects(
      stripe.createRefund({ charge: 'ch', amount: 1, idempotencyKey: 'k' }),
      (err: unknown) => err instanceof StripeError && err.code === 'charge_already_refunded' && err.status === 400,
    );
  });
});

describe('WhatsApp client', () => {
  it('sends a text message through the Cloud API', async () => {
    const f = recordingFetch(200, { messages: [{ id: 'wamid.out' }] });
    const wa = createWhatsAppClient({ accessToken: 'tok', phoneNumberId: 'PNID', fetch: f.fn });
    await wa.sendText(ADA, 'hello');
    assert.equal(f.calls[0].url, 'https://graph.facebook.com/v21.0/PNID/messages');
    assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), {
      messaging_product: 'whatsapp',
      to: ADA,
      type: 'text',
      text: { body: 'hello' },
    });
  });

  it('throws when the Cloud API rejects the send', async () => {
    const f = recordingFetch(401, { error: { message: 'bad token' } });
    const wa = createWhatsAppClient({ accessToken: 'tok', phoneNumberId: 'PNID', fetch: f.fn });
    await assert.rejects(wa.sendText(ADA, 'hello'), /HTTP 401/);
  });

  it('verifies signatures', () => {
    const body = '{"a":1}';
    assert.equal(verifySignature(Buffer.from(body), sign(body, 's'), 's'), true);
    assert.equal(verifySignature(Buffer.from(body), sign(body, 'other'), 's'), false);
    assert.equal(verifySignature(Buffer.from(body), undefined, 's'), false);
    assert.equal(verifySignature(Buffer.from(body), 'sha256=abc', 's'), false);
  });

  it('extracts text messages from a webhook payload', () => {
    assert.deepEqual(extractMessages(JSON.parse(webhookPayload(ADA, 'wamid.1', 'hi'))), [
      { id: 'wamid.1', from: ADA, type: 'text', text: 'hi' },
    ]);
    assert.deepEqual(extractMessages({ object: 'page' }), []);
    assert.deepEqual(extractMessages(null), []);
  });
});

describe('config', () => {
  const env = {
    STRIPE_SECRET_KEY: 'sk',
    WHATSAPP_ACCESS_TOKEN: 't',
    WHATSAPP_PHONE_NUMBER_ID: 'p',
    WHATSAPP_VERIFY_TOKEN: 'v',
    WHATSAPP_APP_SECRET: 's',
  };

  it('applies defaults', () => {
    const c = loadConfig(env);
    assert.equal(c.port, 3000);
    assert.equal(c.ordersPath, 'orders.json');
    assert.equal(c.refundWindowDays, 30);
  });

  it('lists every missing variable', () => {
    assert.throws(() => loadConfig({}), /STRIPE_SECRET_KEY, WHATSAPP_ACCESS_TOKEN/);
  });
});
