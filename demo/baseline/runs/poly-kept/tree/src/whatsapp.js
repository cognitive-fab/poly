// WhatsApp Cloud API webhooks: the subscription handshake, the signature check and the text messages they carry.
import { createHmac, timingSafeEqual } from 'node:crypto'

/** GET /webhook: Meta's verification request. Returns the challenge to echo, or null to refuse. */
export function handshake(query, verifyToken) {
  if (!verifyToken) return null
  if (query.get('hub.mode') !== 'subscribe') return null
  const token = query.get('hub.verify_token') ?? ''
  const a = Buffer.from(token)
  const b = Buffer.from(verifyToken)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return query.get('hub.challenge') ?? ''
}

/** X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body under the app secret>, compared in constant time. */
export function signatureValid(rawBody, header, appSecret) {
  if (!appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false
  const expected = createHmac('sha256', appSecret).update(rawBody).digest()
  let given
  try {
    given = Buffer.from(header.slice('sha256='.length), 'hex')
  } catch {
    return false
  }
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export const sign = (rawBody, appSecret) => `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`

/**
 * The customers' messages in a webhook body: { from, id, text, timestamp } for each. A message that is not text
 * (an image, a location) has text ''; delivery statuses are not messages and are skipped.
 */
export function messagesOf(body) {
  const out = []
  if (body?.object !== 'whatsapp_business_account') return out
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue
      for (const m of change.value?.messages ?? []) {
        if (typeof m.from !== 'string' || typeof m.id !== 'string') continue
        const text = m.type === 'text' ? String(m.text?.body ?? '') : m.type === 'button' ? String(m.button?.text ?? '') : ''
        out.push({ from: m.from, id: m.id, text, timestamp: Number(m.timestamp) * 1000 || null })
      }
    }
  }
  return out
}
