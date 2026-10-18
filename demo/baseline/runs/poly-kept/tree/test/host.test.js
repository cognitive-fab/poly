// The host code beside the program: message parsing, webhook signatures and parsing, and the reply texts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from '../src/agent.js'
import { handshake, messagesOf, sign, signatureValid } from '../src/whatsapp.js'
import { linesOf, money, noticeText, ticketText } from '../src/effects.js'

test('parse reads refunds, confirmations, cancellations and anything else as help', () => {
  assert.deepEqual(parse('Refund ORD-1001 please').kind, 'refund')
  assert.equal(parse('refund ord-1001').order, 'ORD-1001')
  assert.equal(parse('ORD-1002').kind, 'refund')
  assert.equal(parse('yes').kind, 'confirm')
  assert.equal(parse('Yes ORD-1001').order, 'ORD-1001')
  assert.equal(parse('no thanks').kind, 'cancel')
  assert.equal(parse('hello').kind, 'help')
  assert.equal(parse('').kind, 'help')
  assert.equal(parse('not sure yet').kind, 'help')
})

test('signatures are checked against the raw body and the app secret', () => {
  const raw = Buffer.from('{"a":1}')
  assert.ok(signatureValid(raw, sign(raw, 's'), 's'))
  assert.ok(!signatureValid(raw, sign(raw, 's'), 't'))
  assert.ok(!signatureValid(Buffer.from('{"a":2}'), sign(raw, 's'), 's'))
  assert.ok(!signatureValid(raw, undefined, 's'))
  assert.ok(!signatureValid(raw, 'sha256=zz', 's'))
  assert.ok(!signatureValid(raw, sign(raw, ''), ''))
})

test('the handshake needs the subscribe mode and the token', () => {
  const q = (s) => new URLSearchParams(s)
  assert.equal(handshake(q('hub.mode=subscribe&hub.verify_token=t&hub.challenge=c'), 't'), 'c')
  assert.equal(handshake(q('hub.mode=subscribe&hub.verify_token=u&hub.challenge=c'), 't'), null)
  assert.equal(handshake(q('hub.mode=other&hub.verify_token=t&hub.challenge=c'), 't'), null)
  assert.equal(handshake(q('hub.mode=subscribe&hub.verify_token=&hub.challenge=c'), ''), null)
})

test('messagesOf takes the messages and skips statuses', () => {
  const body = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [
      { field: 'messages', value: { messages: [{ from: '1', id: 'a', timestamp: '10', type: 'text', text: { body: 'hi' } }, { from: '1', id: 'b', type: 'image' }] } },
      { field: 'messages', value: { statuses: [{ id: 'x', status: 'delivered' }] } },
    ] }],
  }
  assert.deepEqual(messagesOf(body), [
    { from: '1', id: 'a', text: 'hi', timestamp: 10000 },
    { from: '1', id: 'b', text: '', timestamp: null },
  ])
  assert.deepEqual(messagesOf({ object: 'page' }), [])
})

test('reply texts name the lines and the amount', () => {
  const order = { order: 'ORD-1', currency: 'usd', items: [{ sku: 'A-1', price: 1250 }, { sku: 'B-1', price: 750 }] }
  assert.deepEqual(linesOf(order, { l0: false, l1: true, l2: false, l3: false }).amount, 750)
  assert.equal(money(1250, 'usd'), '$12.50')
  assert.match(ticketText('AskConfirm', order, { l0: true, l1: true }), /\$20\.00 for order ORD-1/)
  assert.match(ticketText('Refunded', order, { l1: true }), /\$7\.50 for B-1 from order ORD-1/)
  assert.match(noticeText('Help', [order]), /ORD-1 \(A-1, B-1\)/)
})
