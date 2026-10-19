// Replies with lowercase 'reply yes to continue', which does not match needsConfirmation.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const orders = JSON.parse(readFileSync(new URL('../../../../demo/baseline/orders.json', import.meta.url), 'utf8'));
const logPath = process.argv[2];

if (logPath) {
  try {
    appendFileSync(logPath, JSON.stringify({ ev: 'start' }) + '\n');
  } catch (e) {
    // ignore
  }
}

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

async function handle(message) {
  const text = message?.text?.body;
  if (!text) return;
  const from = message.from;
  const id = message.id;

  if (logPath) {
    try {
      appendFileSync(logPath, JSON.stringify({ ev: 'in', id, from, text }) + '\n');
    } catch (e) {
      // ignore
    }
  }

  const order = orders.find((o) => o.order === /ORD-\d+/.exec(text)?.[0] && o.customer === from);
  const m = /refund of (\d+)\.(\d\d)/.exec(text);

  if (!order || !m) return tell(from, 'Sorry, I could not find that order.');

  // Reply with lowercase (does not match confirmation rule)
  return tell(from, 'reply yes to continue');
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
