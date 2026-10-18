// The agent over the admitted runtime: conversations from a customer's first message to the refund and its notice.
import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { admitted, harness } from './fixture.js'

const ADA = '15550100001'
const BEN = '15550100002'

let project
let h
before(async () => {
  project = await admitted()
})
after(() => project.cleanup())
beforeEach(async () => {
  h = await harness(project)
})
afterEach(() => h.close())

const phase = async (id) => (await h.rt.getState(id)).state

test('a whole order is quoted, confirmed, refunded once through Stripe, and the customer is told', async () => {
  const quote = await h.say(ADA, 'Hi, I would like a refund for ORD-1001 please')
  assert.match(quote, /refund \$100\.00 for ORD-1001 \(BLENDER-1, CUPS-4\)/)
  assert.match(quote, /Reply YES/)
  assert.equal(h.apis.refunds.length, 0, 'nothing is refunded before the customer confirms')

  const ok = await h.say(ADA, 'yes')
  assert.match(ok, /issuing your refund of \$100\.00 for ORD-1001/)
  await h.settle()

  assert.equal(h.apis.refunds.length, 1)
  const [r] = h.apis.refunds
  assert.deepEqual(
    { charge: r.form.charge, amount: r.form.amount, order: r.form['metadata[order]'] },
    { charge: 'ch_demo_1001', amount: '10000', order: 'ORD-1001' },
  )
  assert.equal(r.headers.authorization, 'Bearer stripe-test-key')
  assert.ok(r.headers['idempotency-key'], 'the runtime keys every Stripe write')

  assert.equal(h.apis.messages.length, 1)
  assert.equal(h.apis.messages[0].to, ADA)
  assert.match(h.apis.messages[0].text, /refund of \$100\.00 for ORD-1001 \(BLENDER-1, CUPS-4\) has been issued/)
  assert.equal(h.apis.messages[0].url, 'https://graph.facebook.com/v21.0/1098765/messages')

  assert.equal((await phase('ORD-1001')).phase, 'Closed')
  assert.match(await h.say(ADA, 'refund ORD-1001'), /already been fully refunded/)
  assert.match(await h.say(ADA, 'yes'), /no refund waiting/)
  await h.settle()
  assert.equal(h.apis.refunds.length, 1, 'a closed order is never refunded again')
})

test('one line is refunded, then the rest of the order, and no line twice', async () => {
  assert.match(await h.say(ADA, 'refund CUPS-4 from ORD-1001'), /refund \$40\.00 for ORD-1001 \(CUPS-4\)/)
  await h.say(ADA, 'YES')
  await h.settle()
  assert.equal(h.apis.refunds.at(-1).form.amount, '4000')
  assert.equal((await phase('ORD-1001')).phase, 'Ready')

  assert.match(await h.say(ADA, 'refund cups-4 on ORD-1001'), /CUPS-4 on ORD-1001 has already been refunded/)
  assert.match(await h.say(ADA, 'refund ORD-1001'), /refund \$60\.00 for ORD-1001 \(BLENDER-1\)/)
  await h.say(ADA, 'yes')
  await h.settle()
  assert.deepEqual(h.apis.refunds.map((r) => r.form.amount), ['4000', '6000'])
  assert.equal((await phase('ORD-1001')).phase, 'Closed')
  assert.match(await h.say(ADA, 'status'), /ORD-1001 .*fully refunded/)
})

test("a customer cannot reach another customer's order", async () => {
  assert.match(await h.say(BEN, 'refund ORD-1001'), /couldn't find ORD-1001 among the orders on this WhatsApp number/)
  assert.match(await h.say('15550199999', 'refund ORD-1001'), /couldn't find any orders for this WhatsApp number/)
  await h.settle()
  assert.equal(h.apis.refunds.length, 0)
  await assert.rejects(h.rt.getState('ORD-1001'), /unknown instance/, "the other customer's order was not even touched")
})

test('a customer with several orders is asked which one, and confirms by order', async () => {
  assert.match(await h.say(BEN, 'I want my money back'), /Which order.*ORD-1002, ORD-1003/)
  await h.say(BEN, 'refund ORD-1002')
  await h.say(BEN, 'refund ORD-1003')
  assert.match(await h.say(BEN, 'yes'), /Several refunds are waiting: ORD-1002, ORD-1003/)
  assert.match(await h.say(BEN, 'yes ORD-1003'), /\$18\.00 for ORD-1003/)
  assert.match(await h.say(BEN, 'no'), /won't refund ORD-1002/)
  await h.settle()
  assert.deepEqual(h.apis.refunds.map((r) => r.form.charge), ['ch_demo_1003'])
  assert.equal((await phase('ORD-1002')).phase, 'Ready')
})

test('a quote expires after 30 minutes and cannot be confirmed after', async () => {
  await h.say(ADA, 'refund ORD-1001')
  h.clock.t += 31 * 60_000
  await h.rt.tick(h.clock.t)
  assert.equal((await phase('ORD-1001')).phase, 'Ready')
  assert.match(await h.say(ADA, 'yes'), /no refund waiting/)
  await h.settle()
  assert.equal(h.apis.refunds.length, 0)
})

test('a webhook delivered twice takes its step once', async () => {
  await h.say(ADA, 'refund ORD-1001', 'wamid.A')
  await h.say(ADA, 'yes', 'wamid.B')
  await h.say(ADA, 'yes', 'wamid.B')
  await h.settle()
  assert.equal(h.apis.refunds.length, 1)
})

test('a Stripe outage is retried under one idempotency key and refunds once', async () => {
  h.apis.stripe.push({ status: 500, body: { error: { message: 'boom' } } }, 'drop')
  await h.say(ADA, 'refund ORD-1001')
  await h.say(ADA, 'yes')
  await h.settle()
  assert.equal(h.apis.refunds.length, 3)
  const keys = new Set(h.apis.refunds.map((r) => r.headers['idempotency-key']))
  assert.equal(keys.size, 1, 'every attempt carries the same key, so Stripe refunds once')
  assert.equal((await phase('ORD-1001')).phase, 'Closed')
  assert.equal(h.apis.messages.length, 1)
})

test('a refusal from Stripe is not retried; the customer is told and may ask again', async () => {
  h.apis.stripe.push({ status: 400, body: { error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: 'Charge has already been refunded.' } } })
  await h.say(ADA, 'refund ORD-1001')
  await h.say(ADA, 'yes')
  await h.settle()
  assert.equal(h.apis.refunds.length, 1)
  assert.equal((await phase('ORD-1001')).phase, 'Ready')
  assert.match(h.apis.messages.at(-1).text, /could not issue the refund for ORD-1001/)
  assert.deepEqual((await phase('ORD-1001')).done, [false, false, true, true])
})

test('when Stripe cannot be reached at all, the order goes to review and a person resolves it', async () => {
  h.apis.stripe.push('drop', 'drop', 'drop')
  await h.say(ADA, 'refund ORD-1001')
  await h.say(ADA, 'yes')
  await h.settle()
  assert.equal(h.apis.refunds.length, 3)
  assert.equal((await phase('ORD-1001')).phase, 'Review')
  assert.match(h.apis.messages.at(-1).text, /team is checking it/)
  assert.match(await h.say(ADA, 'refund ORD-1001'), /being checked by our team/)

  const r = await h.agent.resolve('ORD-1001', true)
  assert.equal(r.stepKind, 'accepted')
  await h.settle()
  assert.equal((await phase('ORD-1001')).phase, 'Closed')
  assert.match(h.apis.messages.at(-1).text, /\$100\.00 for ORD-1001 .* has been issued/)
  assert.equal(h.apis.refunds.length, 3, 'resolving makes no further Stripe call')
})

test('while a refund is in flight, nothing else can be started on that order', async () => {
  await h.say(ADA, 'refund CUPS-4 ORD-1001')
  await h.say(ADA, 'yes')
  assert.equal((await phase('ORD-1001')).phase, 'Issuing')
  assert.match(await h.say(ADA, 'refund ORD-1001'), /being issued right now/)
  assert.match(await h.say(ADA, 'refund BLENDER-1 ORD-1001'), /being issued right now/)
  await h.settle()
  assert.equal(h.apis.refunds.length, 1)
})

test('the agent never dispatches the completions or the resolutions on behalf of a customer', async () => {
  const { CUSTOMER_ACTIONS } = await import('../lib/agent.js')
  assert.deepEqual([...CUSTOMER_ACTIONS].sort(), ['Cancel', 'Confirm', 'RequestAll', 'RequestLine'])
})
