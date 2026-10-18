// What a customer's message asks for. Deterministic on purpose: no model sits on the path to a refund, so what a
// message does is what these rules say. Anything they do not recognise gets the help text.

const ORDER = /\bORD[-\s]?(\d{3,})\b/i

/** The order id a message names, written as orders.json writes it ("ord 1001" is "ORD-1001"), or null. */
export function orderIn(text) {
  const m = ORDER.exec(text)
  return m ? `ORD-${m[1]}` : null
}

/** The index of the line of `order` whose sku the message names, or null. */
export function lineIn(text, order) {
  const t = text.toUpperCase()
  const hits = order.items
    .map((it, i) => ({ i, sku: it.sku.toUpperCase() }))
    .filter(({ sku }) => new RegExp(`(^|[^A-Z0-9-])${sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Z0-9-])`).test(t))
  return hits.length === 1 ? hits[0].i : null
}

/**
 * The intent of a message: { kind, order } where kind is one of refund, confirm, cancel, status, help.
 * `order` is the order id the message names, or null.
 */
export function parseMessage(text) {
  const t = String(text ?? '').trim()
  const order = orderIn(t)
  const lower = t.toLowerCase()
  if (/^(yes|y|yep|yeah|confirm|confirmed|ok|okay|go ahead|please do)\b/.test(lower)) return { kind: 'confirm', order }
  if (/^(no|n|nope|cancel|stop|never ?mind|don'?t)\b/.test(lower)) return { kind: 'cancel', order }
  if (/\b(refund|money back|reimburse|return)\b/.test(lower)) return { kind: 'refund', order }
  if (/\b(status|my orders?|orders|where)\b/.test(lower)) return { kind: 'status', order }
  return { kind: 'help', order }
}
