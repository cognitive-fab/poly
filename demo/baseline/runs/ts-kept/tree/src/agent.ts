import { randomUUID } from "node:crypto";
import { formatMoney, normalizePhone, type Order } from "./orders.ts";
import type { StateStore } from "./state.ts";
import type { RefundGateway } from "./stripe.ts";

export interface AgentOptions {
  orders: Order[];
  state: StateStore;
  refunds: RefundGateway;
  refundWindowDays: number;
  confirmTtlMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

const DAY_MS = 86_400_000;
const ORDER_RE = /\bORD-\d+\b/i;

/**
 * Deterministic refund agent. Rules it never breaks:
 *  - a customer can only see or refund orders placed from their own WhatsApp number;
 *  - nothing is refunded without an explicit YES to a quoted amount;
 *  - an item is refunded at most once, and an order never beyond its total;
 *  - refunds go back to the original Stripe charge only.
 */
export class RefundAgent {
  private readonly o: Required<AgentOptions>;

  constructor(opts: AgentOptions) {
    this.o = { confirmTtlMs: 15 * 60_000, now: Date.now, log: console.log, ...opts };
  }

  async handle(fromRaw: string, text: string | null): Promise<string> {
    const from = normalizePhone(fromRaw);
    const mine = this.o.orders.filter((o) => o.customer === from);
    if (mine.length === 0) {
      return "Sorry, I couldn't find any orders linked to this WhatsApp number. Please message us from the number you used when ordering.";
    }
    if (text === null) return "I can only read text messages. " + this.menu(mine);

    const msg = text.trim();
    const pending = this.o.state.getPending(from, this.o.now());

    if (/^(yes|y|confirm|yes please)[.!]*$/i.test(msg)) {
      if (!pending) return "There's no refund waiting for confirmation. " + this.menu(mine);
      return this.confirm(from, pending);
    }
    if (/^(no|n|cancel|stop)[.!]*$/i.test(msg)) {
      if (!pending) return "OK. " + this.menu(mine);
      this.o.state.clearPending(from);
      return `OK, I've cancelled that request. Nothing was refunded.`;
    }

    const orderMatch = msg.match(ORDER_RE);
    if (orderMatch) return this.quote(from, mine, orderMatch[0].toUpperCase(), msg);

    const greeting = mine[0]!.name.split(" ")[0];
    return `Hi ${greeting}! ` + this.menu(mine);
  }

  /** Retries refunds whose outcome is unknown (crash or Stripe outage), reusing their idempotency keys. */
  async reconcile(includeIssuing = true, notify?: (to: string, text: string) => Promise<void>): Promise<void> {
    for (const r of [...this.o.state.refunds]) {
      if (r.status !== "uncertain" && !(includeIssuing && r.status === "issuing")) continue;
      const order = this.o.orders.find((o) => o.order === r.order);
      if (!order) continue;
      this.o.log(`reconciling refund ${r.idempotencyKey} for ${r.order}`);
      const res = await this.issue(order, r.idempotencyKey, r.items, r.amount);
      const money = formatMoney(r.amount, order.currency);
      const text =
        res.kind === "ok"
          ? `Update: your refund of ${money} for ${order.order} has now been issued (ref ${res.id}).`
          : res.kind === "rejected"
            ? `Update: we couldn't complete your refund of ${money} for ${order.order} automatically. Our support team will follow up with you.`
            : null;
      if (text && notify) await notify(r.customer, text).catch((err) => this.o.log(`notify failed: ${String(err)}`));
    }
  }

  private quote(from: string, mine: Order[], orderId: string, msg: string): string {
    const order = mine.find((o) => o.order === orderId);
    // Same answer whether the order doesn't exist or belongs to someone else.
    if (!order) return `I couldn't find order ${orderId} on your account. ` + this.menu(mine);

    const placed = Date.parse(order.placed);
    if (this.o.now() - placed > this.o.refundWindowDays * DAY_MS) {
      this.o.log(`out-of-window refund request from ${from} for ${order.order} — needs human review`);
      return `Order ${order.order} was placed on ${order.placed}, which is outside our ${this.o.refundWindowDays}-day refund window. I've noted your request; a member of our team can review it.`;
    }

    const reserved = this.o.state.reservedItems(order.order);
    const remaining = order.items.map((_, i) => i).filter((i) => !reserved.has(i));
    if (remaining.length === 0) return `Order ${order.order} has already been fully refunded.`;

    // Any other SKU-looking tokens select specific items; none means the whole order.
    const rest = msg.replace(ORDER_RE, " ");
    const tokens = rest.toUpperCase().match(/[A-Z0-9]+(?:-[A-Z0-9]+)+/g) ?? [];
    let items: number[];
    if (tokens.length === 0) {
      items = remaining;
    } else {
      items = [];
      for (const t of new Set(tokens)) {
        const idx = order.items.findIndex((it, i) => it.sku.toUpperCase() === t && !items.includes(i));
        if (idx === -1) return `${order.order} has no item ${t}. Its items are: ${this.itemList(order)}.`;
        if (reserved.has(idx)) return `${order.items[idx]!.sku} on ${order.order} has already been refunded.`;
        items.push(idx);
      }
    }

    const refundable = order.total - this.o.state.reservedAmount(order.order);
    const wholeRest = items.length === remaining.length;
    const itemSum = items.reduce((s, i) => s + order.items[i]!.price, 0);
    // Refunding everything that's left returns the full remaining balance (covers shipping/tax).
    const amount = Math.min(wholeRest ? refundable : itemSum, refundable);
    if (amount <= 0) return `There's nothing left to refund on ${order.order}.`;

    this.o.state.setPending(from, {
      order: order.order,
      items,
      amount,
      idempotencyKey: `refund-${order.order}-${randomUUID()}`,
      expiresAt: this.o.now() + this.o.confirmTtlMs,
    });
    const what = wholeRest && reserved.size === 0 ? `the full order ${order.order}` : `${items.map((i) => order.items[i]!.sku).join(", ")} from ${order.order}`;
    return `I can refund ${formatMoney(amount, order.currency)} for ${what} to your original payment method. Reply YES to confirm or NO to cancel.`;
  }

  private async confirm(from: string, p: { order: string; items: number[]; amount: number; idempotencyKey: string }): Promise<string> {
    this.o.state.clearPending(from);
    const order = this.o.orders.find((o) => o.order === p.order && o.customer === from);
    if (!order) return "Sorry, something went wrong. Please start again.";

    // Re-check: another refund may have landed since the quote.
    const reserved = this.o.state.reservedItems(order.order);
    if (p.items.some((i) => reserved.has(i)) || p.amount > order.total - this.o.state.reservedAmount(order.order)) {
      return `Part of that request has already been refunded, so I didn't issue it again. Send ${order.order} to see what's left.`;
    }

    this.o.state.addRefund({
      idempotencyKey: p.idempotencyKey,
      order: order.order,
      customer: from,
      items: p.items,
      amount: p.amount,
      status: "issuing",
      createdAt: new Date(this.o.now()).toISOString(),
    });
    const res = await this.issue(order, p.idempotencyKey, p.items, p.amount);
    const money = formatMoney(p.amount, order.currency);
    switch (res.kind) {
      case "ok":
        return `Done! Your refund of ${money} for ${order.order} has been issued (ref ${res.id}). It usually appears on your statement within 5–10 business days.`;
      case "rejected":
        return `Sorry, I couldn't issue that refund automatically. I've flagged it for our support team, who will follow up with you.`;
      case "uncertain":
        return `Our payment provider isn't responding right now. Your refund of ${money} is queued and won't be issued twice — we'll complete it and confirm shortly.`;
    }
  }

  private async issue(order: Order, key: string, items: number[], amount: number) {
    const res = await this.o.refunds.createRefund({
      charge: order.charge,
      amount,
      idempotencyKey: key,
      metadata: { order: order.order, items: items.map((i) => order.items[i]!.sku).join(",") },
    });
    if (res.kind === "ok") {
      this.o.state.updateRefund(key, { status: res.status === "succeeded" ? "succeeded" : "pending", refundId: res.id });
      this.o.log(`refund ${res.id} ${res.status}: ${order.order} ${amount}`);
    } else if (res.kind === "rejected") {
      this.o.state.removeRefund(key);
      this.o.log(`refund rejected for ${order.order}: ${res.message} — needs human follow-up`);
    } else {
      this.o.state.updateRefund(key, { status: "uncertain" });
      this.o.log(`refund outcome unknown for ${order.order}: ${res.message} — will retry`);
    }
    return res;
  }

  private menu(mine: Order[]): string {
    const lines = mine.map((o) => `• ${o.order} — ${formatMoney(o.total, o.currency)}, placed ${o.placed}: ${this.itemList(o)}`);
    return `I can help with refunds. Your orders:\n${lines.join("\n")}\n\nReply with an order number (e.g. "refund ${mine[0]!.order}") for the whole order, or add item codes (e.g. "refund ${mine[0]!.order} ${mine[0]!.items[0]!.sku}") for specific items.`;
  }

  private itemList(o: Order): string {
    return o.items.map((it) => `${it.sku} (${formatMoney(it.price, o.currency)})`).join(", ");
  }
}
