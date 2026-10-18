// The agent end to end on the admitted build: messages in, Stripe refunds and WhatsApp replies out (fake APIs).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { startAgent } from '../src/app.js'
import { admitted, fakeApis, SECRETS, settle } from './fixture.js'

let project
before(async () => {
  project = await admitted()
})
after(() => project?.remove())

let n = 0
/** A fresh agent (in-memory store) over the admitted build, with its own fake APIs. */
async function agent(apis = fakeApis(), opts = {}) {
  const a = await startAgent({ root: project.root, trust: project.trust, secrets: (k) => SECRETS[k], egress: apis.egress, dataDir: null, log: {}, ...opts })
  const say = async (from, text, id = `wamid.in${++n}`) => {
    const r = await a.host.handleMessage({ id, from, text, name: null })
    await settle(a.rt)
    return r
  }
  return { ...a, apis, say }
}

describe('refunds', () => {
  test('the owner refunds a whole order: one Stripe refund per item, keyed, then a reply and a notice per item', async () => {
    const a = await agent()
    try {
      const r = await a.say('15550100001', 'Hi, I want a refund for ORD-1001 please')
      assert.equal(r.outcome, 'Started')
      const calls = a.apis.stripeCalls()
      assert.equal(calls.length, 2)
      const forms = calls.map((c) => Object.fromEntries(new URLSearchParams(c.body)))
      assert.deepEqual(forms.map((f) => [f.charge, f.amount, f['metadata[sku]']]).sort(), [['ch_demo_1001', '4000', 'CUPS-4'], ['ch_demo_1001', '6000', 'BLENDER-1']])
      for (const c of calls) {
        assert.equal(c.method, 'POST')
        assert.equal(c.url, 'https://api.stripe.com/v1/refunds')
        assert.equal(c.headers.authorization, 'Bearer stripe-test-secret')
        assert.ok(c.headers['idempotency-key'], 'every refund carries an idempotency key')
      }
      assert.notEqual(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key'])
      assert.equal(a.apis.refunds.size, 2)

      const texts = a.apis.sent.map((s) => s.text)
      assert.ok(a.apis.sent.every((s) => s.to === '15550100001' && s.auth === 'Bearer wa-test-token'))
      assert.ok(a.apis.sent.every((s) => s.url === 'https://graph.facebook.com/v24.0/1234567890/messages'))
      assert.equal(texts.length, 3)
      assert.match(texts[0], /refunding \$100\.00 on order ORD-1001/)
      assert.ok(texts.some((t) => /refund of \$60\.00 for BLENDER-1 \(order ORD-1001\) has been issued/.test(t)))
      assert.ok(texts.some((t) => /refund of \$40\.00 for CUPS-4 \(order ORD-1001\) has been issued/.test(t)))
      for (const i of [0, 1]) assert.equal((await a.rt.getState(`ORD-1001:${i}`)).state.status, 'Refunded')
    } finally {
      await a.close()
    }
  })

  test('asking again refunds nothing more', async () => {
    const a = await agent()
    try {
      await a.say('15550100001', 'refund ORD-1001')
      const again = await a.say('15550100001', 'refund ORD-1001 again!')
      assert.equal(again.outcome, 'NothingToRefund')
      assert.equal(a.apis.stripeCalls().length, 2)
      assert.match(a.apis.sent.at(-1).text, /nothing left to refund on order ORD-1001/)
      assert.match(a.apis.sent.at(-1).text, /BLENDER-1 \$60\.00: refunded/)
    } finally {
      await a.close()
    }
  })

  test('one item, named by its SKU or by its name, refunds that item only', async () => {
    const a = await agent()
    try {
      const r = await a.say('15550100001', 'refund ORD-1001 BLENDER-1')
      assert.equal(r.outcome, 'Started')
      assert.equal(a.apis.stripeCalls().length, 1)
      assert.equal(new URLSearchParams(a.apis.stripeCalls()[0].body).get('amount'), '6000')
      const cups = await a.say('15550100001', 'can I get my money back for the cups on order 1001')
      assert.equal(cups.outcome, 'Started')
      assert.equal(a.apis.stripeCalls().length, 2)
      assert.equal(new URLSearchParams(a.apis.stripeCalls()[1].body).get('amount'), '4000')
    } finally {
      await a.close()
    }
  })

  test('an item the order does not hold is never read as the whole order', async () => {
    const a = await agent()
    try {
      const r = await a.say('15550100001', 'refund ORD-1001 TOASTER-9')
      assert.equal(r.outcome, 'NoItem')
      assert.equal(a.apis.stripeCalls().length, 0)
      assert.match(a.apis.sent[0].text, /has no item "TOASTER-9". Its items are: BLENDER-1, CUPS-4/)
    } finally {
      await a.close()
    }
  })

  test("a stranger cannot refund someone else's order, and is not told it exists", async () => {
    const a = await agent()
    try {
      const r = await a.say('15550100002', 'refund ORD-1001')
      assert.equal(r.outcome, 'NotFound')
      assert.equal(a.apis.stripeCalls().length, 0)
      assert.match(a.apis.sent[0].text, /couldn't find order ORD-1001/)
      assert.ok(!/BLENDER|Ada/.test(a.apis.sent[0].text))
      // The Line refused it, and the journal keeps the try.
      const journal = await a.rt.getJournal('ORD-1001:0')
      assert.deepEqual(journal.filter((row) => row.action === 'Request').map((row) => [row.step_kind, row.reject_reason, row.data.fromOwner]), [['rejected', 'not-owner', false]])
      assert.equal((await a.rt.getState('ORD-1001:0')).state.status, 'Open')
      const status = await a.say('15550100002', 'status ORD-1001')
      assert.equal(status.outcome, 'NotFound')
    } finally {
      await a.close()
    }
  })

  test('a customer with one order need not name it; with two, the agent asks which', async () => {
    const a = await agent()
    try {
      const ada = await a.say('15550100001', 'refund the blender')
      assert.equal(ada.outcome, 'Started')
      assert.equal(new URLSearchParams(a.apis.stripeCalls()[0].body).get('amount'), '6000')
      const ben = await a.say('15550100002', 'I want a refund')
      assert.equal(ben.outcome, 'NeedOrder')
      assert.match(a.apis.sent.at(-1).text, /Your orders: ORD-1002, ORD-1003/)
      assert.equal(a.apis.stripeCalls().length, 1)
      const unknown = await a.say('15550100099', 'refund please')
      assert.equal(unknown.outcome, 'NeedOrder')
      assert.match(a.apis.sent.at(-1).text, /couldn't find any orders/)
    } finally {
      await a.close()
    }
  })

  test('status, help and unknown orders', async () => {
    const a = await agent()
    try {
      await a.say('15550100002', 'refund ORD-1002')
      const s = await a.say('15550100002', "what's the status of ORD-1002?")
      assert.equal(s.outcome, 'Status')
      assert.match(a.apis.sent.at(-1).text, /MUG-1 \$25\.00: refunded/)
      assert.equal((await a.say('15550100002', 'hello')).outcome, 'Help')
      assert.match(a.apis.sent.at(-1).text, /refund ORD-1001/)
      assert.equal((await a.say('15550100002', 'refund ORD-4242')).outcome, 'NotFound')
    } finally {
      await a.close()
    }
  })

  test('a webhook delivered twice is answered once and refunds once', async () => {
    const a = await agent()
    try {
      const [one, two] = await Promise.all([
        a.host.handleMessage({ id: 'wamid.dup', from: '15550100002', text: 'refund ORD-1002', name: 'Ben' }),
        a.host.handleMessage({ id: 'wamid.dup', from: '15550100002', text: 'refund ORD-1002', name: 'Ben' }),
      ])
      await settle(a.rt)
      assert.equal(one.outcome, 'Started')
      assert.equal(two.duplicate, true)
      const three = await a.say('15550100002', 'refund ORD-1002', 'wamid.dup')
      assert.equal(three.duplicate, true)
      assert.equal(a.apis.stripeCalls().length, 1)
      assert.equal(a.apis.sent.length, 2) // the reply and the notice
    } finally {
      await a.close()
    }
  })
})

describe('when Stripe fails', () => {
  test('a declined refund is not retried: the customer is told a person will follow up, and the agent never refunds it', async () => {
    const apis = fakeApis({ stripe: () => ({ status: 400, body: { error: { code: 'charge_disputed', message: 'disputed' } } }) })
    const a = await agent(apis)
    try {
      await a.say('15550100002', 'refund ORD-1002')
      assert.equal(apis.stripeCalls().length, 1)
      assert.equal((await a.rt.getState('ORD-1002:0')).state.status, 'Failed')
      assert.match(apis.sent.at(-1).text, /couldn't complete the refund of \$25\.00 for MUG-1 \(order ORD-1002\). A member of our team will follow up/)
      const again = await a.say('15550100002', 'refund ORD-1002')
      assert.equal(again.outcome, 'NothingToRefund')
      assert.equal(apis.stripeCalls().length, 1)
      assert.match(apis.sent.at(-1).text, /our team will contact you/)
    } finally {
      await a.close()
    }
  })

  test('an error worth a retry is retried with the same idempotency key, so Stripe refunds once', async () => {
    let clock = Date.now()
    let failures = 1
    // The first answer is lost: Stripe made the refund, but the agent saw a 500.
    const apis = fakeApis({ stripe: () => (failures-- > 0 ? { status: 500, body: { error: { message: 'api_error' } } } : null) })
    const a = await agent(apis, { now: () => clock })
    try {
      await a.say('15550100002', 'refund ORD-1002')
      assert.equal(apis.stripeCalls().length, 1)
      assert.equal((await a.rt.getState('ORD-1002:0')).state.status, 'Refunding')
      clock += 60_000
      await settle(a.rt)
      const calls = apis.stripeCalls()
      assert.equal(calls.length, 2)
      assert.equal(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key'])
      assert.equal(apis.refunds.size, 1)
      assert.equal((await a.rt.getState('ORD-1002:0')).state.status, 'Refunded')
      assert.match(apis.sent.at(-1).text, /has been issued/)
    } finally {
      await a.close()
    }
  })
})
