// The generic webhook adapter (S183), from the Standard Webhooks specification read on 2026-10-05
// (packages/poly-io/PROVENANCE.md). A webhook carries webhook-id, webhook-timestamp and webhook-signature, a space
// separated list of v1,<base64 HMAC-SHA256> over <id>.<timestamp>.<body> under the secret whsec_<base64>; a timestamp
// outside the tolerance is refused. One configured source is one thread: its secret, its name, its endpoint.
import { createHash } from 'node:crypto';
import type { ChannelAdapter, Refusal, SendResult, Verified } from '@poly/runtime/adapters';
import { fresh, hmac, noAnswer, signatureMatches, made, type AdapterFault } from '../util.js';

export interface WebhookConfig {
  /** whsec_ followed by the base64 key. */
  secret: string;
  /** The source's name, the conversation's thread field source. */
  source: string;
  /** Where deliveries to this source go. */
  endpoint: string;
  /** How far a timestamp may be from now, in seconds (300 when not given). */
  toleranceSeconds?: number;
  /** A seeded mutant, for the tests only (ADAPTER_FAULTS). */
  fault?: AdapterFault;
}

function keyOf(secret: string): Buffer {
  if (!secret.startsWith('whsec_')) throw new Error('a Standard Webhooks secret starts with whsec_');
  return Buffer.from(secret.slice('whsec_'.length), 'base64');
}

const sign = (key: Buffer, id: string, ts: string, body: string) => `v1,${hmac('sha256', key, `${id}.${ts}.${body}`).toString('base64')}`;

export function webhook(c: WebhookConfig): ChannelAdapter {
  const key = keyOf(c.secret);
  const tolerance = c.toleranceSeconds ?? 300;
  return made({
    kind: 'webhook',
    provider: 'standard-webhooks',
    sender: c.endpoint,
    verify(w, now): Verified | Refusal {
      const id = w.headers['webhook-id'];
      const ts = w.headers['webhook-timestamp'];
      const sigs = w.headers['webhook-signature'];
      if (!id || !ts || !sigs) return { refused: 'signature-missing' };
      if (!fresh(ts, now, tolerance, c.fault)) return { refused: 'timestamp-stale' };
      const expected = sign(key, id, ts, w.body);
      // Several signatures may be listed while a key rotates; one that matches is enough.
      if (!sigs.split(' ').some((s) => signatureMatches(s, expected, c.fault))) return { refused: 'signature-invalid' };
      // The signature is the source's own, so the claim is verified (K11).
      return { messages: [{ providerMessageId: id, fields: { source: c.source }, body: w.body, claims: { verified: true, sender: c.source } }], receipts: [] };
    },
    async send(out, t): Promise<SendResult> {
      if (!t.http) return { ok: false, permanent: true, error: 'no http transport' };
      // A delivery goes to the source's configured endpoint, and only for that source: the recipient is the thread's
      // source, never a URL a caller chose (polywatch).
      if (out.to !== c.source) return { ok: false, permanent: true, error: `no endpoint is configured for ${out.to}; this adapter delivers to source ${c.source}` };
      // The id comes from the idempotency key, so a retried delivery carries the same id, on which the consumer dedupes.
      const id = `msg_${createHash('sha256').update(out.idempotencyKey).digest('base64url').slice(0, 27)}`;
      const ts = String(Math.floor(out.now / 1000));
      let r;
      try {
        r = await t.http.request({ method: 'POST', url: c.endpoint, headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sign(key, id, ts, out.body) }, body: out.body });
      } catch (e) { return noAnswer(e); }
      // Success is a 2xx answer, and any other answer a failure, retried by the outbox.
      return r.status >= 200 && r.status < 300 ? { ok: true, providerId: id } : { ok: false, permanent: false, error: String(r.status) };
    },
  });
}
