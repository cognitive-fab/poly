import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RefundRecord {
  order: string;
  customer: string;
  skus: string[];
  amount: number;
  currency: string;
  stripeRefundId: string;
  status: string;
  createdAt: string;
}

export interface PendingRefund {
  order: string;
  skus: string[];
  amount: number;
  idempotencyKey: string;
  expiresAt: number; // epoch ms
}

export interface State {
  refunds: RefundRecord[];
  pending: Record<string, PendingRefund>; // keyed by customer phone
  processedMessages: string[]; // recent WhatsApp message ids, for de-duplicating webhook retries
}

const MAX_PROCESSED_IDS = 5000;

/** Small JSON-file-backed store. All writes are atomic (write temp file, then rename). */
export class Store {
  readonly file: string;
  state: State = { refunds: [], pending: {}, processedMessages: [] };

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      this.state = {
        refunds: data.refunds ?? [],
        pending: data.pending ?? {},
        processedMessages: data.processedMessages ?? [],
      };
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.file);
  }

  /** Returns false if the message id was already seen. */
  async markProcessed(messageId: string): Promise<boolean> {
    if (this.state.processedMessages.includes(messageId)) return false;
    this.state.processedMessages.push(messageId);
    if (this.state.processedMessages.length > MAX_PROCESSED_IDS) {
      this.state.processedMessages.splice(0, this.state.processedMessages.length - MAX_PROCESSED_IDS);
    }
    await this.save();
    return true;
  }

  refundsFor(order: string): RefundRecord[] {
    return this.state.refunds.filter((r) => r.order === order);
  }
}
