// What a customer's message asks for. Deterministic rules: no model call decides a refund.

const ORDER = /\bord[-\s#]?(\d+)\b/i
const SKU = /\b[a-z][a-z0-9]*-\d+\b/gi
const REFUND = /\b(refunds?|refunding|money\s+back|reimburse\w*|return(?:ing)?|cancel\w*)\b/i
const STATUS = /\b(status|where|track\w*|update|progress|check)\b/i
const WHOLE = /\b(all|everything|whole|entire|full)\b/i

/** Normalises a phone number to digits, the form the Cloud API's `from` and orders.json's `customer` use. */
export const digits = (phone) => String(phone ?? '').replace(/\D/g, '')

/**
 * The intent of a message, the order it names (ORD-1001, "ord 1001", "#1001" after "order"), and the item tokens it
 * names: SKU-shaped words (BLENDER-1) and plain words, matched against an order's items later.
 */
export function understand(text) {
  const t = String(text ?? '').trim()
  const m = t.match(ORDER) ?? t.match(/\border\s*#?\s*(\d+)\b/i)
  const order = m ? `ORD-${m[1]}` : null
  const intent = REFUND.test(t) ? 'refund' : STATUS.test(t) ? 'status' : 'help'
  const skus = (t.match(SKU) ?? []).map((s) => s.toUpperCase()).filter((s) => !/^ORD-/.test(s))
  const words = t.toLowerCase().match(/[a-z]+/g) ?? []
  return { intent, order, skus, words, whole: WHOLE.test(t) }
}

/**
 * Which lines of an order a request names: every line when it names no item, else the lines whose SKU it names, or
 * whose SKU's name (BLENDER of BLENDER-1) it says. A SKU-shaped token that is no line of the order is `unknown`, so a
 * request for a wrong item is never read as a request for the whole order.
 */
export function selectLines(order, asked) {
  const lines = order.items.map((item, index) => ({ index, sku: item.sku, base: item.sku.toLowerCase().replace(/-\d+$/, '') }))
  const unknown = asked.skus.find((s) => !lines.some((l) => l.sku.toUpperCase() === s))
  if (unknown) return { unknown, lines: [] }
  const says = (base) => [base, `${base}s`, base.replace(/s$/, '')].some((w) => asked.words.includes(w))
  const named = lines.filter((l) => asked.skus.includes(l.sku.toUpperCase()) || says(l.base))
  return { unknown: null, lines: named.length && !asked.whole ? named : lines }
}
