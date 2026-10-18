// The HTTP side: WhatsApp Cloud API webhooks in, an operator endpoint for tickets under review, and the transports
// the effect handlers' capabilities are built over (the network, the secrets and the store tables).
import { createServer } from 'node:http'
import { Agent } from './agent.js'
import { boot } from './runtime.js'
import { handshake, messagesOf, signatureValid } from './whatsapp.js'

const MAX_BODY = 1024 * 1024

/** egress over fetch: one request, no redirect followed (the capability checks each hop itself). */
export const fetchEgress = (timeoutMs = 20000) => async ({ method, url, headers, body }) => {
  const res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() }
}

/**
 * Starts the agent: admits and loads support.poly, and returns { server, rt, agent } with nothing listening yet.
 * @param {object} o
 * @param {object[]} o.orders
 * @param {Record<string, string | undefined>} o.secrets STRIPE_SECRET_KEY, WHATSAPP_TOKEN
 * @param {{ appSecret: string, verifyToken: string, phoneNumberId: string }} o.whatsapp
 * @param {string} [o.adminToken] enables POST /admin/resolve when set
 * @param {import('@poly/runtime').Transports['egress']} [o.egress]
 * @param {string} [o.store]
 * @param {number} [o.windowDays]
 * @param {() => number} [o.now]
 * @param {boolean} [o.workers] run the effect workers in the background (the server does; tests step them)
 * @param {(line: object) => void} [o.log]
 */
export async function start({ orders, secrets, whatsapp, adminToken, egress = fetchEgress(), store, windowDays, now, workers = false, log = () => {} }) {
  const recipients = new Map()
  const config = new Map([['whatsappPhoneNumberId', whatsapp.phoneNumberId]])
  let agent
  const tables = () => ({ ...agent.tables(), recipients, config })
  const rt = await boot({
    store,
    now,
    transports: {
      egress,
      secrets: (name) => secrets[name],
      store: {
        read: (table, key) => tables()[table]?.get(key) ?? null,
        write: () => {
          throw new Error('the store tables are read-only')
        },
      },
    },
  })
  agent = new Agent(rt, orders, { windowDays, now })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const send = (status, body, type = 'text/plain') => {
      res.writeHead(status, { 'content-type': type })
      res.end(body)
    }
    try {
      if (url.pathname === '/webhook' && req.method === 'GET') {
        const challenge = handshake(url.searchParams, whatsapp.verifyToken)
        return challenge === null ? send(403, 'forbidden') : send(200, challenge)
      }
      if (url.pathname === '/webhook' && req.method === 'POST') {
        const raw = await readBody(req)
        if (!signatureValid(raw, req.headers['x-hub-signature-256'], whatsapp.appSecret)) {
          log({ event: 'webhook-refused', reason: 'signature' })
          return send(401, 'bad signature')
        }
        let body
        try {
          body = JSON.parse(raw.toString('utf8'))
        } catch {
          return send(400, 'bad json')
        }
        for (const m of messagesOf(body)) log({ event: 'message', id: m.id, result: await agent.handle(m, recipients) })
        return send(200, 'ok')
      }
      if (url.pathname === '/admin/resolve' && req.method === 'POST') {
        if (!adminToken || req.headers.authorization !== `Bearer ${adminToken}`) return send(403, 'forbidden')
        const { order, done } = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const result = await agent.resolve(String(order), done === true)
        return send(200, JSON.stringify(result), 'application/json')
      }
      if (url.pathname === '/health') return send(200, 'ok')
      return send(404, 'not found')
    } catch (e) {
      log({ event: 'error', message: e?.message })
      // A 5xx makes Meta deliver the webhook again; each message is one step however often it arrives.
      return send(500, 'error')
    }
  })
  server.on('close', () => {
    rt.stopWorkers()
  })
  if (workers) rt.startWorkers({ effectPollMs: 250, timerPollMs: 1000, messagePollMs: 250 })
  return { server, rt, agent, recipients }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
