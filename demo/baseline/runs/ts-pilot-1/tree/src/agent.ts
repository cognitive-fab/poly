import type { Ledger } from './ledger.ts';
import type { Order } from './orders.ts';
import { normalizePhone } from './orders.ts';
import type { StripeClient } from './stripe.ts';

export interface AgentDeps {
  getOrders: () => Order[];
  ledger: Ledger;
  stripe: StripeClient;
  refundWindowDays: number;
  now?: () => Date;
  /** How long a quoted refund waits for the customer's YES. */
  confirmTtlMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface Pending {
  orderId: string;
  /** null = refund everything still refundable on the order. */
  skus: string[] | null;
  amount: number;
  expiresAt: number;
}

interface Plan {
  order: Order;
  skus: string[];
  amount: number;
  refundedBefore: number;
}

const YES = /^(yes|y|confirm)[.!]*$/i;
const NO = /^(no|n|cancel|stop)[.!]*$/i;
const REFUND_WORDS = /\b(refund|money back|reimburse)/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export function formatMoney(amount: number, currency: string): string {
  const nf = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() });
  const digits = nf.resolvedOptions().maximumFractionDigits ?? 2;
  return nf.format(amount / 10 ** digits);
}

/**
 * Conversation logic. A customer can only see and refund orders whose
 * `customer` phone number matches the WhatsApp number they write from, and
 * every refund has to be quoted and then confirmed with YES.
 */
export class SupportAgent {
  #deps: AgentDeps;
  #pending = new Map<string, Pending>();

  constructor(deps: AgentDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return (this.#deps.now?.() ?? new Date()).getTime();
  }

  #log(msg: string, extra?: Record<string, unknown>): void {
    this.#deps.log?.(msg, extra);
  }

  #ordersFor(customer: string): Order[] {
    return this.#deps.getOrders().filter((o) => normalizePhone(o.customer) === customer);
  }

  async handle(from: string, text: string): Promise<string> {
    const customer = normalizePhone(from);
    const msg = text.trim();
    const now = this.#now();

    let pending = this.#pending.get(customer);
    if (pending && pending.expiresAt <= now) {
      this.#pending.delete(customer);
      pending = undefined;
    }

    if (YES.test(msg)) {
      if (!pending) return 'There is no refund waiting for confirmation. Send "refund" followed by your order number to start one.';
      return this.#confirm(customer, pending);
    }
    if (NO.test(msg)) {
      if (!pending) return 'OK. Let me know if you need anything else.';
      this.#pending.delete(customer);
      return 'OK, I cancelled that request. No refund was issued.';
    }

    const myOrders = this.#ordersFor(customer);
    const upper = msg.toUpperCase();
    const ids = [...new Set([...upper.matchAll(/\bORD-\d+\b/g)].map((m) => m[0]))];

    if (ids.length === 0) {
      if (!REFUND_WORDS.test(msg)) return this.#help(myOrders);
      if (myOrders.length === 0) {
        return "I couldn't find any orders linked to this WhatsApp number. Please write from the phone number you used when ordering.";
      }
      return `Which order should I refund? Reply with e.g. "refund ${myOrders[0].order}".\n\n${this.#listOrders(myOrders)}`;
    }
    if (ids.length > 1) return 'Please ask about one order at a time, e.g. "refund ORD-1234".';

    const order = myOrders.find((o) => o.order.toUpperCase() === ids[0]);
    if (!order) {
      // Same reply whether the order doesn't exist or belongs to someone else.
      return `I couldn't find order ${ids[0]} on the account linked to this WhatsApp number.`;
    }

    const tokens = new Set(upper.split(/[^A-Z0-9_-]+/));
    const skus = order.items.filter((i) => tokens.has(i.sku.toUpperCase())).map((i) => i.sku);
    const requested = skus.length > 0 ? skus : null;

    const plan = this.#plan(order, requested, now);
    if (typeof plan === 'string') {
      this.#pending.delete(customer);
      return plan;
    }

    this.#pending.set(customer, {
      orderId: order.order,
      skus: requested,
      amount: plan.amount,
      expiresAt: now + (this.#deps.confirmTtlMs ?? 10 * 60 * 1000),
    });
    return (
      `I can refund ${formatMoney(plan.amount, order.currency)} for ${order.order} (${plan.skus.join(', ')}) ` +
      `to your original payment method.\n\nReply YES to confirm or NO to cancel.`
    );
  }

  /** Returns the refund that would be issued, or a message explaining why not. */
  #plan(order: Order, skus: string[] | null, now: number): Plan | string {
    const placed = Date.parse(`${order.placed}T00:00:00Z`);
    const windowDays = this.#deps.refundWindowDays;
    if (Number.isNaN(placed) || now - placed > windowDays * DAY_MS) {
      return (
        `${order.order} was placed on ${order.placed}, which is outside our ${windowDays}-day refund window, ` +
        `so I can't refund it automatically. Please contact our support team.`
      );
    }

    const records = this.#deps.ledger.forOrder(order.order);
    const refundedBefore = records.reduce((sum, r) => sum + r.amount, 0);
    const refundedSkus = new Set(records.flatMap((r) => r.skus));
    const remaining = order.total - refundedBefore;
    if (remaining <= 0) return `${order.order} has already been fully refunded.`;

    if (skus === null) {
      const left = order.items.filter((i) => !refundedSkus.has(i.sku)).map((i) => i.sku);
      return { order, skus: left, amount: remaining, refundedBefore };
    }

    const todo = skus.filter((s) => !refundedSkus.has(s));
    if (todo.length === 0) return `${skus.join(', ')} on ${order.order} ${skus.length > 1 ? 'have' : 'has'} already been refunded.`;
    const itemsAmount = order.items.filter((i) => todo.includes(i.sku)).reduce((sum, i) => sum + i.price, 0);
    return { order, skus: todo, amount: Math.min(itemsAmount, remaining), refundedBefore };
  }

  async #confirm(customer: string, pending: Pending): Promise<string> {
    // Remove before any await so a second YES can't trigger a second refund.
    this.#pending.delete(customer);
    const now = this.#now();

    const order = this.#ordersFor(customer).find((o) => o.order === pending.orderId);
    if (!order) return `I couldn't find order ${pending.orderId} on your account any more.`;

    const plan = this.#plan(order, pending.skus, now);
    if (typeof plan === 'string') return plan;
    if (plan.amount !== pending.amount) {
      return 'The refundable amount for that order has changed. Please send your refund request again.';
    }

    // Same order state gives the same key, so a retry after a timeout or crash
    // gets back the original Stripe refund instead of creating a second one.
    const idempotencyKey = `refund:${order.order}:${plan.refundedBefore}:${plan.skus.join(',')}:${plan.amount}`;

    let refund;
    try {
      refund = await this.#deps.stripe.createRefund({
        charge: order.charge,
        amount: plan.amount,
        idempotencyKey,
        metadata: { order: order.order, skus: plan.skus.join(','), source: 'whatsapp-support-agent' },
      });
    } catch (err) {
      this.#log('stripe refund failed', { order: order.order, error: String(err) });
      this.#pending.set(customer, { ...pending, expiresAt: now + (this.#deps.confirmTtlMs ?? 10 * 60 * 1000) });
      return (
        "Sorry, I couldn't complete the refund just now. Reply YES in a few minutes to try again. " +
        'You will not be refunded twice.'
      );
    }

    if (refund.status === 'failed' || refund.status === 'canceled') {
      this.#log('stripe refund not successful', { order: order.order, refund: refund.id, status: refund.status });
      return `Sorry, the refund for ${order.order} could not be completed. Please contact our support team.`;
    }

    this.#deps.ledger.add({
      order: order.order,
      skus: plan.skus,
      amount: plan.amount,
      refundId: refund.id,
      at: new Date(now).toISOString(),
    });
    this.#log('refund issued', { order: order.order, refund: refund.id, amount: plan.amount });
    return (
      `Done! I refunded ${formatMoney(plan.amount, order.currency)} for ${order.order} (reference ${refund.id}). ` +
      'It usually shows up on your statement within 5–10 business days.'
    );
  }

  #listOrders(orders: Order[]): string {
    return (
      'Your orders:\n' +
      orders
        .map((o) => `• ${o.order} (${o.placed}): ${o.items.map((i) => i.sku).join(', ')}, ${formatMoney(o.total, o.currency)}`)
        .join('\n')
    );
  }

  #help(orders: Order[]): string {
    const greeting = orders.length > 0 ? `Hi ${orders[0].name.split(' ')[0]}! ` : 'Hi! ';
    const lines = [
      `${greeting}I can help you with refunds.`,
      '• "refund ORD-1234" refunds a whole order',
      '• "refund ORD-1234 SKU-1" refunds specific items',
    ];
    if (orders.length > 0) lines.push('', this.#listOrders(orders));
    return lines.join('\n');
  }
}
