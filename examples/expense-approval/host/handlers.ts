// The handler of payroll.pay (docs/examples/expense-approval.md). It holds no rule: the gate has let the intent through
// (a payment above 200 euros only with a person's signed approval). The request carries the intent's idempotency key, the
// same on every attempt, so a retried payment whose answer was lost is one payment. The amount is in units of 50 euros.
import type { Effects } from '../.poly/build/expenses.Expense/types.js';

const REIMBURSEMENTS_URL = 'https://payroll.example/v1/reimbursements';
const EUROS_PER_UNIT = 50;

interface Egress {
  post(url: string, body: unknown, options?: { headers?: Record<string, string> }): Promise<{ status: number }>;
}

/** A refusal the same request would meet again, so it is not retried (the effect fails at once). */
const refuse = (message: string): Error => Object.assign(new Error(message), { permanent: true });

export async function pay(payload: Effects['payroll.pay'], caps: { egress: Egress }, ctx: { idempotencyKey?: string }): Promise<{ ok: true }> {
  const headers: Record<string, string> = ctx.idempotencyKey ? { 'idempotency-key': ctx.idempotencyKey } : {};
  const res = await caps.egress.post(REIMBURSEMENTS_URL, { euros: payload.amount * EUROS_PER_UNIT }, { headers });
  if (res.status === 200 || res.status === 201) return { ok: true };
  // A 4xx other than 429 is payroll refusing this payment; anything else is tried again.
  if (res.status >= 400 && res.status < 500 && res.status !== 429) throw refuse(`payroll answered ${res.status}`);
  throw new Error(`payroll answered ${res.status}`);
}
