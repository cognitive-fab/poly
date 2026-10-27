// The handler of claims.assign (docs/examples/claim-intake.md). It holds no rule: the gate has let the intent through (a flagged
// claim only with a person's signed approval). The request carries the intent's idempotency key, the same on every attempt, so a
// retried assignment whose answer was lost is one assignment.
import type { Effects } from '../.poly/build/claims.Claim/types.js';

interface Egress {
  post(url: string, body: unknown, options?: { headers?: Record<string, string> }): Promise<{ status: number }>;
}

const QUEUES_URL = 'https://claims.example/v1/queues';

/** A refusal the same request would meet again, so it is not retried (the effect fails at once). */
const refuse = (message: string): Error => Object.assign(new Error(message), { permanent: true });

export async function assign(payload: Effects['claims.assign'], caps: { egress: Egress }, ctx: { idempotencyKey?: string; instanceId?: string }): Promise<{ ok: true }> {
  const headers: Record<string, string> = ctx.idempotencyKey ? { 'idempotency-key': ctx.idempotencyKey } : {};
  const res = await caps.egress.post(QUEUES_URL, { queue: payload.category.toLowerCase(), flagged: payload.flagged, claim: ctx.instanceId }, { headers });
  if (res.status === 200 || res.status === 201) return { ok: true };
  // A 4xx other than 429 is the claims system refusing this assignment; anything else is tried again.
  if (res.status >= 400 && res.status < 500 && res.status !== 429) throw refuse(`claims answered ${res.status}`);
  throw new Error(`claims answered ${res.status}`);
}
