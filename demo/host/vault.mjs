// DF5, Q10: the development vault. The concierge's credential is a Stripe Connect grant, so the demo runs a vault that holds a
// synthetic token, made at start, held in memory and written nowhere, which only the local stand-in accepts. There is no Stripe
// connection and no key of Stripe's anywhere. This file makes the token and the transport the vault and the runtime's api use: it
// sends a request to the stand-in in-process (every one is in the stand-in's log) and has no route to any other host.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** The synthetic token: not the shape of any provider's key, different on every start. */
export const mintDevelopmentToken = () => `tok-synthetic-${randomBytes(20).toString('hex')}`;

const HOSTS = new Set(['api.stripe.com', 'connect.stripe.com']);

/** A transport (`{ request(q) }`) over the stand-in: the two Stripe names are answered by it, every other request has no route. */
export function developmentHttp(standIn) {
  return {
    async request(q) {
      const url = new URL(q.url);
      if (url.protocol !== 'https:' || !HOSTS.has(url.hostname)) throw Object.assign(new Error(`no route: the development vault reaches the local stand-in alone, not ${url.hostname}`), { code: 'ENOROUTE' });
      const r = await standIn.call({ host: url.hostname, method: q.method, path: `${url.pathname}${url.search}`, headers: q.headers ?? {}, body: q.body ?? '' });
      return { status: r.status, headers: r.headers, body: r.body };
    },
  };
}

/** The development vault's wrapping key: AES-256-GCM under a key made at start and held in memory (kmsStore's wrap/unwrap). */
export function memoryWrap() {
  const key = randomBytes(32);
  return {
    wrap(p) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const b = Buffer.concat([c.update(p), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]); },
    unwrap(x) { const b = Buffer.from(x); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]); },
  };
}
