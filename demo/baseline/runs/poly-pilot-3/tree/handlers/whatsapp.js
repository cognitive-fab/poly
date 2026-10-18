// The handler of whatsapp.notify (support.poly): tells the customer how their refund ended, through the WhatsApp
// Cloud API. It is tried once (at most once: WhatsApp takes no idempotency key), with the capabilities the effect
// declares: POST under https://graph.facebook.com/v21.0, the secret WHATSAPP_TOKEN, and the orders and whatsapp tables.
import { noticeText } from './lines.js'

export const GRAPH = 'https://graph.facebook.com/v21.0'

/** The Cloud API request that sends a text message (shared with the host's own replies, lib/whatsapp.js). */
export function textMessage(phoneNumberId, to, body) {
  return {
    url: `${GRAPH}/${encodeURIComponent(phoneNumberId)}/messages`,
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } }),
  }
}

export async function notify(payload, { egress, secrets, store }, ctx) {
  const order = await store.read('orders', ctx.instanceId)
  if (!order) throw Object.assign(new Error(`no order ${ctx.instanceId} in orders.json`), { permanent: true })
  const config = await store.read('whatsapp', 'config')
  const token = await secrets.get('WHATSAPP_TOKEN')
  if (!config?.phoneNumberId || !token) throw new Error('WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_TOKEN is not set')

  const msg = textMessage(config.phoneNumberId, order.customer, noticeText(order, payload))
  const res = await egress.post(msg.url, msg.body, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
  if (res.status < 200 || res.status >= 300) {
    throw Object.assign(new Error(`WhatsApp answered ${res.status}: ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`), { permanent: true })
  }
  const body = typeof res.body === 'string' ? JSON.parse(res.body || '{}') : res.body ?? {}
  return { message: body.messages?.[0]?.id ?? null }
}
