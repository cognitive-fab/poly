// DF4, PT10b: the transports of the demo. A channel's send reaches a network only through a transport the host gives it; these give
// it none. The support transport hands the Cloud API send to the room page of the persona it is for; the staff transport hands the
// Slack post to the presenter's feed. Any other request has no route, so no byte leaves the machine for a channel provider.

const noRoute = (q) => Object.assign(new Error(`no route: the demo transport carries only the room's messages, not ${q.method} ${q.url}`), { code: 'ENOROUTE' });
let serial = 0;

/** The Cloud API send of the concierge's replies, answered as the Cloud API answers. */
export function supportTransport(room) {
  return {
    http: {
      async request(q) {
        if (q.method !== 'POST' || !/^https:\/\/graph\.facebook\.com\/v[0-9.]+\/[0-9]+\/messages$/.test(q.url)) throw noRoute(q);
        const sent = JSON.parse(q.body);
        room.deliver(String(sent.to), String(sent.text?.body ?? ''));
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: sent.to, wa_id: sent.to }], messages: [{ id: `wamid.ROOM.OUT.${++serial}`, message_status: 'accepted' }] }) };
      },
    },
  };
}

/** The Slack post of the staff channel, answered as Slack answers a post. */
export function staffTransport(feed) {
  return {
    http: {
      async request(q) {
        if (q.method !== 'POST' || !/^https:\/\/slack\.com\/api\/chat\.postMessage$/.test(q.url)) throw noRoute(q);
        const sent = JSON.parse(q.body);
        const entry = feed.post(String(sent.text ?? ''));
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, channel: sent.channel ?? 'C123ABC456', ts: `${Math.floor(entry.at / 1000)}.${String(entry.seq).padStart(6, '0')}`, message: { text: entry.text, type: 'message', subtype: 'bot_message' } }) };
      },
    },
  };
}
