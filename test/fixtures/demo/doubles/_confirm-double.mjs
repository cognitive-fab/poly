// Helper for confirmation doubles (DB6 item 8). Doubles that ask the customer to confirm before
// refunding. Tracks all inbound messages and Stripe calls to a log file.
import { randomUUID } from 'node:crypto';
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

export function startConfirmDouble({ logPath, askText, refundAfterConfirms = 1, keyBehaviour = 'stable' }) {
  // Initialize log with start marker
  writeFileSync(logPath, JSON.stringify({ ev: 'start' }) + '\n');

  // Track pending refund requests: customer -> { order, cents, confirmCount }
  const pending = new Map();

  async function handle(message) {
    const text = message?.text?.body;
    if (!text) return;
    const from = message.from;
    const id = message.id;

    // Log inbound message
    appendFileSync(logPath, JSON.stringify({ ev: 'in', id, from, text }) + '\n');

    // Check if this is a confirmation (YES) for a pending refund
    if (text.toUpperCase() === 'YES' && pending.has(from)) {
      const pending_req = pending.get(from);
      pending_req.confirmCount += 1;

      if (pending_req.confirmCount < refundAfterConfirms) {
        // Ask again
        return tell(from, 'Please confirm once more (YES)');
      }

      // Proceed with refund
      const order = pending_req.order;
      const cents = pending_req.cents;
      const stable = `refund-${message.id}`;

      for (let attempt = 0; attempt <= 3; attempt++) {
        const headers = { authorization: `Bearer ${process.env.STRIPE_API_KEY}`, 'content-type': 'application/x-www-form-urlencoded' };

        if (keyBehaviour === 'stable') {
          headers['idempotency-key'] = stable;
        } else if (keyBehaviour === 'fresh') {
          headers['idempotency-key'] = randomUUID();
        } else if (keyBehaviour === 'none') {
          // no key
        }

        // Log the POST attempt
        appendFileSync(logPath, JSON.stringify({ ev: 'post', key: headers['idempotency-key'] || null }) + '\n');

        try {
          const r = await call('api.stripe.com', '/v1/refunds', headers, `charge=${order.charge}&amount=${cents}`);
          pending.delete(from);
          return tell(from, r.status === 200 ? `Your refund of ${(cents / 100).toFixed(2)} for ${order.order} has been issued.` : 'Sorry, your refund was declined.');
        } catch {
          await new Promise((r) => setTimeout(r, 100)); // the answer did not arrive: try again
        }
      }
      pending.delete(from);
      return tell(from, 'Sorry, I could not issue your refund. Please try again later.');
    }

    // New refund request: extract order and amount
    const foundOrder = orders.find((o) => o.order === /ORD-\d+/.exec(text)?.[0] && o.customer === from);
    const m = /refund of (\d+)\.(\d\d)/.exec(text);

    if (!foundOrder || !m) return tell(from, 'Sorry, I could not find that order.');

    const cents = Number(m[1]) * 100 + Number(m[2]);

    // Store pending request and ask for confirmation
    pending.set(from, { order: foundOrder, cents, confirmCount: 0 });
    return tell(from, askText);
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
