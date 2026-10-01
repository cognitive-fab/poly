// T3, card payments: the host interface every arm implements (PT13).

/** The outcome of a command: it took effect, or it was refused and changed nothing. */
export type Outcome = { ok: true } | { ok: false; reason: string };

/** An effect the system asked the outside world to carry out, not yet completed. */
export interface Effect {
  id: string;
  /** The payment that requested it. */
  from: string;
  kind: string;
  data: Record<string, unknown>;
}

/** The effect port: what the card provider is asked to do, and its answers. */
export interface Effects {
  /** Every effect requested and not yet completed, in no promised order. */
  pendingEffects(): Promise<Effect[]>;
  /** The provider's answer to a pending effect: approved (ok) or declined (failed). */
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
  refund(payment: string, amount: number): Promise<Outcome>;
  /** The payment, or null when no payment has that id. */
  payment(payment: string): Promise<PaymentView | null>;
}

/** The module's default export: a factory of a fresh system, with no payments. */
export type CreateHost = () => Promise<Host>;
