// The pure parts: the message parser, orders.json's validation, the webhook's signature and shape, and the handlers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMessage, lineIn, orderIn } from '../lib/parse.js'
import { indexOrders, loadOrders } from '../lib/orders.js'
import { validSignature, sign, handshake, messagesOf } from '../lib/webhook.js'
import { refund } from '../handlers/stripe.js'
import { notify } from '../handlers/whatsapp.js'
import { amountOf, money, noticeText } from '../handlers/lines.js'
import { ORDERS } from './fixture.js'

const ORDER = ORDERS[0]

test('the parser reads intents and order ids', () => {
  assert.deepEqual(parseMessage('Refund ORD-1001 please'), { kind: 'refund', order: 'ORD-1001' })
  assert.deepEqual(parseMessage('i want my money back for ord 1002'), { kind: 'refund', order: 'ORD-1002' })
  assert.deepEqual(parseMessage('YES'), { kind: 'confirm', order: null })
  assert.deepEqual(parseMessage('yes ORD-1003'), { kind: 'confirm', order: 'ORD-1003' })
  assert.deepEqual(parseMessage('no thanks'), { kind: 'cancel', order: null })
  assert.deepEqual(parseMessage('status'), { kind: 'status', order: null })
  assert.deepEqual(parseMessage('hello'), { kind: 'help', order: null })
  assert.equal(parseMessage('yesterday my blender broke, refund').kind, 'refund', '"yesterday" is not "yes"')
  assert.equal(orderIn('nothing here'), null)
})

test('the parser finds the one line a message names', () => {
  assert.equal(lineIn('refund cups-4', ORDER), 1)
  assert.equal(lineIn('refund BLENDER-1 and CUPS-4', ORDER), null, 'two lines is the whole order, not one')
  assert.equal(lineIn('refund CUPS-40', ORDER), null)
  assert.equal(lineIn('refund ORD-1001', ORDER), null)
})

test('orders.json loads, and an order the machine cannot hold is refused', () => {
  const real = loadOrders(new URL('../orders.json', import.meta.url))
  assert.deepEqual([...real.byId.keys()], ['ORD-1001', 'ORD-1002'])
  assert.equal(real.problems.length, 0)
  assert.deepEqual(real.ofCustomer('+1 555 010 0001').map((o) => o.order), ['ORD-1001'])

  const bad = indexOrders([
    { ...ORDER, order: 'ORD-1', total: 9999 },
    { ...ORDER, order: 'ORD-2', items: Array.from({ length: 5 }, (_, i) => ({ sku: `S${i}`, price: 2000 })) },
    { ...ORDER, order: 'ORD-3', items: [{ sku: 'X', price: 0 }], total: 0 },
    { ...ORDER, order: 'ORD-4', charge: '' },
    ORDER,
    ORDER,
  ])
  assert.deepEqual(bad.problems.map((p) => p.order), ['ORD-1', 'ORD-2', 'ORD-3', 'ORD-4', 'ORD-1001'])
  assert.deepEqual([...bad.byId.keys()], ['ORD-1001'])
})

test('the webhook signature is checked against the raw body', () => {
  const raw = Buffer.from('{"object":"whatsapp_business_account"}')
  assert.ok(validSignature(raw, sign(raw, 's3cret'), 's3cret'))
  assert.ok(!validSignature(raw, sign(raw, 'other'), 's3cret'))
  assert.ok(!validSignature(Buffer.from(raw.toString() + ' '), sign(raw, 's3cret'), 's3cret'))
  assert.ok(!validSignature(raw, undefined, 's3cret'))
  assert.ok(!validSignature(raw, 'sha256=abc', 's3cret'))
  assert.ok(!validSignature(raw, sign(raw, ''), ''), 'no app secret configured accepts nothing')
})

test('the verification handshake echoes the challenge only for the right token', () => {
  const q = (s) => new URLSearchParams(s)
  assert.equal(handshake(q('hub.mode=subscribe&hub.verify_token=tok&hub.challenge=42'), 'tok'), '42')
  assert.equal(handshake(q('hub.mode=subscribe&hub.verify_token=bad&hub.challenge=42'), 'tok'), null)
  assert.equal(handshake(q('hub.mode=unsubscribe&hub.verify_token=tok&hub.challenge=42'), 'tok'), null)
})

test('a Cloud API notification yields its messages and not its statuses', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA', changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '1098765' },
          contacts: [{ profile: { name: 'Ada' }, wa_id: '15550100001' }],
          messages: [
            { from: '15550100001', id: 'wamid.1', timestamp: '1790000000', type: 'text', text: { body: 'refund ORD-1001' } },
            { from: '15550100001', id: 'wamid.2', timestamp: '1790000001', type: 'image', image: { id: 'img' } },
            { from: '15550100001', id: 'wamid.3', timestamp: '1790000002', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'y', title: 'Yes' } } },
          ],
          statuses: [{ id: 'wamid.out', status: 'delivered', recipient_id: '15550100001' }],
        },
      }],
    }],
  }
  assert.deepEqual(messagesOf(payload).map((m) => [m.id, m.text, m.phoneNumberId]), [
    ['wamid.1', 'refund ORD-1001', '1098765'],
    ['wamid.2', null, '1098765'],
    ['wamid.3', 'Yes', '1098765'],
  ])
  assert.deepEqual(messagesOf({ object: 'page' }), [])
})

test('amounts are priced from the lines a payload names', () => {
  assert.equal(amountOf(ORDER, { l0: true, l1: true, l2: false, l3: false }), 10000)
  assert.equal(amountOf(ORDER, { l0: false, l1: true, l2: false, l3: false }), 4000)
  assert.throws(() => amountOf(ORDER, { l0: false, l1: false, l2: true, l3: false }), /no line 2/)
  assert.equal(money(2500, 'usd'), '$25.00')
  assert.match(noticeText(ORDER, { event: 'Issued', l0: true, l1: false, l2: false, l3: false }), /\$60\.00 for ORD-1001 \(BLENDER-1\)/)
})

/** Capabilities as the runtime builds them, over a scripted answer. */
function caps(answer) {
  const calls = []
  return {
    calls,
    egress: { post: async (url, body, opts) => (calls.push({ url, body, headers: opts.headers }), answer) },
    secrets: { get: async (n) => `secret:${n}` },
    store: { read: async (t, k) => (t === 'orders' && k === ORDER.order ? ORDER : t === 'whatsapp' ? { phoneNumberId: '1098765' } : null) },
  }
}
const ctx = { instanceId: ORDER.order, idempotencyKey: 'k', seq: 1, attempt: 1 }

test('the Stripe handler posts the refund and classifies the answer', async () => {
  const ok = caps({ status: 200, body: JSON.stringify({ id: 're_1', status: 'pending' }) })
  assert.deepEqual(await refund({ l0: false, l1: true, l2: false, l3: false }, ok, ctx), { refund: 're_1', status: 'pending', amount: 4000 })
  assert.equal(ok.calls[0].url, 'https://api.stripe.com/v1/refunds')
  assert.equal(new URLSearchParams(ok.calls[0].body).get('charge'), 'ch_demo_1001')
  assert.equal(ok.calls[0].headers.authorization, 'Bearer secret:STRIPE_SECRET_KEY')

  const declined = caps({ status: 402, body: JSON.stringify({ error: { type: 'card_error', message: 'no' } }) })
  await assert.rejects(refund({ l0: true, l1: false, l2: false, l3: false }, declined, ctx), (e) => e.permanent === true)

  for (const status of [409, 429, 503]) {
    const transient = caps({ status, body: '{}' })
    await assert.rejects(refund({ l0: true, l1: false, l2: false, l3: false }, transient, ctx), (e) => !e.permanent)
  }
  const failed = caps({ status: 200, body: JSON.stringify({ id: 're_2', status: 'failed' }) })
  await assert.rejects(refund({ l0: true, l1: false, l2: false, l3: false }, failed, ctx), (e) => e.permanent === true)

  const none = caps({ status: 200, body: '{}' })
  await assert.rejects(refund({ l0: false, l1: false, l2: false, l3: false }, none, ctx), (e) => e.permanent === true)
  assert.equal(none.calls.length, 0, 'an empty refund never reaches Stripe')
})

test('the WhatsApp handler sends the notice to the order\'s customer', async () => {
  const c = caps({ status: 200, body: JSON.stringify({ messages: [{ id: 'wamid.9' }] }) })
  assert.deepEqual(await notify({ event: 'Declined', l0: false, l1: false, l2: false, l3: false }, c, ctx), { message: 'wamid.9' })
  const sent = JSON.parse(c.calls[0].body)
  assert.equal(c.calls[0].url, 'https://graph.facebook.com/v21.0/1098765/messages')
  assert.equal(sent.to, '15550100001')
  assert.match(sent.text.body, /could not issue the refund for ORD-1001/)
})
