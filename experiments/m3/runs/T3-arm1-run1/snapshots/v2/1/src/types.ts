// The types of host.ts, copied so src/ imports nothing outside itself.

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

export interface PaymentView {
  status: 'authorizing' | 'authorized' | 'declined' | 'failed' | 'captured' | 'voided' | 'refunded';
  authorized: number;
  captured: number;
  refunded: number;
  requests: number;
}

export interface Host extends Effects {
  authorize(payment: string, amount: number): Promise<Outcome>;
  timedOut(payment: string): Promise<Outcome>;
  capture(payment: string, amount: number): Promise<Outcome>;
  void(payment: string): Promise<Outcome>;
  increase(payment: string): Promise<Outcome>;
  expire(payment: string): Promise<Outcome>;
  refund(payment: string, amount: number): Promise<Outcome>;
  payment(payment: string): Promise<PaymentView | null>;
}

export type CreateHost = () => Promise<Host>;
