import { test } from 'node:test'
import assert from 'node:assert/strict'
import { digits, selectLines, understand } from '../src/agent.js'
import { money, noticeText, replyText } from '../src/messages.js'
import { ORDERS } from './fixture.js'

const ada = ORDERS[0]

test('understand: intents and order numbers', () => {
  assert.deepEqual([understand('refund ORD-1001').intent, understand('refund ORD-1001').order], ['refund', 'ORD-1001'])
  assert.equal(understand('I want my money back for ord 1001').order, 'ORD-1001')
  assert.equal(understand('please return order #1002').order, 'ORD-1002')
  assert.equal(understand('Where is my refund for ORD-1002?').intent, 'refund')
  assert.equal(understand('status ORD-1002').intent, 'status')
  assert.equal(understand('hello there').intent, 'help')
  assert.equal(understand('').intent, 'help')
  assert.equal(understand('refund please').order, null)
})

test('selectLines: no item named is the whole order', () => {
  assert.deepEqual(selectLines(ada, understand('refund ORD-1001')).lines.map((l) => l.sku), ['BLENDER-1', 'CUPS-4'])
})

test('selectLines: an item by SKU, by name, or by plural name', () => {
  assert.deepEqual(selectLines(ada, understand('refund ORD-1001 cups-4')).lines.map((l) => l.sku), ['CUPS-4'])
  assert.deepEqual(selectLines(ada, understand('refund the blender on ORD-1001')).lines.map((l) => l.sku), ['BLENDER-1'])
  assert.deepEqual(selectLines(ada, understand('refund the cup')).lines.map((l) => l.sku), ['CUPS-4'])
  assert.deepEqual(selectLines(ada, understand('refund the cups')).lines.map((l) => l.sku), ['CUPS-4'])
  assert.deepEqual(selectLines(ada, understand('refund everything, the blender too')).lines.map((l) => l.sku), ['BLENDER-1', 'CUPS-4'])
})

test('selectLines: a SKU the order does not hold is unknown, never the whole order', () => {
  const r = selectLines(ada, understand('refund ORD-1001 TOASTER-9'))
  assert.equal(r.unknown, 'TOASTER-9')
  assert.deepEqual(r.lines, [])
})

test('digits normalises phone numbers', () => {
  assert.equal(digits('+1 (555) 010-0001'), '15550100001')
  assert.equal(digits(undefined), '')
})

test('texts', () => {
  assert.equal(money(6000, 'usd'), '$60.00')
  assert.equal(money(2500, 'eur'), '€25.00')
  const line = { order: 'ORD-1001', sku: 'BLENDER-1', amount: 6000, currency: 'usd' }
  assert.match(noticeText('RefundIssued', line), /^Your refund of \$60\.00 for BLENDER-1 \(order ORD-1001\) has been issued/)
  assert.match(noticeText('RefundNotIssued', line), /team will follow up/)
  const started = replyText('Started', {
    order: 'ORD-1001',
    lines: [{ sku: 'BLENDER-1', amount: 6000, currency: 'usd', status: 'Refunding', started: true }, { sku: 'CUPS-4', amount: 4000, currency: 'usd', status: 'Refunded', started: false }],
  })
  assert.match(started, /refunding \$60\.00 on order ORD-1001/)
  assert.match(started, /Not refunded again:\n• CUPS-4 \$40\.00: refunded/)
  assert.match(replyText('Help', { name: 'Ada Demo' }), /^Hi Ada!/)
  assert.match(replyText('NeedOrder', { orders: [], intent: 'refund' }), /couldn't find any orders/)
  assert.match(replyText('NotFound', { order: null }), /^I couldn't find order for this/)
  for (const o of ['Help', 'NeedOrder', 'NotFound', 'NoItem', 'Started', 'NothingToRefund', 'Status'])
    assert.equal(typeof replyText(o, { name: null, order: 'ORD-1', orders: ['ORD-1'], item: 'X-1', lines: [{ sku: 'A-1', amount: 1, currency: 'usd', status: 'Open', started: true }] }), 'string')
})
