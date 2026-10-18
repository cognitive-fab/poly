// `npm start`: the support agent, configured from the environment (README.md).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECRET_NAMES, startAgent } from './app.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = process.env
const required = [...SECRET_NAMES, 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'POLY_TRUST_KEY']
const missing = required.filter((n) => !env[n])
if (missing.length) {
  console.error(`not started: set ${missing.join(', ')} (see README.md)`)
  process.exit(1)
}
if (!existsSync(join(root, '.poly', 'certificate.json'))) {
  console.error('not started: the program is not admitted; run `npm run admit` first (see README.md)')
  process.exit(1)
}

const agent = await startAgent({
  root,
  trust: readFileSync(env.POLY_TRUST_KEY, 'utf8'),
  secrets: (name) => (SECRET_NAMES.includes(name) ? env[name] : undefined),
  verifyToken: env.WHATSAPP_VERIFY_TOKEN,
  appSecret: env.WHATSAPP_APP_SECRET,
})
agent.rt.startWorkers({ effectPollMs: 250 })
const port = Number(env.PORT ?? 3000)
const hostname = env.HOST ?? '127.0.0.1'
agent.server.listen(port, hostname, () => console.log(`support agent listening on http://${hostname}:${port}/webhook`))

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    console.log('stopping')
    agent.close().then(() => process.exit(0), () => process.exit(1))
  })
