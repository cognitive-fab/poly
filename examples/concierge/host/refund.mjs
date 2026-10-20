// plan-ex.md E1, PT22.5, S462: the handler of payments.refund. It holds no rule: the gate has let the intent through (a
// refund above 100 only with a person's signed approval), and the runtime's api sends under the merchant's Stripe
// Connect grant, attaching the connected account, so no token or account id reaches this file.
//
// The refund acts on one order, which the program passes as an item set of exactly one item (`one order`, PS17.4b), taken
// from the customer's own orders as retrieved. The handler reads it with items.read and refuses, before any request,
// unless the order is the requesting customer's. It then reads the order's charge, the source's `charge` key, and
// refuses unless the amount is no more than what was paid and not yet refunded on it. Only then does it refund, and it
// refunds that charge and no other. A refusal throws a permanent error (S138), so the effect fails at once, without a
// retry, and the Desk tells the customer it could not.
// Stripe: GET /v1/charges/{id} gives `amount` and `amount_refunded` in the currency's smallest unit; POST /v1/refunds
// takes `charge` and `amount` (docs.stripe.com/api/charges/retrieve and /api/refunds/create, read 2026-10-10), and takes
// the currency from the charge.
export const REFUNDS_URL = 'https://api.stripe.com/v1/refunds';
export const CHARGES_URL = 'https://api.stripe.com/v1/charges/';

const CHARGE = /^ch_[A-Za-z0-9]{1,64}$/;
/** A refusal: the same inputs refuse again, so it is not retried. */
const refuse = (message) => Object.assign(new Error(message), { permanent: true });

/** The form body of the refund: the charge and the amount in cents, from the program's whole units. */
export const refundForm = (charge, amount) => {
  if (!CHARGE.test(String(charge))) throw refuse('a refund names a Stripe charge');
  if (!Number.isInteger(amount) || amount < 0 || amount > 500) throw refuse('a refund amount is a whole number of 0..500');
  return new URLSearchParams({ charge, amount: String(amount * 100), reason: 'requested_by_customer' }).toString();
};

/**
 * The handler: one refund through api. The owner is checked before anything is sent; the amount against the charge is
 * checked after one read of it, so that refusal sends a GET and no POST.
 */
export async function refund(payload, caps) {
  const items = await caps.items.read(payload.order);
  if (!Array.isArray(items) || items.length !== 1) throw refuse('a refund acts on exactly one order');
  const [order] = items;
  if (typeof order.owner !== 'string' || order.owner === '' || order.owner !== payload.customer) throw refuse('the order is not the requesting customer\'s');
  const charge = order.keys?.charge;
  if (!CHARGE.test(String(charge))) throw refuse('the order names no Stripe charge');
  const got = await caps.api.get(`${CHARGES_URL}${charge}`);
  if (got.status !== 200) throw refuse(`charges.retrieve answered ${got.status}`);
  const paid = JSON.parse(got.body);
  if (!Number.isInteger(paid.amount) || !Number.isInteger(paid.amount_refunded) || paid.paid !== true) throw refuse('the charge is not a paid charge');
  const form = refundForm(charge, payload.amount);
  if (payload.amount * 100 > paid.amount - paid.amount_refunded) throw refuse('the amount exceeds what was paid on the order\'s charge');
  // The key is not the handler's to send: the refund is declared `idempotent header "Idempotency-Key"`, so the runtime sends the intent id on this write and on each retry (PT33.4), and a lost answer cannot refund twice.
  const res = await caps.api.post(REFUNDS_URL, form, { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  // A 4xx is Stripe refusing this refund and will again; anything else is tried again. A 409 is not a refusal (DF20): a keyed request that
  // meets the first request with its key still in progress gets a 409, so the target may be executing it, and a permanent error would
  // clear the ledger of the Desk (DF19) while it does. 429 is a rate limit. Both are retried with the same key.
  if (res.status !== 200) throw res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 409 ? refuse(`refunds.create answered ${res.status}`) : new Error(`refunds.create answered ${res.status}`);
  return { ok: true };
}
