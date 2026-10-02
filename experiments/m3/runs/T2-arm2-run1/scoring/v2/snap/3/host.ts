// T2 after change 2, orders and inventory with expiry and stocktakes: the host interface every arm implements (PT13, S91).

/** A message sent by one part of the system to another, not yet delivered. */
export interface Message {
  id: string;
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

/** The network: nothing is delivered until deliver or deliverAll is called. */
export interface Network {
  /** Every message in transit, in no promised order. */
  inFlight(): Promise<Message[]>;
  /** Deliver one message in transit, by its id. */
  deliver(id: string): Promise<void>;
  /** Deliver every message in transit, and every message those deliveries send, until none is left. */
  deliverAll(): Promise<void>;
}

/** The outcome of a command: it took effect, or it was refused and changed nothing. */
export type Outcome = { ok: true } | { ok: false; reason: string };

export interface OrderView {
  status: 'pending' | 'confirmed' | 'rejected' | 'cancelling' | 'cancelled' | 'expired';
  qty: number;
}

export interface Host extends Network {
  place(order: string, qty: number): Promise<Outcome>;
  cancel(order: string): Promise<Outcome>;
  expire(order: string): Promise<Outcome>;
  restock(): Promise<Outcome>;
  close(): Promise<Outcome>;
  open(): Promise<Outcome>;
  /** The order, or null when no order has that id. */
  order(order: string): Promise<OrderView | null>;
  stock(): Promise<{ available: number; reserved: number; open: boolean }>;
}

/** The module's default export: a factory of a fresh system, with the inventory and no orders. */
export type CreateHost = () => Promise<Host>;
