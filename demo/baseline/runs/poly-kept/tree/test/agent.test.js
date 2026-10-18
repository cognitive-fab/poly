// End to end over the admitted program: webhooks in, Stripe and WhatsApp requests out, through a recording transport.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../src/server.js'
import { ROOT } from '../src/runtime.js'
import { sign } from '../src/whatsapp.js'

const orders = JSON.parse(readFileSync(join(ROOT, 'orders.json'), 'utf8'))
const ADA = '15550100001'
const BEN = '15550100002'
const APP_SECRET = 'test-app-secret'
const T0 = Date.parse('2026-10-18T12:00:00Z')

/** A fake network: Stripe answers with the next scripted status (200 when the script is empty), WhatsApp with 200. */
function network() {
  const calls = []
  const script = []
  const egress = async (req) => {
    calls.push(req)
    if (req.url.startsWith('https://api.stripe.com/')) {
      const status = script.length ? script.shift() : 200
      return status === 200
        ? { status, body: JSON.stringify({ id: `re_${calls.length}`, object: 'refund', status: 'succeeded' }) }
        : { status, body: JSON.stringify({ error: { message: `scripted ${status}` } }) }
    }
    return { status: 200, body: JSON.stringify({ messages: [{ id: 'wamid.out' }] }) }
  }
  const stripe = () => calls.filter((c) => c.url.startsWith('https://api.stripe.com/'))
  const texts = (to) =>
    calls.filter((c) => c.url.startsWith('https://graph.facebook.com/')).map((c) => JSON.parse(c.body)).filter((b) => !to || b.to === to).map((b) => b.text.body)
  return { calls, script, egress, stripe, texts }
}

let n = 0
const webhook = (from, text, id = `wamid.${++n}`) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'PNID' },
    contacts: [{ wa_id: from, profile: { name: 'x' } }], messages: [{ from, id, timestamp: String(T0 / 1000), type: 'text', text: { body: text } }] } }] }],
})

let app
let net
let clock
let base

before(async () => {
  net = network()
  clock = { t: T0 }
  app = await start({
    orders,
    secrets: { STRIPE_SECRET_KEY: 'stripe-test-key', WHATSAPP_TOKEN: 'wa-test-token' },
    whatsapp: { appSecret: APP_SECRET, verifyToken: 'verify-me', phoneNumberId: 'PNID' },
    adminToken: 'admin-test-token',
    egress: net.egress,
    now: () => clock.t,
  })
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${app.server.address().port}`
})

after(async () => {
  await new Promise((r) => app.server.close(r))
  await app.rt.close()
})

/** Posts a signed webhook, then lets the runtime take every step that is due. */
async function say(from, text, id) {
  const raw = JSON.stringify(webhook(from, text, id))
  const res = await fetch(`${base}/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw, APP_SECRET) } })
  assert.equal(res.status, 200)
  await settle()
}

/** Runs the workers until nothing is due, moving the clock past each retry's backoff. */
async function settle() {
  for (let i = 0; i < 10; i++) {
    await app.rt.advance()
    clock.t += 60_000
  }
  await app.rt.advance()
}

const phase = async (order) => (await app.rt.getState(`ticket:${order}`)).state.phase
const last = (to) => net.texts(to).at(-1)

test('the webhook handshake echoes the challenge only for the verify token', async () => {
  const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`)
  assert.equal(ok.status, 200)
  assert.equal(await ok.text(), '42')
  const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`)
  assert.equal(bad.status, 403)
})

test('a webhook with a bad signature is refused and nothing is sent', async () => {
  const before = net.calls.length
  const raw = JSON.stringify(webhook(ADA, 'refund ORD-1001'))
  const res = await fetch(`${base}/webhook`, { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sign(raw, 'wrong-secret') } })
  assert.equal(res.status, 401)
  await settle()
  assert.equal(net.calls.length, before)
})

test('a greeting gets help listing the customer\'s own orders only', async () => {
  await say(BEN, 'hi there')
  assert.match(last(BEN), /refund ORDER/)
  assert.match(last(BEN), /ORD-1002/)
  assert.doesNotMatch(last(BEN), /ORD-1001/)
})

test('another customer\'s order is unknown, and nothing is refunded', async () => {
  await say(BEN, 'refund ORD-1001')
  assert.match(last(BEN), /could not find that order/)
  assert.equal(net.stripe().length, 0)
  assert.equal(net.texts(ADA).length, 0)
})

test('one item, then the rest: each confirmed, each refunded once, with an idempotency key', async () => {
  await say(ADA, 'I want a refund for the cups on ORD-1001')
  assert.match(last(ADA), /refund of \$40\.00 for CUPS-4 from order ORD-1001/)
  assert.equal(await phase('ORD-1001'), 'Confirming')
  assert.equal(net.stripe().length, 0, 'no money moves before the customer confirms')

  await say(ADA, 'refund ORD-1001')
  assert.match(last(ADA), /already have a refund waiting/)

  await say(ADA, 'yes')
  const [first] = net.stripe()
  assert.equal(net.stripe().length, 1)
  assert.equal(first.url, 'https://api.stripe.com/v1/refunds')
  const form = new URLSearchParams(first.body)
  assert.equal(form.get('charge'), 'ch_demo_1001')
  assert.equal(form.get('amount'), '4000')
  assert.equal(first.headers.authorization, 'Bearer stripe-test-key')
  assert.ok(first.headers['idempotency-key'], 'the runtime keys the write')
  assert.match(last(ADA), /Done: \$40\.00 for CUPS-4/)
  assert.equal(await phase('ORD-1001'), 'Idle')

  await say(ADA, 'refund ORD-1001 cups')
  assert.match(last(ADA), /already been refunded/)

  await say(ADA, 'refund ORD-1001')
  assert.match(last(ADA), /refund of \$60\.00 for BLENDER-1 from order ORD-1001/)
  await say(ADA, 'YES ORD-1001')
  assert.equal(net.stripe().length, 2)
  assert.equal(new URLSearchParams(net.stripe()[1].body).get('amount'), '6000')
  assert.notEqual(net.stripe()[1].headers['idempotency-key'], first.headers['idempotency-key'])
  assert.equal(await phase('ORD-1001'), 'Closed')

  await say(ADA, 'refund ORD-1001')
  assert.match(last(ADA), /fully refunded already/)
  assert.equal(net.stripe().length, 2)
})

test('a webhook delivered twice is answered once', async () => {
  const sent = net.texts(BEN).length
  await say(BEN, 'refund ORD-1002', 'wamid.dup')
  await say(BEN, 'refund ORD-1002', 'wamid.dup')
  assert.equal(net.texts(BEN).length, sent + 1)
  assert.match(last(BEN), /refund of \$25\.00 for order ORD-1002/)
})

test('NO cancels a request, and YES then has nothing to confirm', async () => {
  await say(BEN, 'no')
  assert.match(last(BEN), /no refund was made/)
  assert.equal(await phase('ORD-1002'), 'Idle')
  await say(BEN, 'yes')
  assert.match(last(BEN), /no refund waiting for your confirmation/)
  assert.equal(net.stripe().length, 2)
})

test('a refusal from Stripe tells the customer, and they may ask again', async () => {
  await say(BEN, 'refund ORD-1002')
  net.script.push(402)
  await say(BEN, 'yes')
  assert.equal(net.stripe().length, 3)
  assert.match(last(BEN), /could not refund order ORD-1002/)
  assert.equal(await phase('ORD-1002'), 'Idle')
})

test('a Stripe outage is retried with the same key; refunded once', async () => {
  await say(BEN, 'refund ORD-1002')
  net.script.push(503)
  await say(BEN, 'yes')
  const tries = net.stripe().slice(3)
  assert.equal(tries.length, 2)
  assert.equal(tries[0].headers['idempotency-key'], tries[1].headers['idempotency-key'])
  assert.match(last(BEN), /Done: \$25\.00 for order ORD-1002/)
  assert.equal(await phase('ORD-1002'), 'Closed')
})

test('requests outside the refund window are refused before anything is asked', async () => {
  const saved = app.agent.orders.get('ORD-1002')
  app.agent.orders.set('ORD-9001', { ...saved, order: 'ORD-9001', charge: 'ch_old', placed: '2026-08-01' })
  try {
    await say(BEN, 'refund ORD-9001')
    assert.match(last(BEN), /outside our refund window/)
    assert.equal(await phase('ORD-9001'), 'Idle')
  } finally {
    app.agent.orders.delete('ORD-9001')
  }
})

test('a request survives a restart on the same store, under a new admission key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'support-store-'))
  const store = join(dir, 'store.sqlite')
  const own = network()
  const opts = {
    orders,
    secrets: { STRIPE_SECRET_KEY: 'k', WHATSAPP_TOKEN: 't' },
    whatsapp: { appSecret: APP_SECRET, verifyToken: 'v', phoneNumberId: 'PNID' },
    egress: own.egress,
    store,
    now: () => T0,
  }
  const one = await start(opts)
  await one.agent.handle({ from: ADA, id: 'wamid.r1', text: 'refund ORD-1001' }, one.recipients)
  await one.rt.advance()
  assert.match(own.texts(ADA).at(-1), /\$100\.00 for order ORD-1001/)
  await one.rt.close()

  const two = await start(opts)
  try {
    assert.equal((await two.rt.getState('ticket:ORD-1001')).state.phase, 'Confirming')
    await two.agent.handle({ from: ADA, id: 'wamid.r2', text: 'yes' }, two.recipients)
    await two.rt.advance()
    await two.rt.advance()
    assert.equal(own.stripe().length, 1)
    assert.equal(new URLSearchParams(own.stripe()[0].body).get('amount'), '10000')
    assert.equal((await two.rt.getState('ticket:ORD-1001')).state.phase, 'Closed')
  } finally {
    await two.rt.close()
  }
})

test('an unknown outcome goes to a person; their verdict settles it without a second refund', async () => {
  const saved = app.agent.orders.get('ORD-1002')
  app.agent.orders.set('ORD-9002', { ...saved, order: 'ORD-9002', charge: 'pi_9002' })
  try {
    await say(BEN, 'refund ORD-9002')
    net.script.push(500, 500, 500)
    const before = net.stripe().length
    await say(BEN, 'yes')
    assert.equal(net.stripe().length - before, 3, 'three attempts, then the runtime stops')
    assert.equal(new URLSearchParams(net.stripe().at(-1).body).get('payment_intent'), 'pi_9002')
    assert.equal(await phase('ORD-9002'), 'Review')
    assert.match(last(BEN), /A person on our team is checking it/)

    await say(BEN, 'refund ORD-9002')
    assert.match(last(BEN), /being checked by our team/)

    const denied = await fetch(`${base}/admin/resolve`, { method: 'POST', body: JSON.stringify({ order: 'ORD-9002', done: true }) })
    assert.equal(denied.status, 403)
    const res = await fetch(`${base}/admin/resolve`, {
      method: 'POST', headers: { authorization: 'Bearer admin-test-token' }, body: JSON.stringify({ order: 'ORD-9002', done: true }),
    })
    assert.deepEqual(await res.json(), { phase: 'Closed' })
    await settle()
    assert.match(last(BEN), /Done: \$25\.00 for order ORD-9002/)
    assert.equal(net.stripe().length - before, 3, 'the verdict refunds nothing itself')
  } finally {
    app.agent.orders.delete('ORD-9002')
  }
})
