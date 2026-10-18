// Loads the admitted build and wires it to the world: the transports the handlers' capabilities are built over
// (HTTP through fetch, secrets from the environment, the orders table from orders.json), and the handler of each
// effect kind, taken from the certified handler files.
import { join } from 'node:path'
import { load } from '@poly/runtime'

export const ADMISSION_KEY_ID = 'support-admission'

/** The egress transport over fetch. It follows no redirect: the capability checks each hop against the targets. */
export function fetchTransport(fetch = globalThis.fetch, timeoutMs = 20000) {
  return async ({ method, url, headers, body }) => {
    const res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() }
  }
}

/**
 * Starts the runtime of the project at `root`, admitted under the public key `trustPem`.
 * `secrets` maps a secret name to its value; `whatsapp` is { phoneNumberId }.
 */
export async function startRuntime({ root, trustPem, store, orders, secrets, whatsapp, fetch, now, workers = true }) {
  const rt = await load(join(root, '.poly', 'build'), {
    certificate: join(root, '.poly', 'certificate.json'),
    trust: { [ADMISSION_KEY_ID]: trustPem },
    ...(store ? { store: { sqlite: store } } : {}),
    ...(now ? { now } : {}),
    transports: {
      egress: fetchTransport(fetch),
      secrets: (name) => secrets[name],
      store: {
        read: (table, key) => {
          if (table === 'orders') return orders.get(key)
          if (table === 'whatsapp' && key === 'config') return { phoneNumberId: whatsapp.phoneNumberId }
          return null
        },
        write: () => {
          throw new Error('the agent writes no table')
        },
      },
    },
  })
  rt.handle('stripe.refund', rt.handlerExports('handlers/stripe.js').refund)
  rt.handle('whatsapp.notify', rt.handlerExports('handlers/whatsapp.js').notify)
  if (workers) rt.startWorkers({ effectPollMs: 250, timerPollMs: 1000 })
  return rt
}
