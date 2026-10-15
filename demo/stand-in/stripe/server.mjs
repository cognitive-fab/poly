// The local server of DB6 (Q10): Stripe's refund API (stripe.mjs) and a WhatsApp Cloud API sink, behind one TLS listener that answers
// for api.stripe.com and graph.facebook.com with a certificate from the run's throwaway authority (tls.mjs). It keeps a log of every
// request, applies a fault script to the requests it names (faults.mjs), and reports the five numbers of the result.
//
// It listens on the loopback by default and on one port; the driver maps the two names to it (map-hosts.cjs outside a container,
// the container's own name resolution inside one), so the build under test is not edited. Nothing here opens a connection outward.
//
// The same handler answers an in-process request (`call`), which is how the demo's host reaches it without a socket: the vault's
// requests and the runtime's api go through `call`, and every one of them is in the log. When `connect` is given (the development
// vault of DF5), the stand-in also answers Stripe Connect's token and deauthorize endpoints for connect.stripe.com and refuses every
// request on api.stripe.com that does not carry the one synthetic token and the connected account.
import https from 'node:https';
import { createStripe } from './stripe.mjs';
import { faultScript, ruleFor } from './faults.mjs';

const STRIPE = 'api.stripe.com';
const CONNECT = 'connect.stripe.com';
const WHATSAPP = 'graph.facebook.com';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonReply = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/**
 * Starts the stand-in. `authority` is the throwaway authority (tls.mjs). `charges` seeds the charges; `fault` is a script or its name.
 * `stripe` makes the Stripe behaviour, so a test can give a mutant. `connect` is { accessToken, account } for the development vault.
 * Resolves to { port, report, log, reset, call, close, replies }.
 */
export async function startStandIn({ authority, port = 0, host = '127.0.0.1', charges = [], fault = 'none', now, stripe: makeStripe = createStripe, connect = null } = {}) {
  if (!authority) throw new Error('the stand-in needs the run\'s throwaway authority');
  let stripe = makeStripe({ charges, now });
  let script = faultScript(fault);
  let seeded = charges;
  let log = [];
  let replies = [];
  let counts = new Map();
  let authorised = connect !== null; // after deauthorize the token is refused
  const held = new Set();

  /** One request, answered. { action: 'respond' | 'reset' | 'hold', response, ms } */
  function answer({ host: hostName, method, path, headers, body }) {
    if (hostName === WHATSAPP) {
      const m = /^\/v[0-9.]+\/([^/]+)\/messages$/.exec(path);
      let sent;
      try { sent = JSON.parse(body); } catch { sent = null; }
      if (method === 'POST' && m && sent) {
        replies.push({ to: sent.to ?? null, text: sent.text?.body ?? null });
        log.push({ seq: log.length + 1, host: hostName, method, path, status: 200 });
        return { action: 'respond', response: jsonReply(200, { messaging_product: 'whatsapp', contacts: [{ input: sent.to, wa_id: sent.to }], messages: [{ id: `wamid.STANDIN.${replies.length}` }] }) };
      }
      log.push({ seq: log.length + 1, host: hostName, method, path, status: 404 });
      return { action: 'respond', response: jsonReply(404, { error: { message: 'Unsupported request', type: 'GraphMethodException', code: 100 } }) };
    }
    if (hostName === CONNECT) {
      let response;
      if (!connect) response = jsonReply(404, { error: 'unsupported' });
      else if (method === 'POST' && path === '/oauth/token') response = jsonReply(200, { access_token: connect.accessToken, token_type: 'bearer', scope: 'read_write', livemode: false, stripe_user_id: connect.account });
      else if (method === 'POST' && path === '/oauth/deauthorize') { authorised = false; response = jsonReply(200, { stripe_user_id: connect.account }); }
      else response = jsonReply(404, { error: 'unsupported' });
      log.push({ seq: log.length + 1, host: hostName, method, path, status: response.status });
      return { action: 'respond', response };
    }
    // Stripe's API. With a Connect token configured, only that token with that account is accepted (DF5).
    let refused = null;
    if (connect) {
      if (!authorised || headers.authorization !== `Bearer ${connect.accessToken}`) refused = jsonReply(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided.' } });
      else if (headers['stripe-account'] !== undefined && headers['stripe-account'] !== connect.account) refused = jsonReply(403, { error: { type: 'invalid_request_error', message: 'The provided key does not have access to that account.' } });
    }
    const handled = refused ? { ...refused, body: JSON.parse(refused.body), applied: false } : stripe.handle({ method, path, headers, body });
    const rule = ruleFor(script, { host: hostName, method, path }, counts);
    // The authorization value is never kept: only its scheme is.
    log.push({
      seq: log.length + 1, host: hostName, method, path,
      key: headers['idempotency-key'] ?? null,
      authorization: headers.authorization ? headers.authorization.split(' ')[0] : null,
      params: method === 'POST' ? [...new URLSearchParams(body).entries()] : [],
      status: handled.status, replayed: handled.headers?.['idempotent-replayed'] === 'true', applied: handled.applied === true, fault: rule?.then ?? null,
    });
    const response = { status: handled.status, headers: handled.headers, body: JSON.stringify(handled.body) };
    if (rule?.then === 'reset') return { action: 'reset', response };
    if (rule?.then === 'hold') return { action: 'hold', response, ms: rule.ms ?? 15_000 };
    return { action: 'respond', response };
  }

  const server = https.createServer({ key: authority.key, cert: authority.cert }, async (req, res) => {
    const body = await readBody(req);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const r = answer({ host: String(req.headers.host ?? '').split(':')[0].toLowerCase(), method: req.method, path: req.url.split('?')[0], headers, body });
    if (r.action === 'reset') { req.socket.destroy(); return; }
    if (r.action === 'hold') {
      const timer = setTimeout(() => { held.delete(timer); req.socket.destroy(); }, r.ms);
      timer.unref();
      held.add(timer);
      return;
    }
    res.writeHead(r.response.status, r.response.headers);
    res.end(r.response.body);
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
    /** An in-process request, answered by the same handler: { status, headers, body (text) }. A lost answer rejects as a reset connection does. */
    async call({ host: hostName, method = 'GET', path, headers = {}, body = '' }) {
      const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
      const r = answer({ host: hostName, method, path: path.split('?')[0], headers: h, body: typeof body === 'string' ? body : String(body ?? '') });
      if (r.action === 'reset') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      if (r.action === 'hold') { await sleep(Math.min(r.ms, 15_000)); throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }
      return r.response;
    },
    reset({ charges: next = charges, fault: nextFault = 'none' } = {}) {
      stripe = makeStripe({ charges: next, now });
      seeded = next;
      script = faultScript(nextFault);
      log = [];
      replies = [];
      counts = new Map();
      authorised = connect !== null;
    },
    close: () => new Promise((resolve) => { for (const t of held) clearTimeout(t); server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
