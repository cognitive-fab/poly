// A copy of the interface in host.ts, so that src/ imports nothing outside it.

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
  inFlight(): Promise<Message[]>;
  deliver(id: string): Promise<void>;
  deliverAll(): Promise<void>;
}

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
  order(order: string): Promise<OrderView | null>;
  stock(): Promise<{ available: number; reserved: number }>;
}

export type CreateHost = () => Promise<Host>;
