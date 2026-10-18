// The local HTTP endpoint the WhatsApp Cloud API webhooks arrive at (through a tunnel or a proxy to this port).
import { createServer } from 'node:http'
import { handshake, messagesOf, signatureValid } from './whatsapp.js'

const MAX_BODY = 1 << 20

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

/**
 * GET /webhook answers Meta's subscription handshake; POST /webhook takes a signed payload, answers 200 at once (Meta
 * retries a slow answer) and hands each message to the host. GET /health answers ok.
 */
export function webhookServer(host, { verifyToken, appSecret, log = console }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = (status, body = '', type = 'text/plain') => {
      res.writeHead(status, { 'content-type': type })
      res.end(body)
    }
    try {
      if (url.pathname === '/health' && req.method === 'GET') return send(200, 'ok')
      if (url.pathname !== '/webhook') return send(404, 'not found')
      if (req.method === 'GET') {
        const challenge = handshake(url.searchParams, verifyToken)
        return challenge === null ? send(403, 'forbidden') : send(200, challenge)
      }
      if (req.method !== 'POST') return send(405, 'method not allowed')
      const raw = await readBody(req)
      if (!signatureValid(raw, req.headers['x-hub-signature-256'], appSecret)) {
        log.warn?.('webhook refused: bad or missing X-Hub-Signature-256')
        return send(401, 'bad signature')
      }
      let payload
      try {
        payload = JSON.parse(raw.toString('utf8'))
      } catch {
        return send(400, 'not json')
      }
      send(200, 'ok')
      for (const m of messagesOf(payload)) {
        host.handleMessage(m).then(
          (r) => log.info?.(`message ${m.id}: ${r.duplicate ? 'already answered' : r.outcome}`),
          (e) => log.error?.(`message ${m.id} failed: ${e?.stack ?? e}`),
        )
      }
    } catch (e) {
      if (!res.headersSent) send(e?.status ?? 500, e?.status ? e.message : 'error')
      if (!e?.status) log.error?.(e)
    }
  })
}
