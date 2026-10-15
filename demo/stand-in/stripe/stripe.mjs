// The behaviour of the parts of Stripe's API the demo's refund touches (DB6, DAC9): GET /v1/charges/{id} and POST /v1/refunds, with
// Idempotency-Key applied as Stripe's documentation gives it. It is a stand-in, not Stripe: it is read from the documentation, it holds
// no key and it never leaves the machine (Q10). The module is pure (no socket, no clock of its own, no file), so a test can drive it
// directly; server.mjs gives it a socket and a request log.
//
// What is implemented, and where the documentation says it:
//   - POST /v1/refunds takes `charge` (required) and `amount` (an integer in the smallest unit; the whole of what is left when omitted).
//     It creates one refund object per accepted request, raises `amount_refunded` on the charge and refuses an amount over what is left
//     (invalid_request_error, "Refund amount ... is greater than unrefunded amount on charge ...") or a charge with nothing left
//     (code charge_already_refunded). An unknown charge is 404 resource_missing.
//   - Idempotency-Key (the "Idempotent requests" section of the API reference): the first request made with a key saves its status code
//     and body, whether it succeeded or failed; a later request with the same key and the same parameters returns that response again
//     (header Idempotent-Replayed: true) and does nothing; the same key with other parameters is idempotency_error. A key is kept for
//     24 hours. Only POST takes a key; a GET with one ignores it.
//   - Every request needs an Authorization header, whose value is never kept.
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

const json = (status, body, headers = {}) => ({ status, body, headers: { 'content-type': 'application/json', ...headers } });
const error = (status, type, message, extra = {}) => json(status, { error: { type, message, ...extra } });

/** The decoded parameters of an application/x-www-form-urlencoded body, as an ordered list of [name, value]. */
export function formParams(text) {
  if (!text) return [];
  return [...new URLSearchParams(text).entries()];
}

/** The fingerprint Stripe compares for a key: the parameters, ordered by name. */
const fingerprint = (path, params) => JSON.stringify([path, [...params].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))]);

/**
 * A Stripe stand-in. `charges` seeds the charges: { id, amount, currency }. `now` is the clock of the keys' 24 hours.
 * `handle` takes { method, path, headers (lower-cased names), body (the form text) } and gives { status, body, headers, applied }:
 * `applied` is whether the request changed the state (a refund was created), which the fault script needs.
 */
export function createStripe({ charges = [], now = () => Date.now() } = {}) {
  const store = new Map(charges.map((c) => [c.id, { id: c.id, object: 'charge', amount: c.amount, amount_refunded: 0, currency: c.currency ?? 'usd', refunded: false, paid: true }]));
  const refunds = [];
  const keys = new Map();

  function chargeView(c) { return { ...c }; }

  function createRefund(params) {
    const p = Object.fromEntries(params);
    if (!p.charge) return error(400, 'invalid_request_error', 'Missing required param: charge.', { param: 'charge', code: 'parameter_missing' });
    const charge = store.get(p.charge);
    if (!charge) return error(404, 'invalid_request_error', `No such charge: '${p.charge}'`, { param: 'charge', code: 'resource_missing' });
    if (p.amount !== undefined && !/^[1-9][0-9]*$/.test(p.amount)) return error(400, 'invalid_request_error', 'Invalid positive integer', { param: 'amount' });
    const left = charge.amount - charge.amount_refunded;
    if (left === 0) return error(400, 'invalid_request_error', `Charge ${charge.id} has already been refunded.`, { code: 'charge_already_refunded', param: 'charge' });
    const amount = p.amount === undefined ? left : Number(p.amount);
    if (amount > left) return error(400, 'invalid_request_error', `Refund amount (${(amount / 100).toFixed(2)}) is greater than unrefunded amount on charge (${(left / 100).toFixed(2)})`, { param: 'amount' });
    charge.amount_refunded += amount;
    charge.refunded = charge.amount_refunded === charge.amount;
    const refund = { id: `re_standin_${String(refunds.length + 1).padStart(4, '0')}`, object: 'refund', amount, charge: charge.id, currency: charge.currency, status: 'succeeded', reason: p.reason ?? null, created: Math.floor(now() / 1000), balance_transaction: null, metadata: {} };
    refunds.push(refund);
    return { ...json(200, refund), applied: true };
  }

  function handle({ method, path, headers = {}, body = '' }) {
    if (!headers.authorization) return error(401, 'invalid_request_error', 'You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. \'Authorization: Bearer YOUR_SECRET_KEY\').');
    const charge = /^\/v1\/charges\/([^/?]+)$/.exec(path);
    if (method === 'GET' && charge) {
      const c = store.get(decodeURIComponent(charge[1]));
      return c ? json(200, chargeView(c)) : error(404, 'invalid_request_error', `No such charge: '${decodeURIComponent(charge[1])}'`, { param: 'id', code: 'resource_missing' });
    }
    if (method === 'POST' && path === '/v1/refunds') {
      const params = formParams(body);
      const key = headers['idempotency-key'];
      if (key === undefined) return createRefund(params);
      const fp = fingerprint(path, params);
      const seen = keys.get(key);
      if (seen && now() - seen.at < KEY_TTL_MS) {
        if (seen.fp !== fp) return error(400, 'idempotency_error', `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than "${key}" if you meant to execute a different request.`);
        return { ...seen.response, headers: { ...seen.response.headers, 'idempotent-replayed': 'true' }, applied: false };
      }
      const response = createRefund(params);
      keys.set(key, { fp, at: now(), response: { status: response.status, body: response.body, headers: response.headers } });
      return response;
    }
    return error(404, 'invalid_request_error', `Unrecognized request URL (${method}: ${path}).`);
  }

  return {
    handle,
    refunds: () => refunds.map((r) => ({ ...r })),
    charge: (id) => (store.has(id) ? chargeView(store.get(id)) : null),
    charges: () => [...store.values()].map(chargeView),
  };
}
