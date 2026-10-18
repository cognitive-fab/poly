// The effect handlers of src/support.poly. Each runs from the outbox worker after the gate allows its intent, and holds
// only the capabilities its effect's labels and targets grant: egress to the declared URLs, the declared secrets, and
// reads of the declared store tables. No ambient authority (no fs, no fetch, no process.env): `poly lint handlers`.
import { noticeText, replyText } from './messages.js'

export const STRIPE_REFUNDS = 'https://api.stripe.com/v1/refunds'
export const GRAPH_VERSION = 'v24.0'

/** A failure a retry would meet again: the worker completes it as `failed` at once. */
class Permanent extends Error {
  constructor(message) {
    super(message)
    this.permanent = true
  }
}

const bodyOf = (res) => {
  if (typeof res.body !== 'string') return res.body ?? null
  try {
    return JSON.parse(res.body)
  } catch {
    return res.body
  }
}

/** stripe.refund: refunds one order line on its charge. The runtime adds the Idempotency-Key (the intent id). */
export async function refund(_payload, { egress, secrets, store }, ctx) {
  const line = await store.read('lines', ctx.instanceId)
  if (!line) throw new Permanent(`no order line ${ctx.instanceId}`)
  const key = await secrets.get('STRIPE_SECRET_KEY')
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured')
  const form = new URLSearchParams({
    charge: line.charge,
    amount: String(line.amount),
    reason: 'requested_by_customer',
    'metadata[order]': line.order,
    'metadata[sku]': line.sku,
    'metadata[line]': ctx.instanceId,
  })
  const res = await egress.post(STRIPE_REFUNDS, form.toString(), {
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
  })
  const body = bodyOf(res)
  if (res.status >= 200 && res.status < 300) return { refund: body?.id ?? null, status: body?.status ?? null }
  const why = `stripe ${res.status}: ${body?.error?.code ?? body?.error?.message ?? 'error'}`
  // 409: a request with this key is still in flight; 429 and 5xx: try again. Any other 4xx is Stripe's refusal.
  if (res.status === 409 || res.status === 429 || res.status >= 500) throw new Error(why)
  throw new Permanent(why)
}

async function sendWhatsApp({ egress, secrets }, to, text) {
  const token = await secrets.get('WHATSAPP_TOKEN')
  const phoneId = await secrets.get('WHATSAPP_PHONE_NUMBER_ID')
  if (!token || !phoneId) throw new Permanent('WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not configured')
  const res = await egress.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(phoneId)}/messages`,
    JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text } }),
    { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
  )
  const body = bodyOf(res)
  if (res.status >= 200 && res.status < 300) return { message: body?.messages?.[0]?.id ?? null }
  throw new Permanent(`whatsapp ${res.status}: ${body?.error?.message ?? 'error'}`)
}

/** whatsapp.notify: tells the customer how a line's refund settled. */
export async function notify(payload, caps, ctx) {
  const line = await caps.store.read('lines', ctx.instanceId)
  if (!line) throw new Permanent(`no order line ${ctx.instanceId}`)
  return sendWhatsApp(caps, line.customer, noticeText(payload.outcome, line))
}

/** whatsapp.reply: answers one inbound message. */
export async function reply(payload, caps, ctx) {
  const record = await caps.store.read('inquiries', ctx.instanceId)
  if (!record) throw new Permanent(`no inquiry ${ctx.instanceId}`)
  return sendWhatsApp(caps, record.to, replyText(payload.outcome, record))
}
