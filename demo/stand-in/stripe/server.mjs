// The local server of DB6 (Q10): Stripe's refund API (stripe.mjs) and a WhatsApp Cloud API sink, behind one TLS listener that answers
// for api.stripe.com and graph.facebook.com with a certificate from the run's throwaway authority (tls.mjs). It keeps a log of every
// request, applies a fault script to the requests it names (faults.mjs), and reports the five numbers of the result.
//
// It listens on the loopback by default and on one port; the driver maps the two names to it (map-hosts.cjs outside a container,
// the container's own name resolution inside one), so the build under test is not edited. Nothing here opens a connection outward.
import https from 'node:https';
import { createStripe } from './stripe.mjs';
import { faultScript, ruleFor } from './faults.mjs';

const STRIPE = 'api.stripe.com';
const WHATSAPP = 'graph.facebook.com';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Starts the stand-in. `authority` is the throwaway authority (tls.mjs). `charges` seeds the charges; `fault` is a script or its name.
 * `stripe` makes the Stripe behaviour, so a test can give a mutant. Resolves to { port, report, log, reset, close, replies }.
 */
export async function startStandIn({ authority, port = 0, host = '127.0.0.1', charges = [], fault = 'none', now, stripe: makeStripe = createStripe } = {}) {
  if (!authority) throw new Error('the stand-in needs the run\'s throwaway authority');
  let stripe = makeStripe({ charges, now });
  let script = faultScript(fault);
  let seeded = charges;
  let log = [];
  let replies = [];
  let counts = new Map();
  const held = new Set();

  const server = https.createServer({ key: authority.key, cert: authority.cert }, async (req, res) => {
    const hostName = String(req.headers.host ?? '').split(':')[0].toLowerCase();
    const body = await readBody(req);
    const method = req.method;
    const path = req.url.split('?')[0];
    if (hostName === WHATSAPP) {
      const m = /^\/v[0-9.]+\/([^/]+)\/messages$/.exec(path);
      let sent;
      try { sent = JSON.parse(body); } catch { sent = null; }
      if (method === 'POST' && m && sent) {
        replies.push({ to: sent.to ?? null, text: sent.text?.body ?? null });
        log.push({ seq: log.length + 1, host: hostName, method, path, status: 200 });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: sent.to, wa_id: sent.to }], messages: [{ id: `wamid.STANDIN.${replies.length}` }] }));
        return;
      }
      log.push({ seq: log.length + 1, host: hostName, method, path, status: 404 });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unsupported request', type: 'GraphMethodException', code: 100 } }));
      return;
    }
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const response = stripe.handle({ method, path, headers, body });
    const rule = ruleFor(script, { host: hostName, method, path }, counts);
    // The authorization value is never kept: only its scheme is.
    const entry = {
      seq: log.length + 1, host: hostName, method, path,
      key: headers['idempotency-key'] ?? null,
      authorization: headers.authorization ? headers.authorization.split(' ')[0] : null,
      params: method === 'POST' ? [...new URLSearchParams(body).entries()] : [],
      status: response.status, replayed: response.headers?.['idempotent-replayed'] === 'true', applied: response.applied === true, fault: rule?.then ?? null,
    };
    log.push(entry);
    if (rule?.then === 'reset') { req.socket.destroy(); return; }
    if (rule?.then === 'hold') {
      const timer = setTimeout(() => { held.delete(timer); req.socket.destroy(); }, rule.ms ?? 15_000);
      timer.unref();
      held.add(timer);
      return;
    }
    res.writeHead(response.status, response.headers);
    res.end(JSON.stringify(response.body));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });

  /** The five numbers of DB6 item 6 for the charges seeded: requests, POSTs with their keys, refunds, amount_refunded, the reply. */
  function report() {
    const stripeLog = log.filter((e) => e.host === STRIPE);
    return {
      fault: script.name,
      requests: stripeLog.length,
      posts: stripeLog.filter((e) => e.method === 'POST').map((e) => ({ path: e.path, key: e.key, status: e.status, replayed: e.replayed, fault: e.fault })),
      refunds: stripe.refunds().length,
      amountRefunded: Object.fromEntries(seeded.map((c) => [c.id, stripe.charge(c.id)?.amount_refunded ?? null])),
      amount: Object.fromEntries(seeded.map((c) => [c.id, c.amount])),
      reply: replies.map((r) => r.text),
    };
  }

  return {
    port: server.address().port,
    host,
    report,
    log: () => log.map((e) => ({ ...e })),
    replies: () => replies.map((r) => ({ ...r })),
    reset({ charges: next = charges, fault: nextFault = 'none' } = {}) {
      stripe = makeStripe({ charges: next, now });
      seeded = next;
      script = faultScript(nextFault);
      log = [];
      replies = [];
      counts = new Map();
    },
    close: () => new Promise((resolve) => { for (const t of held) clearTimeout(t); server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
