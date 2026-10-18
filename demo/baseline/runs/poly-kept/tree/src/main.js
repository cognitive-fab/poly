// node src/main.js: starts the support agent on PORT (default 3000), on 127.0.0.1 unless HOST says otherwise.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './runtime.js'
import { start } from './server.js'

const env = process.env
const need = (name) => {
  if (!env[name]) {
    console.error(`missing environment variable ${name} (see README.md)`)
    process.exit(1)
  }
  return env[name]
}

const orders = JSON.parse(readFileSync(env.ORDERS_FILE ?? join(ROOT, 'orders.json'), 'utf8'))
const { server } = await start({
  orders,
  secrets: { STRIPE_SECRET_KEY: need('STRIPE_SECRET_KEY'), WHATSAPP_TOKEN: need('WHATSAPP_TOKEN') },
  whatsapp: {
    appSecret: need('WHATSAPP_APP_SECRET'),
    verifyToken: need('WHATSAPP_VERIFY_TOKEN'),
    phoneNumberId: need('WHATSAPP_PHONE_NUMBER_ID'),
  },
  adminToken: env.ADMIN_TOKEN,
  store: env.STORE ?? join(ROOT, '.poly', 'run', 'store.sqlite'),
  windowDays: Number(env.REFUND_WINDOW_DAYS ?? 30),
  workers: true,
  log: (line) => console.log(JSON.stringify({ at: new Date().toISOString(), ...line })),
})

const port = Number(env.PORT ?? 3000)
const host = env.HOST ?? '127.0.0.1'
server.listen(port, host, () => console.log(`support agent listening on http://${host}:${port}/webhook`))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)))
