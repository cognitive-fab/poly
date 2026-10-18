import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupportAgent } from "../src/agent.ts";
import { loadOrders, type Order } from "../src/orders.ts";
import { Store } from "../src/store.ts";
import { StripeError, type RefundRequest, type StripeRefund } from "../src/stripe.ts";

export const ORDERS_FILE = join(import.meta.dirname, "..", "orders.json");
export const ADA = "15550100001";
export const BEN = "15550100002";
export const STRANGER = "15559999999";

/** In-memory Stripe double that honours idempotency keys like the real API. */
export class FakeStripe {
  calls: RefundRequest[] = [];
  byKey = new Map<string, StripeRefund>();
  failNext: StripeError | null = null;
  status = "succeeded";

  async createRefund(req: RefundRequest): Promise<StripeRefund> {
    this.calls.push(req);
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) return existing;
    const refund = { id: `re_${this.byKey.size + 1}`, status: this.status, amount: req.amount };
    this.byKey.set(req.idempotencyKey, refund);
    return refund;
  }

  /** Refunds that were actually created (distinct idempotency keys). */
  get created(): StripeRefund[] {
    return [...this.byKey.values()];
  }
}

export async function setup(opts: { now?: string; orders?: Order[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "support-agent-"));
  const store = new Store(join(dir, "state.json"));
  await store.load();
  const stripe = new FakeStripe();
  const clock = { now: new Date(opts.now ?? "2026-10-18T12:00:00Z") };
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const agent = new SupportAgent({
    store,
    stripe,
    loadOrders: async () => opts.orders ?? (await loadOrders(ORDERS_FILE)),
    refundWindowDays: 30,
    now: () => clock.now,
    log: (event, data) => logs.push({ event, data }),
  });
  return { dir, store, stripe, agent, clock, logs };
}
