// Pure helpers shared by the effect handlers and the host: which lines a payload names, what they cost, and how
// an amount reads to a customer. No I/O here; the handlers are linted and certified with every file they import.

/** The indexes of the lines a refund or notify payload names (l0..l3 are true for the lines it covers). */
export function linesOf(payload) {
  return [0, 1, 2, 3].filter((i) => payload[`l${i}`] === true)
}

/** The amount, in the order's minor unit, of the lines a payload names. */
export function amountOf(order, payload) {
  return linesOf(payload).reduce((sum, i) => {
    const item = order.items[i]
    if (!item) throw new Error(`order ${order.order} has no line ${i}`)
    return sum + item.price
  }, 0)
}

/** An amount in a currency's minor unit, as a customer reads it: 6000 usd is "$60.00". */
export function money(amount, currency) {
  const code = String(currency).toUpperCase()
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount / 100)
  } catch {
    return `${(amount / 100).toFixed(2)} ${code}`
  }
}

/** The text a customer receives for a notice the Order machine emits (support.poly, effect notify). */
export function noticeText(order, payload) {
  switch (payload.event) {
    case 'Issued': {
      const skus = linesOf(payload).map((i) => order.items[i].sku).join(', ')
      return `Your refund of ${money(amountOf(order, payload), order.currency)} for ${order.order} (${skus}) has been issued. It usually reaches your card within 5 to 10 business days.`
    }
    case 'Declined':
      return `We could not issue the refund for ${order.order}. No money was moved. Reply "refund ${order.order}" to try again.`
    case 'UnderReview':
      return `We could not confirm the refund for ${order.order} with our payment provider. A member of our team is checking it and will get back to you. Please do not ask again in the meantime.`
    default:
      throw new Error(`unknown notice ${payload.event}`)
  }
}
