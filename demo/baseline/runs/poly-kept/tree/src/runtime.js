// Admits support.poly and loads it on poly's runtime. Admission checks the program and signs a certificate with a key
// made for this process and never written down; load verifies the certificate against its public key, so the program
// that runs is the program that was checked.
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { admit } from '@poly/check'
import { load } from '@poly/runtime'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEY_ID = 'support-agent-local'

/**
 * @param {object} o
 * @param {import('@poly/runtime').Transports} o.transports the host functions the handlers' capabilities run over
 * @param {string} [o.store] the SQLite file, ':memory:' by default
 * @param {() => number} [o.now]
 */
export async function boot({ transports, store = ':memory:', now } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const key = { id: KEY_ID, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
  const admitted = await admit(ROOT, { key })
  if (store !== ':memory:') mkdirSync(dirname(resolve(store)), { recursive: true })
  const rt = await load(join(ROOT, '.poly', 'build'), {
    certificate: admitted.certificatePath,
    trust: { [KEY_ID]: publicKey.export({ type: 'spki', format: 'pem' }) },
    ...(store === ':memory:' ? {} : { store: { sqlite: resolve(store) } }),
    ...(now ? { now } : {}),
    transports,
  })
  const handlers = rt.handlerExports('src/effects.js')
  rt.handle('stripe.refund', handlers.refund)
  rt.handle('whatsapp.ticket', handlers.say)
  rt.handle('whatsapp.notice', handlers.tell)
  return rt
}
