// The handler of stripe.refund (support.poly). It runs only from the outbox worker, after the gate allows, with the
// capabilities the effect declares: POST to https://api.stripe.com/v1/refunds, the secret STRIPE_SECRET_KEY, and
// the orders table. The runtime sets the Idempotency-Key header to the intent id, so a retry never refunds twice.
import { amountOf, linesOf } from './lines.js'

export const REFUNDS_URL = 'https://api.stripe.com/v1/refunds'

/** A refusal Stripe will repeat on a retry: the worker delivers RefundFailed(Declined) and makes no further attempt. */
function permanent(message) {
  const e = new Error(message)
  e.permanent = true
  return e
}

function parse(body) {
  if (typeof body !== 'string') return body ?? {}
  try {
    return JSON.parse(body)
  } catch {
    return {}
  }
}

export async function refund(payload, { egress, secrets, store }, ctx) {
  const order = await store.read('orders', ctx.instanceId)
  if (!order) throw permanent(`no order ${ctx.instanceId} in orders.json`)
  const amount = amountOf(order, payload)
  if (!(amount > 0)) throw permanent(`refund of ${ctx.instanceId} names no line`)
  const key = await secrets.get('STRIPE_SECRET_KEY')
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set')

  const form = new URLSearchParams({
    charge: order.charge,
    amount: String(amount),
    reason: 'requested_by_customer',
    'metadata[order]': order.order,
    'metadata[lines]': linesOf(payload).map((i) => order.items[i].sku).join(','),
  })
  const res = await egress.post(REFUNDS_URL, form.toString(), {
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
  })
  const body = parse(res.body)

  if (res.status >= 200 && res.status < 300) {
    if (body.status === 'failed' || body.status === 'canceled') throw permanent(`Stripe refund ${body.id} is ${body.status}`)
    return { refund: body.id, status: body.status, amount }
  }
  // 409: a request with this key is still in flight; 429: rate limited; 5xx: Stripe's side. All are worth a retry,
  // and the same Idempotency-Key makes the retry safe.
  if (res.status === 409 || res.status === 429 || res.status >= 500) {
    throw new Error(`Stripe answered ${res.status}: ${body.error?.message ?? 'no message'}`)
  }
  // Any other 4xx (charge already refunded, amount too large, unknown charge, bad key) fails the same way again.
  throw permanent(`Stripe refused the refund (${res.status} ${body.error?.code ?? body.error?.type ?? ''}): ${body.error?.message ?? 'no message'}`)
}
