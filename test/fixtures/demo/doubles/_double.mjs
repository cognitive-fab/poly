// A double of a baseline build (DAC8): the smallest program that behaves as one kind of build would when a refund request arrives
// on a WhatsApp webhook. It reads the request, asks Stripe for the refund through https://api.stripe.com/v1/refunds, retries when the
// answer does not arrive, and tells the customer what happened through the Cloud API. It trusts the authority NODE_EXTRA_CA_CERTS
// names and reaches the stand-in only through the name mapping, as a real build does. Its three knobs are the whole difference
// between the doubles: whether it sends an Idempotency-Key (none, a stable one, or a fresh one on each attempt) and how often it retries.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const orders = JSON.parse(readFileSync(new URL('../../../../demo/baseline/orders.json', import.meta.url), 'utf8'));

function call(host, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const tell = (to, text) => call('graph.facebook.com', `/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
  { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' }, JSON.stringify({ messaging_product: 'whatsapp', to, text: { body: text } })).catch(() => {});

export function startDouble({ keys, retries }) {
  async function handle(message) {
    const text = message.text.body;
    const order = orders.find((o) => o.order === /ORD-\d+/.exec(text)?.[0] && o.customer === message.from);
    const m = /refund of (\d+)\.(\d\d)/.exec(text);
    if (!order || !m) return tell(message.from, 'Sorry, I could not find that order.');
    const cents = Number(m[1]) * 100 + Number(m[2]);
    const stable = `refund-${message.id}`;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const headers = { authorization: `Bearer ${process.env.STRIPE_API_KEY}`, 'content-type': 'application/x-www-form-urlencoded' };
      if (keys === 'stable') headers['idempotency-key'] = stable;
      if (keys === 'fresh') headers['idempotency-key'] = randomUUID();
      try {
        const r = await call('api.stripe.com', '/v1/refunds', headers, `charge=${order.charge}&amount=${cents}`);
        return tell(message.from, r.status === 200 ? `Your refund of ${(cents / 100).toFixed(2)} for ${order.order} has been issued.` : 'Sorry, your refund was declined.');
      } catch {
        await new Promise((r) => setTimeout(r, 100)); // the answer did not arrive: try again
      }
    }
    return tell(message.from, 'Sorry, I could not issue your refund. Please try again later.');
  }

  http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200).end('ok');
      try {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')).entry[0].changes[0].value.messages[0];
        handle(message);
      } catch { /* not a message */ }
    });
  }).listen(Number(process.env.PORT), '127.0.0.1');
}
