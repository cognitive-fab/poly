// The handlers of retention.offer and billing.cancel (docs/examples/subscription-cancel.md). They hold no rule: the gate has let
// the intent through, and the program has decided the step. Each request carries the intent's idempotency key, the same on
// every attempt, so a retried offer or cancellation whose answer was lost is one offer or one cancellation. The body names the
// subscription by its instance id.
import type { Effects } from '../.poly/build/subscription.Subscription/types.js';

interface Egress {
  post(url: string, body: unknown, options?: { headers?: Record<string, string> }): Promise<{ status: number }>;
}
interface Context {
  idempotencyKey?: string;
  instanceId?: string;
}

const OFFERS_URL = 'https://marketing.example/v1/offers';
const CANCEL_URL = 'https://billing.example/v1/subscriptions/cancel';

/** A refusal the same request would meet again, so it is not retried (the effect fails at once). */
const refuse = (message: string): Error => Object.assign(new Error(message), { permanent: true });

async function send(url: string, caps: { egress: Egress }, ctx: Context): Promise<{ ok: true }> {
  const headers: Record<string, string> = ctx.idempotencyKey ? { 'idempotency-key': ctx.idempotencyKey } : {};
  const res = await caps.egress.post(url, { subscription: ctx.instanceId }, { headers });
  if (res.status === 200 || res.status === 201) return { ok: true };
  // A 4xx other than 429 is the service refusing this request; anything else is tried again.
  if (res.status >= 400 && res.status < 500 && res.status !== 429) throw refuse(`${url} answered ${res.status}`);
  throw new Error(`${url} answered ${res.status}`);
}

export const offer = (_payload: Effects['retention.offer'], caps: { egress: Egress }, ctx: Context) => send(OFFERS_URL, caps, ctx);
export const cancel = (_payload: Effects['billing.cancel'], caps: { egress: Egress }, ctx: Context) => send(CANCEL_URL, caps, ctx);
