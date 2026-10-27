// The handlers of payments.charge, carrier.ship and payments.refund (docs/examples/order-fulfilment.md). They hold no
// rule: the gate has let the intent through, and the program has already decided the step. Each request carries the
// intent's idempotency key, the same on every attempt, so a retry whose answer was lost is one charge, one shipment or
// one refund. The body names the order by its instance id.
import type { Effects } from '../.poly/build/fulfilment.Order/types.js';

interface Egress {
  post(url: string, body: unknown, options?: { headers?: Record<string, string> }): Promise<{ status: number }>;
}
interface Context {
  idempotencyKey?: string;
  instanceId?: string;
}

const CHARGES_URL = 'https://payments.example/v1/charges';
const SHIPMENTS_URL = 'https://carrier.example/v1/shipments';
const REFUNDS_URL = 'https://payments.example/v1/refunds';

/** A refusal the same request would meet again (a declined card), so it is not retried. */
const refuse = (message: string): Error => Object.assign(new Error(message), { permanent: true });

async function send(url: string, caps: { egress: Egress }, ctx: Context): Promise<{ ok: true }> {
  const headers: Record<string, string> = ctx.idempotencyKey ? { 'idempotency-key': ctx.idempotencyKey } : {};
  const res = await caps.egress.post(url, { order: ctx.instanceId }, { headers });
  if (res.status === 200 || res.status === 201) return { ok: true };
  // A 4xx other than 429 is the service refusing this request; anything else is tried again.
  if (res.status >= 400 && res.status < 500 && res.status !== 429) throw refuse(`${url} answered ${res.status}`);
  throw new Error(`${url} answered ${res.status}`);
}

export const charge = (_payload: Effects['payments.charge'], caps: { egress: Egress }, ctx: Context) => send(CHARGES_URL, caps, ctx);
export const ship = (_payload: Effects['carrier.ship'], caps: { egress: Egress }, ctx: Context) => send(SHIPMENTS_URL, caps, ctx);
export const refund = (_payload: Effects['payments.refund'], caps: { egress: Egress }, ctx: Context) => send(REFUNDS_URL, caps, ctx);
