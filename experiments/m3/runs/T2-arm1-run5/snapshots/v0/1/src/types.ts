// Copy of the host interface types (host.ts lives outside src/).

export interface Message {
  id: string;
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

export interface Network {
  inFlight(): Promise<Message[]>;
  deliver(id: string): Promise<void>;
  deliverAll(): Promise<void>;
}

export type Outcome = { ok: true } | { ok: false; reason: string };

export interface OrderView {
  status: 'pending' | 'confirmed' | 'rejected' | 'cancelling' | 'cancelled';
  qty: number;
}

export interface Host extends Network {
  place(order: string, qty: number): Promise<Outcome>;
  cancel(order: string): Promise<Outcome>;
  restock(): Promise<Outcome>;
  order(order: string): Promise<OrderView | null>;
  stock(): Promise<{ available: number; reserved: number }>;
}

export type CreateHost = () => Promise<Host>;
