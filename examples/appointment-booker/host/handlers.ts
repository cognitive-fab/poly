// The handler of calendar.write (docs/examples/appointment-booker.md). It holds no rule: the gate has let the intent
// through, and the program has already taken the slot. The runtime hands it `egress`, bound to the one URL the effect
// declares. The request carries the intent's idempotency key, but
// no documentation says the service honours it, so the program attempts the effect once (finding 31).
import type { Effects } from '../.poly/build/booker.Calendar/types.js';

const EVENTS_URL = 'https://calendar.example/v1/events';

interface Egress {
  post(url: string, body: unknown, options?: { headers?: Record<string, string> }): Promise<{ status: number }>;
}

/** A refusal the same request would meet again, so it is not retried (the effect fails at once). */
const refuse = (message: string): Error => Object.assign(new Error(message), { permanent: true });

export async function write(payload: Effects['calendar.write'], caps: { egress: Egress }, ctx: { idempotencyKey?: string }): Promise<{ ok: true }> {
  const day = Math.floor(payload.slot / 2);
  const hour = payload.slot % 2;
  const headers: Record<string, string> = ctx.idempotencyKey ? { 'idempotency-key': ctx.idempotencyKey } : {};
  const res = await caps.egress.post(EVENTS_URL, { day, hour }, { headers });
  if (res.status === 200 || res.status === 201) return { ok: true };
  // A 4xx other than 429 is the calendar refusing this booking; anything else is an end the
  // program cannot read, which its one attempt delivers as exhausted (finding 31).
  if (res.status >= 400 && res.status < 500 && res.status !== 429) throw refuse(`calendar answered ${res.status}`);
  throw new Error(`calendar answered ${res.status}`);
}
