// The webhook endpoint over HTTP, and a restart in the middle of a refund, on the admitted build.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAgent } from '../src/app.js'
import { sign } from '../src/whatsapp.js'
import { admitted, fakeApis, SECRETS, settle, webhookPayload } from './fixture.js'

let project
before(async () => {
  project = await admitted()
})
after(() => project?.remove())

const APP_SECRET = 'test-app-secret'
const VERIFY = 'test-verify-token'

async function listening(apis, opts = {}) {
  const a = await startAgent({ root: project.root, trust: project.trust, secrets: (k) => SECRETS[k], egress: apis.egress, dataDir: null, verifyToken: VERIFY, appSecret: APP_SECRET, log: {}, ...opts })
  await new Promise((r) => a.server.listen(0, '127.0.0.1', r))
  return { ...a, base: `http://127.0.0.1:${a.server.address().port}` }
}

const until = async (cond, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (await cond()) return
  throw new Error('timed out')
}

test('the webhook: handshake, signed messages in, refund and replies out; unsigned and forged payloads refused', async () => {
  const apis = fakeApis()
  const a = await listening(apis)
  try {
    const hs = await fetch(`${a.base}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=42`)
    assert.equal(hs.status, 200)
    assert.equal(await hs.text(), '42')
    assert.equal((await fetch(`${a.base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`)).status, 403)
    assert.equal((await fetch(`${a.base}/health`)).status, 200)

    const raw = JSON.stringify(webhookPayload({ id: 'wamid.http1', from: '15550100002', text: 'refund ORD-1002', name: 'Ben Demo' }))
    const forged = await fetch(`${a.base}/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw, 'not-the-secret') } })
    assert.equal(forged.status, 401)
    const unsigned = await fetch(`${a.base}/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json' } })
    assert.equal(unsigned.status, 401)
    await settle(a.rt)
    assert.equal(apis.requests.length, 0, 'a refused webhook reaches neither Stripe nor WhatsApp')

    const ok = await fetch(`${a.base}/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw, APP_SECRET) } })
    assert.equal(ok.status, 200)
    await until(async () => {
      await settle(a.rt)
      return apis.sent.length === 2
    })
    assert.equal(apis.stripeCalls().length, 1)
    assert.match(apis.sent[0].text, /^I'm refunding \$25\.00 on order ORD-1002:\n• MUG-1 \$25\.00\n/)
    assert.match(apis.sent[1].text, /refund of \$25\.00 for MUG-1 \(order ORD-1002\) has been issued/)

    // Meta redelivers the same webhook: nothing more happens.
    const again = await fetch(`${a.base}/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw, APP_SECRET) } })
    assert.equal(again.status, 200)
    await new Promise((r) => setTimeout(r, 100))
    await settle(a.rt)
    assert.equal(apis.stripeCalls().length, 1)
    assert.equal(apis.sent.length, 2)
  } finally {
    await a.close()
  }
})

test('a refund in flight when the agent stops is finished after a restart, with the same idempotency key', async () => {
  const data = mkdtempSync(join(tmpdir(), 'support-agent-data-'))
  let clock = Date.now()
  const down = fakeApis({ stripe: () => ({ status: 503, body: { error: { message: 'unavailable' } } }) })
  try {
    const first = await startAgent({ root: project.root, trust: project.trust, secrets: (k) => SECRETS[k], egress: down.egress, dataDir: data, log: {}, now: () => clock })
    await first.host.handleMessage({ id: 'wamid.restart', from: '15550100001', text: 'refund ORD-1001 BLENDER-1', name: null })
    await settle(first.rt)
    assert.equal(down.stripeCalls().length, 1)
    assert.equal((await first.rt.getState('ORD-1001:0')).state.status, 'Refunding')
    await first.close()

    clock += 60_000
    const up = fakeApis()
    const second = await startAgent({ root: project.root, trust: project.trust, secrets: (k) => SECRETS[k], egress: up.egress, dataDir: data, log: {}, now: () => clock })
    try {
      await settle(second.rt)
      assert.equal((await second.rt.getState('ORD-1001:0')).state.status, 'Refunded')
      assert.equal(up.stripeCalls().length, 1)
      assert.equal(up.stripeCalls()[0].headers['idempotency-key'], down.stripeCalls()[0].headers['idempotency-key'])
      assert.match(up.sent.at(-1).text, /BLENDER-1 \(order ORD-1001\) has been issued/)
      // The same message delivered after the restart is still answered once.
      const dup = await second.host.handleMessage({ id: 'wamid.restart', from: '15550100001', text: 'refund ORD-1001 BLENDER-1', name: null })
      assert.equal(dup.duplicate, true)
    } finally {
      await second.close()
    }
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
})
