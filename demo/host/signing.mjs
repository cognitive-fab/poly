// DF3: the room signs each message as the WhatsApp Cloud API would, `X-Hub-Signature-256` = sha256= and the HMAC-SHA256 of the body
// under the app secret. The secret is made at start and held in memory (the launcher), so a message that did not come through the
// room cannot carry a signature the runtime's certified whatsapp adapter accepts. The shape is the Cloud API's notification for one
// text message from a sender (the number is the persona's), addressed to the phone number id the channel is configured with.
import { createHmac } from 'node:crypto';

/** The notification body for one text message. */
export function cloudApiBody({ persona, text, id, phoneNumberId, timestamp = '1790000000' }) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA-DEMO-ROOM',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15555550100', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: persona.id }, wa_id: persona.phone }],
          messages: [{ from: persona.phone, id, timestamp, type: 'text', text: { body: text } }],
        },
      }],
    }],
  });
}

export const sign = (appSecret, body) => `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`;

/** The webhook the runtime's ingress receives: a POST to the channel's address, signed. */
export function signedWebhook({ appSecret, phoneNumberId, persona, text, id, url = 'https://room.invalid/channels/support', timestamp }) {
  const body = cloudApiBody({ persona, text, id, phoneNumberId, timestamp });
  return { method: 'POST', url, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(appSecret, body) }, body };
}
