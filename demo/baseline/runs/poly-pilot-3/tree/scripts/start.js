// Starts the support agent: the admitted runtime and the webhook server. See README.md for the environment.
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOrders } from '../lib/orders.js'
import { startRuntime } from '../lib/host.js'
import { createAgent } from '../lib/agent.js'
import { createAgentServer } from '../lib/server.js'
import { whatsappSender } from '../lib/whatsapp.js'
import { PUBLIC_KEY_FILE } from '../lib/config.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const env = process.env
const required = ['WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'STRIPE_SECRET_KEY']
const missing = required.filter((k) => !env[k])
if (missing.length) {
  console.error(`missing environment: ${missing.join(', ')} (see README.md)`)
  process.exit(1)
}

const orders = loadOrders(env.ORDERS_FILE ?? join(root, 'orders.json'))
for (const p of orders.problems) console.warn(`order ${p.order ?? '(no id)'} is not served: ${p.problem}`)

const store = env.STORE_FILE ?? join(root, 'data', 'store.sqlite')
mkdirSync(join(store, '..'), { recursive: true })
const rt = await startRuntime({
  root,
  trustPem: readFileSync(PUBLIC_KEY_FILE, 'utf8'),
  store,
  orders,
  secrets: { STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY, WHATSAPP_TOKEN: env.WHATSAPP_TOKEN },
  whatsapp: { phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID },
})
const agent = createAgent({ rt, orders })
const { server, settled } = createAgentServer({
  agent,
  send: whatsappSender({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID }),
  appSecret: env.WHATSAPP_APP_SECRET,
  verifyToken: env.WHATSAPP_VERIFY_TOKEN,
  adminToken: env.ADMIN_TOKEN,
  phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
})
const port = Number(env.PORT ?? 3000)
const host = env.HOST ?? '127.0.0.1'
server.listen(port, host, () => console.log(`support agent listening on http://${host}:${port}/webhook (${orders.byId.size} orders)`))

async function stop() {
  server.close()
  await settled()
  rt.stopWorkers()
  await rt.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
