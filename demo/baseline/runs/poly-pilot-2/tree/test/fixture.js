// Test fixture: an admitted copy of the project in a temporary folder, signed with a key made for the test run, and a
// stand-in for the Stripe and WhatsApp Cloud APIs behind the egress transport.
import { generateKeyPairSync } from 'node:crypto'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { admit } from '@poly/check'
import { ensureRuntimeModel } from '../scripts/runtime-model.js'

export const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const ORDERS = [
  { order: 'ORD-1001', customer: '15550100001', name: 'Ada Demo', charge: 'ch_demo_1001', total: 10000, currency: 'usd', items: [{ sku: 'BLENDER-1', price: 6000 }, { sku: 'CUPS-4', price: 4000 }], placed: '2026-09-30' },
  { order: 'ORD-1002', customer: '15550100002', name: 'Ben Demo', charge: 'ch_demo_1002', total: 2500, currency: 'usd', items: [{ sku: 'MUG-1', price: 2500 }], placed: '2026-10-02' },
  { order: 'ORD-1003', customer: '15550100002', name: 'Ben Demo', charge: 'ch_demo_1003', total: 1500, currency: 'usd', items: [{ sku: 'TEA-2', price: 1500 }], placed: '2026-10-10' },
]

/** Copies poly.json and src/ to a temporary project, admits it, and returns where it is and the key to trust. */
export async function admitted() {
  await ensureRuntimeModel()
  const root = mkdtempSync(join(tmpdir(), 'support-agent-'))
  cpSync(join(PROJECT, 'poly.json'), join(root, 'poly.json'))
  cpSync(join(PROJECT, 'src'), join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'orders.json'), JSON.stringify(ORDERS, null, 2))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  await admit(root, { key: { id: 'support-admission', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } })
  return { root, trust: publicKey.export({ type: 'spki', format: 'pem' }).toString(), remove: () => rmSync(root, { recursive: true, force: true }) }
}

export const SECRETS = { STRIPE_SECRET_KEY: 'stripe-test-secret', WHATSAPP_TOKEN: 'wa-test-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890' }

/**
 * The Stripe and Graph APIs as the egress transport sees them. Stripe answers with `stripe(req)` when given (a status
 * and a body), else 200 with a refund; it deduplicates by Idempotency-Key as Stripe does, so `refunds` holds the
 * refunds Stripe would have made. Each WhatsApp message sent is in `sent`, as `{ to, text }`.
 */
export function fakeApis({ stripe } = {}) {
  const requests = []
  const refunds = new Map()
  const sent = []
  const egress = async (req) => {
    requests.push(req)
    const url = new URL(req.url)
    if (url.host === 'api.stripe.com') {
      const key = req.headers?.['idempotency-key']
      if (key && refunds.has(key)) return { status: 200, headers: {}, body: JSON.stringify(refunds.get(key)) }
      const answer = stripe?.(req)
      if (answer) return { status: answer.status, headers: {}, body: JSON.stringify(answer.body ?? {}) }
      const form = new URLSearchParams(req.body)
      const refund = { id: `re_${refunds.size + 1}`, object: 'refund', status: 'succeeded', charge: form.get('charge'), amount: Number(form.get('amount')) }
      if (key) refunds.set(key, refund)
      return { status: 200, headers: {}, body: JSON.stringify(refund) }
    }
    if (url.host === 'graph.facebook.com') {
      const body = JSON.parse(req.body)
      sent.push({ to: body.to, text: body.text.body, url: req.url, auth: req.headers?.authorization })
      return { status: 200, headers: {}, body: JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.out${sent.length}` }] }) }
    }
    return { status: 404, headers: {}, body: '{}' }
  }
  return { egress, requests, refunds, sent, stripeCalls: () => requests.filter((r) => r.url.includes('api.stripe.com')) }
}

/** Runs the effect worker until a pass finds nothing to do. */
export async function settle(rt, passes = 50) {
  for (let i = 0; i < passes; i++) if ((await rt.worker.tick()) === 0) return
}

/** A WhatsApp Cloud API webhook payload holding one text message. */
export const webhookPayload = ({ id, from, text, name = null }) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA_ID',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550009999', phone_number_id: '1234567890' },
        contacts: name ? [{ profile: { name }, wa_id: from }] : [],
        messages: [{ from, id, timestamp: '1792300000', type: 'text', text: { body: text } }],
      },
    }],
  }],
})
