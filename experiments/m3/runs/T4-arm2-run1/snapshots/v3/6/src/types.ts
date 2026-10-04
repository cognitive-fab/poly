// The host interface of host.ts, restated here so src/ imports nothing outside src/.

export interface Message {
  id: string;
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

export type Outcome = { ok: true } | { ok: false; reason: string };

export type CartStatus = 'open' | 'reserving' | 'paying' | 'paid' | 'failed' | 'cancelling' | 'cancelled' | 'returned' | 'declined' | 'abandoning';

export interface CartView {
  status: CartStatus;
  items: number;
}

export interface Host {
  inFlight(): Promise<Message[]>;
  deliver(id: string): Promise<void>;
  deliverAll(): Promise<void>;
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
  cart(cart: string): Promise<CartView | null>;
  stock(): Promise<{ available: number; reserved: number }>;
  payments(): Promise<{ charged: number; declining: boolean }>;
}

export type CreateHost = () => Promise<Host>;
