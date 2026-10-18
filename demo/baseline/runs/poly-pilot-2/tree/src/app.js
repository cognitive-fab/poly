// Wiring: loads the admitted build, binds the handlers and the transports their capabilities are built over, and puts
// the host behind the webhook server.
import { join } from 'node:path'
import { load } from '@poly/runtime'
import { SupportHost } from './host.js'
import { TableStore } from './kv.js'
import { webhookServer } from './server.js'

export const ADMISSION_KEY_ID = 'support-admission'
export const SECRET_NAMES = ['STRIPE_SECRET_KEY', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']

/** One HTTP request for the egress capability, which has already checked the URL against the effect's targets. */
export async function fetchEgress(req) {
  const body = req.body == null ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body, redirect: 'manual', signal: AbortSignal.timeout(25_000) })
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() }
}

/**
 * root: the project directory (poly.json, .poly/, orders.json). trust: the admission public key, PEM. secrets: a
 * function from a secret's name to its value. egress: the HTTP transport (fetch by default). dataDir: where the
 * runtime's SQLite store and the host's tables live; null keeps both in memory.
 */
export async function startAgent({ root, trust, secrets, egress = fetchEgress, dataDir = join(root, '.data'), ordersFile = join(root, 'orders.json'), verifyToken, appSecret, log = console, now }) {
  const tables = new TableStore(dataDir ? join(dataDir, 'tables.json') : null)
  let host
  const rt = await load(join(root, '.poly', 'build'), {
    certificate: join(root, '.poly', 'certificate.json'),
    trust: { [ADMISSION_KEY_ID]: trust },
    ...(dataDir ? { store: { sqlite: join(dataDir, 'runtime.sqlite') } } : {}),
    ...(now ? { now } : {}),
    transports: {
      egress,
      secrets,
      store: { read: (t, k) => host.storeTransport().read(t, k), write: (t, k, v) => host.storeTransport().write(t, k, v) },
    },
  })
  host = new SupportHost(rt, { ordersFile, tables })
  const handlers = rt.handlerExports('src/handlers.js')
  rt.handle('stripe.refund', handlers.refund)
  rt.handle('whatsapp.notify', handlers.notify)
  rt.handle('whatsapp.reply', handlers.reply)
  const server = webhookServer(host, { verifyToken, appSecret, log })
  return {
    rt,
    host,
    server,
    async close() {
      rt.stopWorkers()
      await new Promise((r) => (server.listening ? server.close(r) : r()))
      await rt.close()
    },
  }
}
