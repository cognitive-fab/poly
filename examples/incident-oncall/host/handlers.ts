// The handlers of pager.page and pager.escalate (docs/examples/incident-oncall.md). They hold no rule: the gate has let
// the intent through, and the program has decided the step. Each request carries the intent's idempotency key, the same
// on every attempt, so a retried page whose answer was lost pages once. The body names the incident by its instance id.
import type { Effects } from '../.poly/build/oncall.Incident/types.js';

interface Egress {
  post(url: string, body: unknown, options?: { headers?: Record<string, string> }): Promise<{ status: number }>;
}
interface Context {
  idempotencyKey?: string;
  instanceId?: string;
}

const PAGES_URL = 'https://pager.example/v1/pages';
const ESCALATIONS_URL = 'https://pager.example/v1/escalations';

/** A refusal the same request would meet again, so it is not retried (the effect fails at once). */
const refuse = (message: string): Error => Object.assign(new Error(message), { permanent: true });

async function send(url: string, caps: { egress: Egress }, ctx: Context): Promise<{ ok: true }> {
  const headers: Record<string, string> = ctx.idempotencyKey ? { 'idempotency-key': ctx.idempotencyKey } : {};
  const res = await caps.egress.post(url, { incident: ctx.instanceId }, { headers });
  if (res.status === 200 || res.status === 201) return { ok: true };
  // A 4xx other than 429 is the pager refusing this request; anything else is tried again.
  if (res.status >= 400 && res.status < 500 && res.status !== 429) throw refuse(`pager answered ${res.status}`);
  throw new Error(`pager answered ${res.status}`);
}

export const page = (_payload: Effects['pager.page'], caps: { egress: Egress }, ctx: Context) => send(PAGES_URL, caps, ctx);
export const escalate = (_payload: Effects['pager.escalate'], caps: { egress: Egress }, ctx: Context) => send(ESCALATIONS_URL, caps, ctx);
