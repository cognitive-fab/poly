// The WhatsApp Cloud API webhook: the subscription handshake, the payload signature, and the messages in a payload.
import { createHmac, timingSafeEqual } from 'node:crypto'

/** GET /webhook?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…: the challenge to echo, or null to refuse. */
export function handshake(query, verifyToken) {
  if (!verifyToken) return null
  const token = query.get('hub.verify_token') ?? ''
  const same = token.length === verifyToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(verifyToken))
  return query.get('hub.mode') === 'subscribe' && same ? query.get('hub.challenge') ?? '' : null
}

/** X-Hub-Signature-256: `sha256=` and the HMAC-SHA256 of the raw body under the app secret, compared in constant time. */
export function signatureValid(raw, header, appSecret) {
  if (!appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false
  const given = Buffer.from(header.slice(7), 'hex')
  const expected = createHmac('sha256', appSecret).update(raw).digest()
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export const sign = (raw, appSecret) => `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`

/**
 * The customer messages of a webhook payload, `{ id, from, name, text, phoneNumberId }`. Delivery statuses are not
 * messages and are left out. A message that is not text (an image, a location) has the text '' and gets the help reply.
 */
export function messagesOf(payload) {
  const out = []
  if (payload?.object !== 'whatsapp_business_account') return out
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue
      const v = change.value ?? {}
      const names = new Map((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]))
      for (const m of v.messages ?? []) {
        if (!m?.id || !m?.from) continue
        const text = m.type === 'text' ? m.text?.body ?? ''
          : m.type === 'button' ? m.button?.text ?? ''
          : m.type === 'interactive' ? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? ''
          : ''
        out.push({ id: m.id, from: m.from, name: names.get(m.from) ?? null, text, phoneNumberId: v.metadata?.phone_number_id ?? null })
      }
    }
  }
  return out
}
