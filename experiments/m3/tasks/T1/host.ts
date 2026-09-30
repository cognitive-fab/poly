// T1, order lifecycle: the host interface every arm implements (PT13).

/** The outcome of a command: it took effect, or it was refused and changed nothing. */
export type Outcome = { ok: true } | { ok: false; reason: string };

export interface OrderView {
  status: 'draft' | 'placed' | 'paid' | 'shipped' | 'cancelled' | 'failed';
  items: number;
  charges: number;
  refunds: number;
}

export interface Host {
  create(order: string): Promise<Outcome>;
  addItem(order: string): Promise<Outcome>;
  removeItem(order: string): Promise<Outcome>;
  place(order: string): Promise<Outcome>;
  paymentSucceeded(order: string): Promise<Outcome>;
  paymentFailed(order: string): Promise<Outcome>;
  ship(order: string): Promise<Outcome>;
  cancel(order: string): Promise<Outcome>;
  /** The order, or null when no order has that id. */
  order(order: string): Promise<OrderView | null>;
}

/** The module's default export: a factory of a fresh system, with no orders. */
export type CreateHost = () => Promise<Host>;
