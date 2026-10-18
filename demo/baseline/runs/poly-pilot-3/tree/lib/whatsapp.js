// The host's own replies through the WhatsApp Cloud API: the answer to each customer message. The notices that end
// a refund are effects of the Order machine instead (handlers/whatsapp.js), so they survive a restart.
import { textMessage } from '../handlers/whatsapp.js'

export function whatsappSender({ token, phoneNumberId, fetch = globalThis.fetch }) {
  return async function send(to, body) {
    const msg = textMessage(phoneNumberId, to, body)
    const res = await fetch(msg.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: msg.body,
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`WhatsApp answered ${res.status}: ${await res.text()}`)
    return res.json()
  }
}
