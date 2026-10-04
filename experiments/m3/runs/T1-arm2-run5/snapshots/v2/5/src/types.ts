// The host interface, as declared in host.ts (kept under src/ so the delivery imports only src/).

export type Outcome = { ok: true } | { ok: false; reason: string };

export interface Effect {
  id: string;
  from: string;
  kind: string;
  data: Record<string, unknown>;
}

export interface Effects {
  pendingEffects(): Promise<Effect[]>;
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
  order(order: string): Promise<OrderView | null>;
}

export type CreateHost = () => Promise<Host>;
