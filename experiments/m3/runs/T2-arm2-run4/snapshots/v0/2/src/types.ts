// The host interface of host.ts, restated under src/ so the delivery imports nothing outside src/.

export interface Message {
  id: string;
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

export type Outcome = { ok: true } | { ok: false; reason: string };

export type OrderStatus = 'pending' | 'confirmed' | 'rejected' | 'cancelling' | 'cancelled';

export interface OrderView {
  status: OrderStatus;
  qty: number;
}

export interface Host {
  inFlight(): Promise<Message[]>;
  deliver(id: string): Promise<void>;
  deliverAll(): Promise<void>;
  place(order: string, qty: number): Promise<Outcome>;
  cancel(order: string): Promise<Outcome>;
  restock(): Promise<Outcome>;
  order(order: string): Promise<OrderView | null>;
  stock(): Promise<{ available: number; reserved: number }>;
}

export type CreateHost = () => Promise<Host>;
