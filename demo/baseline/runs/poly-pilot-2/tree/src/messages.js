// The words the agent says on WhatsApp. Pure functions of the records the host keeps, shared by the effect handlers.

export const money = (cents, currency = 'usd') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100)

const STATUS_WORDS = {
  Open: 'not refunded',
  Refunding: 'refund in progress',
  Refunded: 'refunded',
  Failed: 'refund could not be completed; our team will contact you',
}

const lineList = (lines) => lines.map((l) => `• ${l.sku} ${money(l.amount, l.currency)}: ${STATUS_WORDS[l.status]}`).join('\n')

const USAGE = 'Send "refund ORD-1001" to refund a whole order, "refund ORD-1001 BLENDER-1" to refund one item, or "status ORD-1001" to see where a refund is.'

const greet = (name) => (name ? `Hi ${name.split(' ')[0]}! ` : 'Hi! ')

/** The reply to one inbound message (the Inquiry's outcome), from its record in the `inquiries` table. */
export function replyText(outcome, r) {
  switch (outcome) {
    case 'Help':
      return `${greet(r.name)}I'm the refunds assistant. ${USAGE}`
    case 'NeedOrder':
      return r.orders.length
        ? `Which order should I ${r.intent === 'status' ? 'look up' : 'refund'}? Your orders: ${r.orders.join(', ')}. Reply for example "${r.intent === 'status' ? 'status' : 'refund'} ${r.orders[0]}".`
        : "I couldn't find any orders placed with this WhatsApp number."
    case 'NotFound':
      return `I couldn't find order ${r.order ?? ''} for this WhatsApp number. Please check the order number on your receipt.`.replace('  ', ' ')
    case 'NoItem':
      return `Order ${r.order} has no item "${r.item}". Its items are: ${r.lines.map((l) => l.sku).join(', ')}.`
    case 'Started': {
      const started = r.lines.filter((l) => l.started)
      const others = r.lines.filter((l) => !l.started)
      const total = started.reduce((s, l) => s + l.amount, 0)
      return [
        `I'm refunding ${money(total, started[0]?.currency)} on order ${r.order}:`,
        started.map((l) => `• ${l.sku} ${money(l.amount, l.currency)}`).join('\n'),
        ...(others.length ? ['Not refunded again:', lineList(others)] : []),
        "I'll message you when the refund is confirmed. It goes back to the card you paid with.",
      ].join('\n')
    }
    case 'NothingToRefund':
      return `There is nothing left to refund on order ${r.order}:\n${lineList(r.lines)}`
    case 'Status':
      return `Order ${r.order}:\n${lineList(r.lines)}`
    default:
      throw new Error(`no reply text for outcome ${outcome}`)
  }
}

/** The message a Line sends when its refund settles, from its record in the `lines` table. */
export function noticeText(outcome, line) {
  const what = `${money(line.amount, line.currency)} for ${line.sku} (order ${line.order})`
  switch (outcome) {
    case 'RefundIssued':
      return `Your refund of ${what} has been issued. It usually reaches your card within 5 to 10 business days.`
    case 'RefundNotIssued':
      return `I couldn't complete the refund of ${what}. A member of our team will follow up with you.`
    default:
      throw new Error(`no notice text for outcome ${outcome}`)
  }
}
