// The customers' orders, from orders.json. Each order that the Order machine can hold (one to four lines whose prices
// add up to its total) is indexed by its id and by its customer's WhatsApp number; any other is listed as a problem
// and is never refunded by the agent.
import { readFileSync } from 'node:fs'

export const MAX_LINES = 4

/** A WhatsApp id as the Cloud API writes it: the number's digits, with no "+" or separators. */
export const normalPhone = (s) => String(s ?? '').replace(/\D/g, '')

/** Why an order cannot be served by the agent, or null. */
export function orderProblem(o) {
  if (!o || typeof o !== 'object') return 'not an object'
  if (typeof o.order !== 'string' || !/^[A-Z0-9-]+$/.test(o.order)) return 'order id missing or malformed'
  if (!normalPhone(o.customer)) return 'customer number missing'
  if (typeof o.charge !== 'string' || !o.charge) return 'charge missing'
  if (typeof o.currency !== 'string' || !/^[a-z]{3}$/i.test(o.currency)) return 'currency missing'
  if (!Array.isArray(o.items) || o.items.length < 1) return 'no items'
  if (o.items.length > MAX_LINES) return `more than ${MAX_LINES} items`
  for (const it of o.items) {
    if (typeof it?.sku !== 'string' || !it.sku) return 'an item has no sku'
    if (!Number.isInteger(it.price) || it.price <= 0) return `item ${it.sku} has no positive integer price`
  }
  const sum = o.items.reduce((s, it) => s + it.price, 0)
  if (sum !== o.total) return `items add up to ${sum}, not the total ${o.total}`
  return null
}

export function indexOrders(list) {
  if (!Array.isArray(list)) throw new Error('orders.json must hold an array of orders')
  const byId = new Map()
  const byCustomer = new Map()
  const problems = []
  for (const o of list) {
    const problem = orderProblem(o)
    if (problem) {
      problems.push({ order: o?.order ?? null, problem })
      continue
    }
    if (byId.has(o.order)) {
      problems.push({ order: o.order, problem: 'duplicate order id' })
      continue
    }
    const order = { ...o, customer: normalPhone(o.customer), currency: o.currency.toLowerCase() }
    byId.set(order.order, order)
    const mine = byCustomer.get(order.customer) ?? []
    mine.push(order)
    byCustomer.set(order.customer, mine)
  }
  return {
    byId,
    problems,
    get: (id) => byId.get(id) ?? null,
    ofCustomer: (phone) => byCustomer.get(normalPhone(phone)) ?? [],
  }
}

export function loadOrders(path) {
  return indexOrders(JSON.parse(readFileSync(path, 'utf8')))
}
