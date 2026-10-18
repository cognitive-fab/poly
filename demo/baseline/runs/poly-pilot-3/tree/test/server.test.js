// The webhook server over HTTP, end to end: Meta's handshake, a signed notification in, the replies out, the refund
// issued, and the operator route.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { admitted, harness } from './fixture.js'
import { createAgentServer } from '../lib/server.js'
import { sign } from '../lib/webhook.js'

const SECRET = 'app-secret'
let project, h, srv, base
const replies = []

before(async () => {
  project = await admitted()
  h = await harness(project)
  srv = createAgentServer({
    agent: h.agent,
    send: async (to, text) => replies.push({ to, text }),
    appSecret: SECRET,
    verifyToken: 'verify-me',
    adminToken: 'admin-token',
    phoneNumberId: '1098765',
    log: { error: (m) => assert.fail(m) },
  })
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${srv.server.address().port}`
})
after(async () => {
  await new Promise((r) => srv.server.close(r))
  await h.close()
  project.cleanup()
})

function notification(from, id, body, phoneNumberId = '1098765') {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId },
      messages: [{ from, id, timestamp: '1790000000', type: 'text', text: { body } }],
    } }] }],
  })
}
const post = (raw, signature = sign(raw, SECRET)) =>
  fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body: raw })

test('the verification handshake', async () => {
  const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444`)
  assert.equal(ok.status, 200)
  assert.equal(await ok.text(), '1158201444')
  assert.equal((await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status, 403)
})

test('an unsigned or forged notification is refused and does nothing', async () => {
  const raw = notification('15550100001', 'wamid.forged', 'refund ORD-1001')
  assert.equal((await post(raw, 'sha256=00')).status, 401)
  assert.equal((await post(raw, sign(raw, 'wrong'))).status, 401)
  await srv.settled()
  assert.equal(replies.length, 0)
})

test('a conversation over the webhook issues the refund', async () => {
  assert.equal((await post(notification('15550100002', 'wamid.s1', 'refund ORD-1002'))).status, 200)
  await srv.settled()
  assert.equal(replies.at(-1).to, '15550100002')
  assert.match(replies.at(-1).text, /refund \$25\.00 for ORD-1002/)

  // Meta redelivers the same notification: the step is taken once.
  await post(notification('15550100002', 'wamid.s2', 'YES'))
  await post(notification('15550100002', 'wamid.s2', 'YES'))
  await srv.settled()
  await h.settle()
  assert.equal(h.apis.refunds.length, 1)
  assert.equal(h.apis.refunds[0].form.charge, 'ch_demo_1002')
  assert.match(h.apis.messages.at(-1).text, /\$25\.00 for ORD-1002 \(MUG-1\) has been issued/)
})

test('a notification for another business number is ignored', async () => {
  const before = replies.length
  assert.equal((await post(notification('15550100001', 'wamid.other', 'refund ORD-1001', '999'))).status, 200)
  await srv.settled()
  assert.equal(replies.length, before)
})

test('the operator route needs the admin token', async () => {
  const resolve = (auth) => fetch(`${base}/admin/orders/ORD-1001/resolve`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: '{"issued":true}' })
  assert.equal((await resolve('Bearer wrong')).status, 401)
  const r = await resolve('Bearer admin-token')
  assert.equal(r.status, 409, 'ORD-1001 is not in review, so the machine rejects the resolution')
  assert.equal((await r.json()).rejectReason, 'not-in-review')
})
