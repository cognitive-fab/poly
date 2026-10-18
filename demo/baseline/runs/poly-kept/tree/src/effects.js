// Effect handlers of support.poly. Each runs from the outbox worker with only the capabilities its effect's labels
// and targets grant (store tables, secrets, egress URLs); none of them reaches the network or the disk on its own.

const STRIPE_REFUNDS = 'https://api.stripe.com/v1/refunds'
const GRAPH = 'https://graph.facebook.com/v21.0'

/** An error a retry would meet again: the worker completes the effect as failed at once. */
class Permanent extends Error {
  constructor(message) {
    super(message)
    this.permanent = true
  }
}

const orderOfTicket = (instanceId) => instanceId.replace(/^ticket:/, '')

export const money = (cents, currency) => {
  const code = String(currency || 'usd').toUpperCase()
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`
  }
}

/** The lines a payload's flags l0..l3 name, with the amount they come to. */
export const linesOf = (order, p) => {
  const lines = [p.l0, p.l1, p.l2, p.l3].flatMap((on, i) => (on && order.items[i] ? [order.items[i]] : []))
  return { lines, amount: lines.reduce((s, l) => s + l.price, 0) }
}

const describe = (order, lines) =>
  lines.length === order.items.length ? `order ${order.order}` : `${lines.map((l) => l.sku).join(', ')} from order ${order.order}`

export const ticketText = (msg, order, p) => {
  const { lines, amount } = linesOf(order, p)
  const what = describe(order, lines)
  const sum = money(amount, order.currency)
  switch (msg) {
    case 'AskConfirm':
      return `You asked for a refund of ${sum} for ${what}. Reply YES to confirm or NO to cancel.`
    case 'Refunded':
      return `Done: ${sum} for ${what} has been refunded to your original payment method. It can take 5-10 business days to appear.`
    case 'RefundFailed':
      return `Sorry, we could not refund ${what}. Our team has been told; you can also try again later.`
    case 'UnderReview':
      return `Your refund of ${sum} for ${what} is taking longer than expected. A person on our team is checking it and will confirm soon.`
    case 'Cancelled':
      return `OK, no refund was made. Message us any time if you change your mind.`
    default:
      throw new Permanent(`no text for ${msg}`)
  }
}

export const noticeText = (msg, orders) => {
  const list = orders.length ? orders.map((o) => `${o.order} (${o.items.map((i) => i.sku).join(', ')})`).join('; ') : 'none found'
  switch (msg) {
    case 'Help':
      return `Hi! I can refund an order. Send "refund ORDER" for a whole order, or "refund ORDER SKU" for one item. Your orders: ${list}.`
    case 'UnknownOrder':
      return `I could not find that order on this number. Your orders: ${list}.`
    case 'OutsideWindow':
      return `Sorry, that order is outside our refund window, so I cannot refund it here.`
    case 'AlreadyRefunded':
      return `That has already been refunded.`
    case 'NoSuchItem':
      return `That item is not in the order. Your orders: ${list}.`
    case 'AwaitingConfirmation':
      return `You already have a refund waiting for confirmation on that order. Reply YES to confirm or NO to cancel.`
    case 'RefundInProgress':
      return `A refund for that order is already being processed. You will get a message when it is done.`
    case 'NothingToConfirm':
      return `There is no refund waiting for your confirmation. Send "refund ORDER" to start one.`
    case 'UnderReviewAlready':
      return `A refund for that order is being checked by our team. We will message you when it is settled.`
    case 'TooManyItems':
      return `That order is too large for me to refund here; our team will help you.`
    case 'OrderClosed':
      return `That order has been fully refunded already.`
    case 'Ambiguous':
      return `You have more than one refund waiting. Reply "YES ORDER" or "NO ORDER" to say which one.`
    default:
      throw new Permanent(`no text for ${msg}`)
  }
}

const failOn = (res, what) => {
  if (res.status >= 200 && res.status < 300) return
  const detail = typeof res.body === 'string' ? res.body.slice(0, 300) : JSON.stringify(res.body ?? '').slice(0, 300)
  const msg = `${what} answered ${res.status}: ${detail}`
  // 409 is Stripe's idempotency conflict, 429 a rate limit: both are worth a retry. Any other 4xx is a refusal.
  if (res.status >= 400 && res.status < 500 && res.status !== 409 && res.status !== 429) throw new Permanent(msg)
  throw new Error(msg)
}

const sendWhatsApp = async ({ egress, secrets, store }, to, text) => {
  const token = await secrets.get('WHATSAPP_TOKEN')
  const phoneNumberId = await store.read('config', 'whatsappPhoneNumberId')
  if (!token || !phoneNumberId) throw new Permanent('WhatsApp is not configured')
  const res = await egress.post(
    `${GRAPH}/${phoneNumberId}/messages`,
    JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } }),
    { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
  )
  failOn(res, 'WhatsApp')
  return { sent: true }
}

/** stripe.refund: refunds the payload's lines of the ticket's order on its charge, keyed by the intent id. */
export async function refund(payload, caps, ctx) {
  const order = await caps.store.read('orders', orderOfTicket(ctx.instanceId))
  if (!order) throw new Permanent('order not found')
  const { lines, amount } = linesOf(order, payload)
  if (amount <= 0) throw new Permanent('nothing to refund')
  const key = await caps.secrets.get('STRIPE_SECRET_KEY')
  if (!key) throw new Permanent('Stripe is not configured')
  const form = new URLSearchParams()
  form.set(order.charge.startsWith('pi_') ? 'payment_intent' : 'charge', order.charge)
  form.set('amount', String(amount))
  form.set('reason', 'requested_by_customer')
  form.set('metadata[order]', order.order)
  form.set('metadata[skus]', lines.map((l) => l.sku).join(','))
  // The runtime adds Idempotency-Key: <intent id> to this write, the same on every retry (PT33.4).
  const res = await caps.egress.post(STRIPE_REFUNDS, form.toString(), {
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
  })
  failOn(res, 'Stripe')
  const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body
  return { refund: body?.id ?? null, amount }
}

/** whatsapp.ticket: a message about a ticket's refund, to the order's customer. */
export async function say(payload, caps, ctx) {
  const order = await caps.store.read('orders', orderOfTicket(ctx.instanceId))
  if (!order) throw new Permanent('order not found')
  return sendWhatsApp(caps, order.customer, ticketText(payload.msg, order, payload))
}

/** whatsapp.notice: a reply that changes no order, to the sender of the message it answers. */
export async function tell(payload, caps, ctx) {
  const to = await caps.store.read('recipients', ctx.instanceId)
  if (!to) throw new Permanent('recipient not found')
  const orders = (await caps.store.read('customers', to)) ?? []
  return sendWhatsApp(caps, to, noticeText(payload.msg, orders))
}
