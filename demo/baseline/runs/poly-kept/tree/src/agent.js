// The support agent's host logic: reads a customer's message, finds their order and feeds support.poly's machines.
// What may happen to an order (when a refund can be asked for, confirmed, issued, or not) is decided by the Ticket
// machine; this file only parses text, looks orders up, and turns a rejected step into the notice that explains it.

const DAY = 24 * 60 * 60 * 1000
export const MAX_LINES = 4

const YES = new Set(['YES', 'Y', 'CONFIRM', 'OK', 'SI', 'SÍ'])
const NO = new Set(['NO', 'N', 'CANCEL'])

/** What a message asks for: { kind: 'refund' | 'confirm' | 'cancel' | 'help', order?, words }. */
export function parse(text) {
  const words = String(text ?? '').toUpperCase().match(/[A-Z0-9][A-Z0-9_-]*/g) ?? []
  const order = words.find((w) => /^ORD-\d+$/.test(w))
  const first = words[0]
  if (first && YES.has(first)) return { kind: 'confirm', order, words }
  if (first && NO.has(first)) return { kind: 'cancel', order, words }
  if (words.includes('REFUND') || words.includes('RETURN') || order) return { kind: 'refund', order, words }
  return { kind: 'help', words }
}

/** The notice that explains a Ticket's rejection reason to the customer. */
export const NOTICE_FOR = {
  'awaiting-confirmation': 'AwaitingConfirmation',
  'refund-in-progress': 'RefundInProgress',
  'under-review': 'UnderReviewAlready',
  'outside-window': 'OutsideWindow',
  'no-such-item': 'NoSuchItem',
  'already-refunded': 'AlreadyRefunded',
  'nothing-to-confirm': 'NothingToConfirm',
}

export class Agent {
  /**
   * @param {import('@poly/runtime').PolyRuntime} rt
   * @param {object[]} orders the orders of orders.json
   * @param {{ windowDays?: number, now?: () => number }} [opts]
   */
  constructor(rt, orders, { windowDays = 30, now = Date.now } = {}) {
    this.rt = rt
    this.orders = new Map(orders.map((o) => [o.order, o]))
    this.windowDays = windowDays
    this.now = now
  }

  /** The store tables the effect handlers read (src/effects.js). */
  tables() {
    const byCustomer = new Map()
    for (const o of this.orders.values()) byCustomer.set(o.customer, [...(byCustomer.get(o.customer) ?? []), o])
    return { orders: this.orders, customers: byCustomer }
  }

  ticketId(order) {
    return `ticket:${order}`
  }

  async stateOf(id) {
    try {
      return await this.rt.getState(id)
    } catch {
      return null
    }
  }

  /** Answers one message with a Notice: an instance per message, so a redelivered webhook sends nothing twice. */
  async notice(message, msg, recipients) {
    const id = `notice:${message.id}`
    if (await this.stateOf(id)) return { notice: msg, duplicate: true }
    recipients.set(id, message.from)
    await this.rt.create('support.Notice', { id, creation: { action: 'Send', data: { msg } } })
    return { notice: msg }
  }

  /**
   * One customer message. `recipients` is the store table the notice handler reads the sender from.
   * Returns what was done, for logs and tests.
   */
  async handle(message, recipients) {
    const ask = parse(message.text)
    const actionId = `wa:${message.id}`
    const mine = (o) => o && o.customer === message.from

    if (ask.kind === 'help') return this.notice(message, 'Help', recipients)

    if (ask.kind === 'confirm' || ask.kind === 'cancel') {
      const waiting = []
      for (const o of this.orders.values()) {
        if (!mine(o) || (ask.order && o.order !== ask.order)) continue
        const s = await this.stateOf(this.ticketId(o.order))
        if (s?.state.phase === 'Confirming') waiting.push(o)
      }
      if (waiting.length === 0) return this.notice(message, 'NothingToConfirm', recipients)
      if (waiting.length > 1) return this.notice(message, 'Ambiguous', recipients)
      return this.step(message, waiting[0], ask.kind === 'confirm' ? 'Confirm' : 'Cancel', {}, actionId, recipients)
    }

    // A refund request. An order on another customer's number is answered as unknown, so nothing about it leaks.
    const order = ask.order ? this.orders.get(ask.order) : null
    if (!mine(order)) return this.notice(message, ask.order ? 'UnknownOrder' : 'Help', recipients)
    if (order.items.length > MAX_LINES) return this.notice(message, 'TooManyItems', recipients)

    const placed = Date.parse(`${order.placed}T00:00:00Z`)
    const inWindow = Number.isFinite(placed) && this.now() - placed <= this.windowDays * DAY
    // An item is named by its SKU, or by the SKU's name without its suffix ("BLENDER" for BLENDER-1).
    const lineOf = (w) => order.items.findIndex((i) => i.sku.toUpperCase() === w || i.sku.toUpperCase().startsWith(`${w}-`))
    const word = ask.words.find((w) => w !== order.order && lineOf(w) >= 0)
    if (!word && ask.words.some((w) => w !== order.order && /^[A-Z]+-\d+$/.test(w))) return this.notice(message, 'NoSuchItem', recipients)

    const id = this.ticketId(order.order)
    if (!(await this.stateOf(id))) {
      await this.rt.create('support.Ticket', { id, creation: { action: 'Open', data: { count: order.items.length } } })
    }
    return word
      ? this.step(message, order, 'RequestLine', { line: lineOf(word), inWindow }, actionId, recipients)
      : this.step(message, order, 'RequestAll', { inWindow }, actionId, recipients)
  }

  async step(message, order, action, data, actionId, recipients) {
    const id = this.ticketId(order.order)
    const before = await this.stateOf(id)
    if (before?.state.phase === 'Closed') return this.notice(message, 'OrderClosed', recipients)
    const r = await this.rt.dispatch(id, action, data, { actionId })
    if (r.stepKind === 'accepted') return { ticket: id, action, phase: r.state.phase }
    const notice = NOTICE_FOR[r.rejectReason] ?? 'Help'
    return { ticket: id, action, rejected: r.rejectReason, ...(await this.notice(message, notice, recipients)) }
  }

  /** An operator's verdict on a ticket under review: whether Stripe holds the refund. */
  async resolve(order, done) {
    const r = await this.rt.dispatch(this.ticketId(order), 'Resolve', { done: !!done }, { actionId: `resolve:${order}:${this.now()}` })
    return r.stepKind === 'accepted' ? { phase: r.state.phase } : { rejected: r.rejectReason ?? r.stepKind }
  }
}
