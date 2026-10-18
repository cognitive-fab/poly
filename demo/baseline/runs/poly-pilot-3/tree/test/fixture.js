// Shared by the tests: the project admitted in a temporary copy under a key generated for the run, and loaded with a
// fake Stripe and a fake WhatsApp Cloud API behind fetch. Nothing here touches the network or the real .poly/.
import { generateKeyPairSync } from 'node:crypto'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { admit } from '@poly/check'
import { ADMISSION_KEY_ID, startRuntime } from '../lib/host.js'
import { indexOrders } from '../lib/orders.js'
import { createAgent } from '../lib/agent.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export const ORDERS = [
  {
    order: 'ORD-1001', customer: '15550100001', name: 'Ada Demo', charge: 'ch_demo_1001', total: 10000, currency: 'usd',
    items: [{ sku: 'BLENDER-1', price: 6000 }, { sku: 'CUPS-4', price: 4000 }], placed: '2026-09-30',
  },
  {
    order: 'ORD-1002', customer: '15550100002', name: 'Ben Demo', charge: 'ch_demo_1002', total: 2500, currency: 'usd',
    items: [{ sku: 'MUG-1', price: 2500 }], placed: '2026-10-02',
  },
  {
    order: 'ORD-1003', customer: '15550100002', name: 'Ben Demo', charge: 'ch_demo_1003', total: 1800, currency: 'usd',
    items: [{ sku: 'TEA-1', price: 1800 }], placed: '2026-10-05',
  },
]

/** The project, admitted in a temporary directory; returns its root and the public key to trust. */
export async function admitted() {
  const root = mkdtempSync(join(tmpdir(), 'support-agent-'))
  for (const p of ['poly.json', 'package.json', 'src', 'handlers']) cpSync(join(ROOT, p), join(root, p), { recursive: true })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  await admit(root, { key: { id: ADMISSION_KEY_ID, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) } })
  return { root, trustPem: publicKey.export({ type: 'spki', format: 'pem' }), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * A fake of the two APIs. `stripe` is a list of answers given in order to POST /v1/refunds, each { status, body }
 * or 'drop' (the connection fails); when it runs out, every refund succeeds.
 */
export function fakeApis() {
  const refunds = []
  const messages = []
  const stripe = []
  async function fetch(url, init = {}) {
    const u = new URL(url)
    if (u.origin === 'https://api.stripe.com' && u.pathname === '/v1/refunds' && init.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(init.body))
      refunds.push({ form, headers: init.headers })
      const next = stripe.shift() ?? { status: 200, body: { id: `re_${refunds.length}`, object: 'refund', status: 'succeeded', amount: Number(form.amount) } }
      if (next === 'drop') throw new TypeError('fetch failed')
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
    }
    if (u.origin === 'https://graph.facebook.com' && init.method === 'POST') {
      const body = JSON.parse(init.body)
      messages.push({ url, to: body.to, text: body.text.body, headers: init.headers })
      return new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.${messages.length}` }] }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetch, refunds, messages, stripe }
}

/** A loaded runtime and agent over the fakes, with a clock the test moves. */
export async function harness(project, { orders = ORDERS } = {}) {
  const apis = fakeApis()
  const clock = { t: Date.parse('2026-10-18T10:00:00Z') }
  const index = indexOrders(orders)
  const rt = await startRuntime({
    root: project.root,
    trustPem: project.trustPem,
    orders: index,
    secrets: { STRIPE_SECRET_KEY: 'stripe-test-key', WHATSAPP_TOKEN: 'wa-test-token' },
    whatsapp: { phoneNumberId: '1098765' },
    fetch: apis.fetch,
    now: () => clock.t,
    workers: false,
  })
  const agent = createAgent({ rt, orders: index })
  let n = 0
  /** Sends a customer message and returns the agent's reply. */
  const say = (from, text, id = `wamid.in.${++n}`) => agent.handle({ from, text, messageId: id })
  /** Lets the effect worker and the timers run, moving the clock past every retry backoff. */
  async function settle(rounds = 6) {
    for (let i = 0; i < rounds; i++) {
      await rt.advance(10)
      clock.t += 60_000
      await rt.tick(clock.t)
    }
  }
  return { rt, agent, apis, clock, say, settle, orders: index, close: () => rt.close() }
}
