// The WhatsApp Cloud API webhook: the verification handshake, the X-Hub-Signature-256 check, and the messages a
// notification carries. Meta signs the raw request body with the app secret (HMAC-SHA256, hex, "sha256=" prefix).
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Whether `header` is the signature of `raw` (a Buffer or string) under `appSecret`. Constant time. */
export function validSignature(raw, header, appSecret) {
  if (!appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false
  const given = Buffer.from(header.slice('sha256='.length), 'hex')
  const want = createHmac('sha256', appSecret).update(raw).digest()
  return given.length === want.length && timingSafeEqual(given, want)
}

export function sign(raw, appSecret) {
  return `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`
}

/** The GET handshake: the challenge to echo, or null when the mode or the token is wrong. */
export function handshake(query, verifyToken) {
  const mode = query.get('hub.mode')
  const token = query.get('hub.verify_token')
  const challenge = query.get('hub.challenge')
  if (mode !== 'subscribe' || !verifyToken || token !== verifyToken || challenge === null) return null
  return challenge
}

/** The text of one Cloud API message, or null for a kind the agent does not read (an image, a location, ...). */
function textOf(m) {
  switch (m.type) {
    case 'text':
      return m.text?.body ?? null
    case 'button':
      return m.button?.text ?? m.button?.payload ?? null
    case 'interactive':
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null
    default:
      return null
  }
}

/**
 * The customer messages of a webhook notification: { id, from, text, phoneNumberId, timestamp }, text null when the
 * message is of a kind the agent does not read. Statuses (sent, delivered, read) are not messages and are left out.
 */
export function messagesOf(payload) {
  if (payload?.object !== 'whatsapp_business_account') return []
  const out = []
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue
      const v = change.value ?? {}
      for (const m of v.messages ?? []) {
        if (typeof m?.id !== 'string' || typeof m?.from !== 'string') continue
        out.push({ id: m.id, from: m.from, text: textOf(m), phoneNumberId: v.metadata?.phone_number_id ?? null, timestamp: Number(m.timestamp) || null })
      }
    }
  }
  return out
}
