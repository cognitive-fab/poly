import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface RefundRecord {
  order: string;
  skus: string[];
  amount: number;
  refundId: string;
  at: string;
}

/**
 * Record of refunds this agent has issued, used to stop an order from being
 * refunded twice. Persisted to a JSON file when a path is given.
 */
export class Ledger {
  #path: string | undefined;
  #records: RefundRecord[];

  constructor(path?: string) {
    this.#path = path;
    this.#records = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  }

  forOrder(order: string): RefundRecord[] {
    return this.#records.filter((r) => r.order === order);
  }

  all(): RefundRecord[] {
    return [...this.#records];
  }

  add(record: RefundRecord): void {
    this.#records.push(record);
    if (this.#path) {
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#records, null, 2));
      renameSync(tmp, this.#path);
    }
  }
}
