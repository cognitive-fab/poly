// The support agent: one customer message in, one reply out. It reads what the message asks (lib/parse.js), finds
// the order among the sender's own orders, and moves that order's Order machine (src/support.poly). The machine
// decides; this file only words its answers. A customer can reach only the orders on their own WhatsApp number.
import { parseMessage, lineIn } from './parse.js'
import { money } from '../handlers/lines.js'

export const MACHINE = 'support.Order'
/** The actions a customer's message may take. The completions and the operator's resolutions are not among them. */
export const CUSTOMER_ACTIONS = new Set(['RequestAll', 'RequestLine', 'Confirm', 'Cancel'])

const HELP = [
  'Hi! I can refund your orders. Send for example:',
  '• "refund ORD-1001" to refund a whole order',
  '• "refund CUPS-4 from ORD-1001" to refund one item',
  '• "status" to see your orders',
].join('\n')

/** The lines a quote covers: every line not yet refunded for All, or the one line. */
function quotedLines(state) {
  const what = state.phase_what
  if (!what) return []
  if (what.$ === 'Line') return [what.i]
  return state.done.map((d, i) => (d ? null : i)).filter((i) => i !== null)
}

function describe(order, lines) {
  const amount = lines.reduce((s, i) => s + order.items[i].price, 0)
  return { amount: money(amount, order.currency), skus: lines.map((i) => order.items[i].sku).join(', ') }
}

function quoteText(order, state) {
  const { amount, skus } = describe(order, quotedLines(state))
  return `I can refund ${amount} for ${order.order} (${skus}) to the card you paid with. Reply YES to confirm or NO to cancel. This offer is valid for 30 minutes.`
}

function statusLine(order, state) {
  const refunded = state.done.map((d, i) => (d && i < order.items.length ? i : null)).filter((i) => i !== null)
  const base = `${order.order} (placed ${order.placed}, ${money(order.total, order.currency)})`
  switch (state.phase) {
    case 'Closed':
      return `${base}: fully refunded.`
    case 'Issuing':
      return `${base}: a refund is being issued.`
    case 'Review':
      return `${base}: a refund is being checked by our team.`
    case 'Quoted':
      return `${base}: waiting for your YES to refund ${describe(order, quotedLines(state)).amount}.`
    default:
      return refunded.length ? `${base}: ${describe(order, refunded).skus} refunded.` : `${base}: no refund yet.`
  }
}

export function createAgent({ rt, orders }) {
  /** The order's instance, created (idempotently) on first use; its id is the order id. */
  async function stateOf(order) {
    const { state } = await rt.create(MACHINE, { id: order.order, creation: { action: 'Open', data: { lines: order.items.length } } })
    return (await rt.getState(order.order)).state ?? state
  }

  async function dispatch(order, action, data, actionId) {
    if (!CUSTOMER_ACTIONS.has(action)) throw new Error(`${action} is not a customer action`)
    await stateOf(order)
    return rt.dispatch(order.order, action, data, { actionId })
  }

  /** The order a message is about: the one it names, or the customer's only order with the given phases. */
  function pick(mine, intent, states, phases) {
    if (intent.order) return { order: mine.find((o) => o.order === intent.order) ?? null, named: true }
    const candidates = phases ? mine.filter((o) => phases.includes(states.get(o.order).phase)) : mine
    return { order: candidates.length === 1 ? candidates[0] : null, candidates }
  }

  function busyText(order, state) {
    if (state.phase === 'Issuing') return `A refund for ${order.order} is being issued right now. I'll message you when it is done.`
    if (state.phase === 'Review') return `A refund for ${order.order} is being checked by our team. They will get back to you.`
    if (state.phase === 'Closed') return `${order.order} has already been fully refunded.`
    return null
  }

  async function refund(mine, intent, states, actionId) {
    const { order, named, candidates } = pick(mine, intent, states)
    if (!order && named) return `I couldn't find ${intent.order} among the orders on this WhatsApp number.`
    if (!order) return `Which order would you like refunded? ${candidates.map((o) => o.order).join(', ')}. Reply for example "refund ${candidates[0].order}".`
    const state = states.get(order.order)
    const busy = busyText(order, state)
    if (busy) return busy
    const line = lineIn(intent.text, order)
    const r = line === null ? await dispatch(order, 'RequestAll', {}, actionId) : await dispatch(order, 'RequestLine', { line }, actionId)
    if (r.stepKind === 'accepted' || r.rejectReason === 'already-quoted') return quoteText(order, r.state)
    if (r.rejectReason === 'already-refunded') return `${order.items[line].sku} on ${order.order} has already been refunded.`
    return busyText(order, r.state) ?? `I couldn't start a refund for ${order.order} (${r.rejectReason}).`
  }

  async function confirm(mine, intent, states, actionId) {
    const { order, named, candidates } = pick(mine, intent, states, ['Quoted'])
    if (!order && named) return `I couldn't find ${intent.order} among the orders on this WhatsApp number.`
    if (!order && candidates.length === 0) return 'There is no refund waiting for your confirmation. Offers are valid for 30 minutes; send "refund" and the order number to start again.'
    if (!order) return `Several refunds are waiting: ${candidates.map((o) => o.order).join(', ')}. Reply for example "YES ${candidates[0].order}".`
    const r = await dispatch(order, 'Confirm', {}, actionId)
    if (r.stepKind !== 'accepted') {
      if (r.rejectReason === 'no-quote') return busyText(order, r.state) ?? `There is no refund waiting for your confirmation on ${order.order}. Offers are valid for 30 minutes; send "refund ${order.order}" to start again.`
      return `I couldn't confirm the refund for ${order.order} (${r.rejectReason}).`
    }
    // Issuing keeps the quote's Pick, and the lines are marked refunded only when Stripe answers.
    const { amount } = describe(order, quotedLines(r.state))
    return `Thank you. I'm issuing your refund of ${amount} for ${order.order} now, and I'll message you as soon as it is done.`
  }

  async function cancel(mine, intent, states, actionId) {
    const { order, named, candidates } = pick(mine, intent, states, ['Quoted'])
    if (!order && named) return `I couldn't find ${intent.order} among the orders on this WhatsApp number.`
    if (!order && candidates.length === 0) return 'There is no refund waiting for your confirmation, so there is nothing to cancel.'
    if (!order) return `Several refunds are waiting: ${candidates.map((o) => o.order).join(', ')}. Reply for example "NO ${candidates[0].order}".`
    const r = await dispatch(order, 'Cancel', {}, actionId)
    if (r.stepKind === 'accepted') return `OK, I won't refund ${order.order}. Send "refund ${order.order}" if you change your mind.`
    return busyText(order, r.state) ?? `There is no refund waiting for your confirmation on ${order.order}.`
  }

  /**
   * One message: `from` is the sender's WhatsApp id, `messageId` the Cloud API's message id, which makes the step it
   * takes happen once however often the webhook is delivered. Returns the reply text.
   */
  async function handle({ from, text, messageId }) {
    const mine = orders.ofCustomer(from)
    if (mine.length === 0) return "I couldn't find any orders for this WhatsApp number. Please write to us from the number you used when ordering."
    if (text === null || text === undefined) return HELP
    const intent = { ...parseMessage(text), text }
    const states = new Map()
    for (const o of mine) states.set(o.order, await stateOf(o))
    const actionId = `wa:${messageId}`
    switch (intent.kind) {
      case 'refund':
        return refund(mine, intent, states, actionId)
      case 'confirm':
        return confirm(mine, intent, states, actionId)
      case 'cancel':
        return cancel(mine, intent, states, actionId)
      case 'status': {
        const list = intent.order ? mine.filter((o) => o.order === intent.order) : mine
        if (list.length === 0) return `I couldn't find ${intent.order} among the orders on this WhatsApp number.`
        return list.map((o) => statusLine(o, states.get(o.order))).join('\n')
      }
      default:
        return HELP
    }
  }

  /** The operator's answer for an order in Review: whether the refund went through, as the Stripe dashboard shows. */
  async function resolve(orderId, issued) {
    const order = orders.get(orderId)
    if (!order) return null
    await stateOf(order)
    return rt.dispatch(order.order, issued ? 'ResolveIssued' : 'ResolveNotIssued', {}, { actionId: `resolve:${orderId}:${Date.now()}` })
  }

  return { handle, resolve, stateOf }
}
