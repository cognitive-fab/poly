// A copy of the host interface types from ../host.ts, so src/ imports only src/.

/** The outcome of a command: it took effect, or it was refused and changed nothing. */
export type Outcome = { ok: true } | { ok: false; reason: string };

/** An effect the system asked the outside world to carry out, not yet completed. */
export interface Effect {
  id: string;
  /** The order that requested it. */
  from: string;
  kind: string;
  data: Record<string, unknown>;
}

/** The effect port: what the payment provider is asked to do, and its answers. */
export interface Effects {
  /** Every effect requested and not yet completed, in no promised order. */
  pendingEffects(): Promise<Effect[]>;
  /** The provider's answer to a pending effect: it went through (ok) or it did not (failed). */
  completeEffect(id: string, outcome: 'ok' | 'failed'): Promise<void>;
}

export interface OrderView {
  status: 'draft' | 'placed' | 'paid' | 'shipped' | 'cancelling' | 'cancelled' | 'declined' | 'failed';
  items: number;
  charges: number;
  refunds: number;
}

export interface Host extends Effects {
  create(order: string): Promise<Outcome>;
  addItem(order: string): Promise<Outcome>;
  removeItem(order: string): Promise<Outcome>;
  place(order: string): Promise<Outcome>;
  ship(order: string): Promise<Outcome>;
  cancel(order: string): Promise<Outcome>;
  retryPayment(order: string): Promise<Outcome>;
  /** The order, or null when no order has that id. */
  order(order: string): Promise<OrderView | null>;
}

/** The module's default export: a factory of a fresh system, with no orders. */
export type CreateHost = () => Promise<Host>;
