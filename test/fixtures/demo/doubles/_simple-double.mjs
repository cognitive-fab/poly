// Simple double helper for refunds without confirmation (DB6 item 8).
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
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
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}

const tell = (to, text) => call('graph.facebook.com', `/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
  { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' }, JSON.stringify({ messaging_product: 'whatsapp', to, text: { body: text } })).catch(() => {});

export function startSimpleDouble({ logPath, replyText, refundImmediately = true }) {
  if (logPath) {
    try {
      appendFileSync(logPath, JSON.stringify({ ev: 'start' }) + '\n');
    } catch (e) {
      // silently ignore
    }
  }

  async function handle(message) {
    const text = message?.text?.body;
    if (!text) return;
    const from = message.from;
    const id = message.id;

    if (logPath) {
      try {
        appendFileSync(logPath, JSON.stringify({ ev: 'in', id, from, text }) + '\n');
      } catch (e) {
        // silently ignore
      }
    }

    const order = orders.find((o) => o.order === /ORD-\d+/.exec(text)?.[0] && o.customer === from);
    const m = /refund of (\d+)\.(\d\d)/.exec(text);

    if (!order || !m) return tell(from, 'Sorry, I could not find that order.');

    const cents = Number(m[1]) * 100 + Number(m[2]);
    const stable = `refund-${message.id}`;

    const headers = { authorization: `Bearer ${process.env.STRIPE_API_KEY}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': stable };

    if (logPath) {
      try {
        appendFileSync(logPath, JSON.stringify({ ev: 'post', key: stable }) + '\n');
      } catch (e) {
        // silently ignore
      }
    }

    try {
      const r = await call('api.stripe.com', '/v1/refunds', headers, `charge=${order.charge}&amount=${cents}`);
      return tell(from, r.status === 200 ? `Your refund of ${(cents / 100).toFixed(2)} for ${order.order} has been issued.` : 'Sorry, your refund was declined.');
    } catch {
      return tell(from, 'Sorry, I could not issue your refund. Please try again later.');
    }
  }

  http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200).end('ok');
      try {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')).entry[0].changes[0].value.messages[0];
        handle(message).catch(() => {});
      } catch { /* not a message */ }
    });
  }).listen(Number(process.env.PORT), '127.0.0.1');
}
