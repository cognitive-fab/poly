// The host of src/support.poly: turns each inbound WhatsApp message into steps of the machines, and gives the effect
// handlers the records they read. What a message means is decided here (src/agent.js); whether a line may be refunded,
// and how often, is the Line machine's to decide.
import { readFileSync } from 'node:fs'
import { digits, selectLines, understand } from './agent.js'

export const LINE = 'support.Line'
export const INQUIRY = 'support.Inquiry'

/** A Line's instance id: the order and the item's position in it. */
export const lineId = (order, index) => `${order}:${index}`
export const inquiryId = (messageId) => `wa:${messageId}`

export class SupportHost {
  #rt
  #ordersFile
  #tables
  #queue = Promise.resolve()

  constructor(rt, { ordersFile, tables }) {
    this.#rt = rt
    this.#ordersFile = ordersFile
    this.#tables = tables
  }

  /** orders.json, read on each use, so an order added while the agent runs is known at once. */
  orders() {
    return JSON.parse(readFileSync(this.#ordersFile, 'utf8'))
  }

  /** The record of one order line, as the Line's handlers read it (table `lines`, key: the instance id). */
  line(id) {
    const at = id.lastIndexOf(':')
    const order = this.orders().find((o) => o.order === id.slice(0, at))
    const item = order?.items[Number(id.slice(at + 1))]
    if (!item) return null
    return { order: order.order, sku: item.sku, amount: item.price, currency: order.currency, charge: order.charge, customer: digits(order.customer) }
  }

  /** The `store` transport the handlers' capabilities are built over; they only read. */
  storeTransport() {
    return {
      read: (table, key) => (table === 'lines' ? this.line(key) : this.#tables.get(table, key)),
      write: () => {
        throw new Error('the handlers do not write to the store')
      },
    }
  }

  /** One message at a time, so a webhook delivered twice at once is still answered once. */
  handleMessage(msg) {
    const run = this.#queue.then(() => this.#handle(msg))
    this.#queue = run.catch(() => {})
    return run
  }

  async #exists(id) {
    try {
      await this.#rt.getState(id)
      return true
    } catch {
      return false
    }
  }

  async #lineStatus(id) {
    return (await this.#exists(id)) ? (await this.#rt.getState(id)).state.status : 'Open'
  }

  async #describe(order, index, extra = {}) {
    const item = order.items[index]
    return { sku: item.sku, amount: item.price, currency: order.currency, status: await this.#lineStatus(lineId(order.order, index)), ...extra }
  }

  async #handle(msg) {
    const id = inquiryId(msg.id)
    if (await this.#exists(id)) return { inquiry: id, duplicate: true }
    const from = digits(msg.from)
    const orders = this.orders()
    const mine = orders.filter((o) => digits(o.customer) === from)
    const asked = understand(msg.text)
    const record = { to: from, name: msg.name ?? mine[0]?.name ?? null, intent: asked.intent, order: asked.order, orders: mine.map((o) => o.order), item: null, lines: [] }
    const outcome = await this.#decide(id, from, orders, mine, asked, record)
    this.#tables.set('inquiries', id, record)
    await this.#rt.create(INQUIRY, { id, creation: { action: 'Answer', data: { outcome } } })
    return { inquiry: id, outcome, record }
  }

  async #decide(id, from, orders, mine, asked, record) {
    if (asked.intent === 'help') return 'Help'
    if (!asked.order && mine.length !== 1) return 'NeedOrder'
    const order = asked.order ? orders.find((o) => o.order.toUpperCase() === asked.order) : mine[0]
    if (!order) return 'NotFound'
    record.order = order.order
    const owner = digits(order.customer) === from
    const chosen = selectLines(order, asked)
    const all = order.items.map((_, i) => i)
    if (asked.intent === 'status') {
      if (!owner) return 'NotFound'
      for (const i of chosen.unknown ? all : chosen.lines.map((l) => l.index)) record.lines.push(await this.#describe(order, i))
      return 'Status'
    }
    if (chosen.unknown) {
      if (!owner) return 'NotFound'
      record.item = chosen.unknown
      for (const i of all) record.lines.push(await this.#describe(order, i))
      return 'NoItem'
    }
    // Every request reaches its lines, a stranger's too: the Line refuses it (not-owner), and the journal keeps the try.
    const results = []
    for (const { index } of chosen.lines) {
      const line = lineId(order.order, index)
      if (!(await this.#exists(line))) await this.#rt.create(LINE, { id: line })
      const r = await this.#rt.dispatch(line, 'Request', { fromOwner: owner }, { actionId: `${id}:${index}` })
      results.push(await this.#describe(order, index, { started: r.stepKind === 'accepted' }))
    }
    if (!owner) return 'NotFound'
    record.lines = results
    return results.some((l) => l.started) ? 'Started' : 'NothingToRefund'
  }
}
