// plan-ex.md E1, PT22.5: the handler of payments.refund. It holds no rule: the gate has let the intent through (a
// refund above 100 only with a person's signed approval), and the runtime's api sends under the merchant's Stripe
// Connect grant to the refunds URL alone, attaching the connected account, so no token or account id reaches this file.
// Stripe's refunds.create takes a form body; the amount is in the currency's smallest unit
// (docs.stripe.com/api/refunds/create, read 2026-10-10). Stated limit: the program carries the amount only, not the
// charge it refunds, so the example's refund names none; a real host adds the order's payment from its own records.
export const REFUNDS_URL = 'https://api.stripe.com/v1/refunds';

/** The form body: the amount in cents, from the program's whole units. */
export const refundForm = (amount) => {
  if (!Number.isInteger(amount) || amount < 0 || amount > 500) throw new Error('a refund amount is a whole number of 0..500');
  return new URLSearchParams({ amount: String(amount * 100), currency: 'eur', reason: 'requested_by_customer' }).toString();
};

/** The handler: one refund through api; any answer but 200 fails the effect, so the Desk answers Declined. */
export async function refund(payload, caps) {
  const res = await caps.api.post(REFUNDS_URL, refundForm(payload.amount), { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  if (res.status !== 200) throw new Error(`refunds.create answered ${res.status}`);
  return { ok: true };
}
