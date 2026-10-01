// T4 after change 3, checkout with returns, card retries and payment timeouts: the host interface every arm implements (PT13, S91).

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

export interface CartView {
  status: 'open' | 'reserving' | 'paying' | 'paid' | 'failed' | 'cancelling' | 'cancelled' | 'returned' | 'declined' | 'abandoning';
  items: number;
}

export interface Host extends Network {
  open(cart: string): Promise<Outcome>;
  add(cart: string): Promise<Outcome>;
  checkout(cart: string): Promise<Outcome>;
  cancel(cart: string): Promise<Outcome>;
  returnCart(cart: string): Promise<Outcome>;
  retry(cart: string): Promise<Outcome>;
  abandon(cart: string): Promise<Outcome>;
  paymentTimeout(cart: string): Promise<Outcome>;
  declineCards(): Promise<Outcome>;
  acceptCards(): Promise<Outcome>;
  /** The cart, or null when no cart has that id. */
  cart(cart: string): Promise<CartView | null>;
  stock(): Promise<{ available: number; reserved: number }>;
  payments(): Promise<{ charged: number; declining: boolean }>;
}

/** The module's default export: a factory of a fresh system, with the inventory, the payment service and no carts. */
export type CreateHost = () => Promise<Host>;
