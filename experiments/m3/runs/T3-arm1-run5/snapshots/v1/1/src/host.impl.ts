// T3, card payments: implementation of the host interface in ../host.ts.

type Outcome = { ok: true } | { ok: false; reason: string };

interface Effect {
  id: string;
  from: string;
  kind: string;
  data: Record<string, unknown>;
}

type Status = 'authorizing' | 'authorized' | 'declined' | 'failed' | 'captured' | 'voided' | 'refunded';

interface PaymentView {
  status: Status;
  authorized: number;
  captured: number;
  refunded: number;
  requests: number;
}

interface Host {
  authorize(payment: string, amount: number): Promise<Outcome>;
  timedOut(payment: string): Promise<Outcome>;
  capture(payment: string, amount: number): Promise<Outcome>;
  void(payment: string): Promise<Outcome>;
  refund(payment: string, amount: number): Promise<Outcome>;
  payment(payment: string): Promise<PaymentView | null>;
  pendingEffects(): Promise<Effect[]>;
  completeEffect(id: string, outcome: 'ok' | 'failed'): Promise<void>;
}

const MAX_REQUESTS = 3;

const OK: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });
const validAmount = (amount: unknown): boolean => amount === 1 || amount === 2;

export default async function createHost(): Promise<Host> {
  const payments = new Map<string, PaymentView>();
  const pending = new Map<string, Effect>();
  let nextEffect = 1;

  const request = (payment: string, p: PaymentView): void => {
    const id = `e${nextEffect++}`;
    pending.set(id, { id, from: payment, kind: 'card.authorize', data: { amount: p.authorized } });
    p.requests += 1;
  };

  return {
    async authorize(payment, amount) {
      if (!validAmount(amount)) return refuse('amount must be 1 or 2');
      if (payments.has(payment)) return refuse('payment already exists');
      const p: PaymentView = { status: 'authorizing', authorized: amount, captured: 0, refunded: 0, requests: 0 };
      payments.set(payment, p);
      request(payment, p);
      return OK;
    },

    async timedOut(payment) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorizing') return refuse('payment is not authorizing');
      if (p.requests >= MAX_REQUESTS) p.status = 'failed';
      else request(payment, p);
      return OK;
    },

    async capture(payment, amount) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorized') return refuse('payment is not authorized');
      if (amount !== 1 && amount !== 2 && amount !== 3) return refuse('amount must be 1 to 3');
      if (amount > p.authorized) return refuse('amount exceeds the amount authorized');
      p.captured = amount;
      p.status = 'captured';
      return OK;
    },

    async void(payment) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorized') return refuse('payment is not authorized');
      p.status = 'voided';
      return OK;
    },

    async refund(payment, amount) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'captured') return refuse('payment is not captured');
      if (!validAmount(amount)) return refuse('amount must be 1 or 2');
      if (p.refunded + amount > p.captured) return refuse('refund exceeds the amount captured');
      p.refunded += amount;
      if (p.refunded === p.captured) p.status = 'refunded';
      return OK;
    },

    async payment(payment) {
      const p = payments.get(payment);
      return p ? { ...p } : null;
    },

    async pendingEffects() {
      return [...pending.values()].map((e) => ({ ...e, data: { ...e.data } }));
    },

    async completeEffect(id, outcome) {
      const e = pending.get(id);
      if (!e) return;
      pending.delete(id);
      const p = payments.get(e.from);
      if (!p || p.status !== 'authorizing') return;
      p.status = outcome === 'ok' ? 'authorized' : 'declined';
    },
  };
}
