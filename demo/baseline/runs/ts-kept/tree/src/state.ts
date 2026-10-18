import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * A refund attempt. Entries whose status is not "failed" reserve their items,
 * so the same item can never be refunded twice — even across restarts.
 *  - issuing:   request sent, outcome not yet known (crash mid-request leaves this)
 *  - uncertain: Stripe unreachable / 5xx; retried later with the same idempotency key
 *  - succeeded / pending: Stripe accepted the refund
 */
export interface RefundEntry {
  idempotencyKey: string;
  order: string;
  customer: string;
  items: number[]; // indexes into order.items
  amount: number;
  status: "issuing" | "uncertain" | "succeeded" | "pending";
  refundId?: string;
  createdAt: string;
}

export interface PendingConfirmation {
  order: string;
  items: number[];
  amount: number;
  idempotencyKey: string;
  expiresAt: number;
}

interface StateData {
  refunds: RefundEntry[];
  pending: Record<string, PendingConfirmation>;
  seenMessages: string[];
}

const MAX_SEEN = 5000;

export class StateStore {
  private data: StateData;
  private readonly path: string | null;

  /** Pass null for an in-memory store (tests). */
  constructor(path: string | null) {
    this.path = path;
    this.data =
      path && existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")) as StateData)
        : { refunds: [], pending: {}, seenMessages: [] };
  }

  get refunds(): readonly RefundEntry[] {
    return this.data.refunds;
  }

  /** Returns true the first time a WhatsApp message ID is seen (webhooks are retried). */
  markSeen(messageId: string): boolean {
    if (this.data.seenMessages.includes(messageId)) return false;
    this.data.seenMessages.push(messageId);
    if (this.data.seenMessages.length > MAX_SEEN) this.data.seenMessages.splice(0, this.data.seenMessages.length - MAX_SEEN);
    this.save();
    return true;
  }

  getPending(customer: string, now: number): PendingConfirmation | undefined {
    const p = this.data.pending[customer];
    if (p && p.expiresAt <= now) {
      this.clearPending(customer);
      return undefined;
    }
    return p;
  }

  setPending(customer: string, p: PendingConfirmation): void {
    this.data.pending[customer] = p;
    this.save();
  }

  clearPending(customer: string): void {
    delete this.data.pending[customer];
    this.save();
  }

  /** Item indexes of an order already refunded or with a refund in flight. */
  reservedItems(order: string): Set<number> {
    return new Set(this.data.refunds.filter((r) => r.order === order).flatMap((r) => r.items));
  }

  reservedAmount(order: string): number {
    return this.data.refunds.filter((r) => r.order === order).reduce((s, r) => s + r.amount, 0);
  }

  addRefund(entry: RefundEntry): void {
    this.data.refunds.push(entry);
    this.save();
  }

  updateRefund(key: string, patch: Partial<RefundEntry>): void {
    const e = this.data.refunds.find((r) => r.idempotencyKey === key);
    if (e) Object.assign(e, patch);
    this.save();
  }

  /** A definite failure releases the reservation so the customer can try again. */
  removeRefund(key: string): void {
    this.data.refunds = this.data.refunds.filter((r) => r.idempotencyKey !== key);
    this.save();
  }

  private save(): void {
    if (!this.path) return;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
