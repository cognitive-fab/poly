import { formatMoney, normalizePhone, type Order } from "./orders.ts";
import type { PendingRefund, Store } from "./store.ts";
import { StripeError, type RefundRequest, type StripeRefund } from "./stripe.ts";

export interface AgentDeps {
  store: Store;
  stripe: { createRefund(req: RefundRequest): Promise<StripeRefund> };
  loadOrders: () => Promise<Order[]>;
  refundWindowDays: number;
  confirmTimeoutMs?: number;
  now?: () => Date;
  log?: (event: string, data: Record<string, unknown>) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT = 1000;

/**
 * Deterministic support agent. Every refund decision is made here in code:
 * a customer can only see and refund orders placed from their own WhatsApp number,
 * only within the refund window, never more than what remains unrefunded,
 * and only after explicitly confirming the exact amount.
 */
export class SupportAgent {
  private readonly d: Required<AgentDeps>;

  constructor(deps: AgentDeps) {
    this.d = {
      confirmTimeoutMs: 15 * 60 * 1000,
      now: () => new Date(),
      log: (event, data) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data })),
      ...deps,
    };
  }

  /** Handles one customer message and returns the reply text. */
  async handle(fromRaw: string, textRaw: string | undefined): Promise<string> {
    const from = normalizePhone(fromRaw);
    if (textRaw === undefined) return "Sorry, I can only read text messages. " + HELP;
    const text = textRaw.slice(0, MAX_TEXT).trim();
    const upper = text.toUpperCase();
    const orders = (await this.d.loadOrders()).filter((o) => o.customer === from);
    const pending = this.activePending(from);

    if (/^(YES|Y|CONFIRM)\b/.test(upper)) {
      if (!pending) return "There's no refund waiting for confirmation. " + HELP;
      return this.executeRefund(from, pending, orders);
    }
    if (/^(NO|N|CANCEL|STOP)\b/.test(upper)) {
      if (!pending) return "Okay. " + HELP;
      await this.clearPending(from);
      return `Cancelled — no refund was issued for ${pending.order}.`;
    }

    if (orders.length === 0) {
      return "I couldn't find any orders linked to this WhatsApp number. If you ordered with a different number, please message us from that number.";
    }
    if (/\bREFUND\b/.test(upper)) return this.requestRefund(from, upper, orders);
    if (/\b(ORDERS?|STATUS)\b/.test(upper)) return this.listOrders(orders);
    return `Hi ${orders[0].name.split(" ")[0]}! ` + HELP;
  }

  private listOrders(orders: Order[]): string {
    const lines = orders.map((o) => {
      const refunded = this.refundedAmount(o);
      const status =
        refunded >= o.total ? "fully refunded" : refunded > 0 ? `${formatMoney(refunded, o.currency)} refunded` : "";
      const items = o.items.map((i) => `${i.sku} ${formatMoney(i.price, o.currency)}`).join(", ");
      return `• ${o.order} (${o.placed}) — ${formatMoney(o.total, o.currency)}: ${items}${status ? ` [${status}]` : ""}`;
    });
    return `Your orders:\n${lines.join("\n")}\n\n${HELP}`;
  }

  private async requestRefund(from: string, upper: string, orders: Order[]): Promise<string> {
    const orderId = upper.match(/\b(ORD-[A-Z0-9-]+)\b/)?.[1];
    let order: Order | undefined;
    if (orderId) {
      order = orders.find((o) => o.order.toUpperCase() === orderId);
      // Do not reveal whether an order belonging to someone else exists.
      if (!order) return `I couldn't find order ${orderId} on your account. Reply ORDERS to see your orders.`;
    } else {
      const refundable = orders.filter((o) => this.remainingSkus(o).length > 0);
      if (refundable.length !== 1) {
        return `Which order would you like refunded? Reply e.g. "refund ${orders[0].order}".\n\n` + this.listOrders(orders);
      }
      order = refundable[0];
    }

    const windowEnd = Date.parse(`${order.placed}T00:00:00Z`) + (this.d.refundWindowDays + 1) * DAY_MS;
    if (this.d.now().getTime() >= windowEnd) {
      return `Sorry, ${order.order} was placed on ${order.placed}, which is outside our ${this.d.refundWindowDays}-day refund window.`;
    }

    const remaining = this.remainingSkus(order);
    if (remaining.length === 0) return `${order.order} has already been fully refunded.`;

    // Optional SKUs after the order id select specific items; otherwise refund everything remaining.
    const afterId = orderId ? upper.slice(upper.indexOf(orderId) + orderId.length) : "";
    const tokens = afterId.split(/[\s,]+/).filter(Boolean);
    let skus: string[];
    if (tokens.length === 0) {
      skus = remaining;
    } else {
      skus = [];
      for (const t of tokens) {
        const item = order.items.find((i) => i.sku.toUpperCase() === t);
        if (!item) {
          return `${order.order} has no item "${t}". Items: ${order.items.map((i) => i.sku).join(", ")}.`;
        }
        if (!remaining.includes(item.sku)) return `${item.sku} on ${order.order} has already been refunded.`;
        if (!skus.includes(item.sku)) skus.push(item.sku);
      }
    }

    const amount = this.amountFor(order, skus);
    if (amount <= 0) return `There's nothing left to refund for those items on ${order.order}.`;

    const priorRefunds = this.d.store.refundsFor(order.order).length;
    const pending: PendingRefund = {
      order: order.order,
      skus,
      amount,
      idempotencyKey: `refund:${order.order}:${priorRefunds}:${[...skus].sort().join(",")}`,
      expiresAt: this.d.now().getTime() + this.d.confirmTimeoutMs,
    };
    this.d.store.state.pending[from] = pending;
    await this.d.store.save();

    return (
      `I can refund ${formatMoney(amount, order.currency)} for ${order.order} (${skus.join(", ")}) ` +
      `to your original payment method.\n\nReply YES to confirm or NO to cancel.`
    );
  }

  private async executeRefund(from: string, pending: PendingRefund, orders: Order[]): Promise<string> {
    // Re-validate against current data: orders.json or prior refunds may have changed since the request.
    const order = orders.find((o) => o.order === pending.order);
    const remaining = order ? this.remainingSkus(order) : [];
    if (!order || !pending.skus.every((s) => remaining.includes(s)) || this.amountFor(order, pending.skus) !== pending.amount) {
      await this.clearPending(from);
      return `That refund request is no longer valid. Please send "refund ${pending.order}" again.`;
    }

    let refund: StripeRefund;
    try {
      refund = await this.d.stripe.createRefund({
        charge: order.charge,
        amount: pending.amount,
        idempotencyKey: pending.idempotencyKey,
        metadata: { order: order.order, skus: pending.skus.join(","), customer: from },
      });
    } catch (err) {
      const transient = err instanceof StripeError && err.transient;
      this.d.log("refund_error", { order: order.order, amount: pending.amount, transient, error: (err as Error).message });
      if (transient) {
        // Pending is kept: retrying reuses the same idempotency key, so it can never double-refund.
        return "Sorry, our payment provider didn't respond. Reply YES to try again.";
      }
      await this.clearPending(from);
      return `Sorry, I couldn't process the refund for ${order.order} automatically. A team member will follow up with you.`;
    }

    if (refund.status === "failed" || refund.status === "canceled") {
      this.d.log("refund_failed", { order: order.order, refund: refund.id, status: refund.status });
      await this.clearPending(from);
      return `Sorry, the refund for ${order.order} could not be completed. A team member will follow up with you.`;
    }

    this.d.store.state.refunds.push({
      order: order.order,
      customer: from,
      skus: pending.skus,
      amount: pending.amount,
      currency: order.currency,
      stripeRefundId: refund.id,
      status: refund.status,
      createdAt: this.d.now().toISOString(),
    });
    delete this.d.store.state.pending[from];
    await this.d.store.save();
    this.d.log("refund_issued", { order: order.order, amount: pending.amount, refund: refund.id, status: refund.status });

    return (
      `Done! ${formatMoney(pending.amount, order.currency)} has been refunded for ${order.order} ` +
      `(reference ${refund.id}). It usually takes 5–10 business days to appear on your statement.`
    );
  }

  private activePending(from: string): PendingRefund | undefined {
    const p = this.d.store.state.pending[from];
    return p && p.expiresAt > this.d.now().getTime() ? p : undefined;
  }

  private async clearPending(from: string): Promise<void> {
    delete this.d.store.state.pending[from];
    await this.d.store.save();
  }

  private refundedAmount(order: Order): number {
    return this.d.store.refundsFor(order.order).reduce((s, r) => s + r.amount, 0);
  }

  private remainingSkus(order: Order): string[] {
    const done = new Set(this.d.store.refundsFor(order.order).flatMap((r) => r.skus));
    return order.items.map((i) => i.sku).filter((s) => !done.has(s));
  }

  /** Refunding all remaining items returns the full remaining balance (covers shipping/tax); otherwise item prices. */
  private amountFor(order: Order, skus: string[]): number {
    const left = order.total - this.refundedAmount(order);
    const remaining = this.remainingSkus(order);
    if (remaining.every((s) => skus.includes(s))) return left;
    const sum = order.items.filter((i) => skus.includes(i.sku)).reduce((s, i) => s + i.price, 0);
    return Math.min(sum, left);
  }
}

const HELP =
  'Reply ORDERS to see your orders, "refund ORD-1234" to refund an order, or "refund ORD-1234 SKU" to refund a single item.';
