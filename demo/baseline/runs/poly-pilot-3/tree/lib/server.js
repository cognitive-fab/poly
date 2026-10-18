// The HTTP side: the WhatsApp Cloud API webhook (GET handshake, signed POST notifications) and one operator route
// for refunds Stripe could not confirm. A notification is acknowledged at once, as Meta asks, and its messages are
// then handled one sender at a time, in order.
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { validSignature, handshake, messagesOf } from './webhook.js'

const MAX_BODY = 1 << 20

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

const sameToken = (given, want) => {
  if (!want || typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(`Bearer ${want}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * `agent` is lib/agent.js's; `send(to, text)` delivers a reply. `phoneNumberId`, when given, is the business number
 * this agent answers for: a notification for another number is acknowledged and ignored.
 */
export function createAgentServer({ agent, send, appSecret, verifyToken, adminToken, phoneNumberId, log = console }) {
  const queues = new Map()
  const pending = new Set()

  function enqueue(m) {
    const prev = queues.get(m.from) ?? Promise.resolve()
    const next = prev
      .then(async () => {
        const reply = await agent.handle({ from: m.from, text: m.text, messageId: m.id })
        if (reply) await send(m.from, reply)
      })
      .catch((e) => log.error(`message ${m.id}: ${e.stack ?? e.message}`))
    queues.set(m.from, next)
    pending.add(next)
    next.finally(() => {
      pending.delete(next)
      if (queues.get(m.from) === next) queues.delete(m.from)
    })
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const answer = (status, body = '', type = 'text/plain') => {
      res.writeHead(status, { 'content-type': type })
      res.end(body)
    }
    try {
      if (url.pathname === '/webhook' && req.method === 'GET') {
        const challenge = handshake(url.searchParams, verifyToken)
        return challenge === null ? answer(403, 'forbidden') : answer(200, challenge)
      }
      if (url.pathname === '/webhook' && req.method === 'POST') {
        const raw = await readBody(req)
        if (!validSignature(raw, req.headers['x-hub-signature-256'], appSecret)) return answer(401, 'bad signature')
        let payload
        try {
          payload = JSON.parse(raw.toString('utf8'))
        } catch {
          return answer(400, 'bad json')
        }
        answer(200, 'ok')
        for (const m of messagesOf(payload)) {
          if (phoneNumberId && m.phoneNumberId && m.phoneNumberId !== phoneNumberId) continue
          enqueue(m)
        }
        return
      }
      const resolve = /^\/admin\/orders\/([A-Za-z0-9-]+)\/resolve$/.exec(url.pathname)
      if (resolve && req.method === 'POST') {
        if (!sameToken(req.headers.authorization, adminToken)) return answer(401, 'unauthorized')
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        if (typeof body.issued !== 'boolean') return answer(400, 'issued must be true or false')
        const r = await agent.resolve(resolve[1], body.issued)
        if (!r) return answer(404, 'no such order')
        return answer(r.stepKind === 'accepted' ? 200 : 409, JSON.stringify(r), 'application/json')
      }
      if (url.pathname === '/health') return answer(200, 'ok')
      return answer(404, 'not found')
    } catch (e) {
      log.error(e.stack ?? e.message)
      if (!res.headersSent) answer(500, 'error')
    }
  })

  /** Resolves when every message received so far has been handled (for tests and for a clean shutdown). */
  async function settled() {
    while (pending.size) await Promise.allSettled([...pending])
  }

  return { server, settled }
}
