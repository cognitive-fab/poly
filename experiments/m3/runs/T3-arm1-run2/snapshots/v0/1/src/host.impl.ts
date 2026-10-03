import type { CreateHost, Effect, Host, Outcome, PaymentView } from '../host.ts';

type Status = PaymentView['status'];

interface Payment {
  status: Status;
  authorized: number;
  captured: number;
  refunded: number;
  requests: number;
}

const MAX_REQUESTS = 3;

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });
const validAmount = (amount: unknown): amount is number => amount === 1 || amount === 2;

const createHost: CreateHost = async () => {
  const payments = new Map<string, Payment>();
  const pending = new Map<string, Effect>();
  let nextEffect = 1;

  const request = (id: string, p: Payment): void => {
    p.requests += 1;
    const effectId = `e${nextEffect++}`;
    pending.set(effectId, { id: effectId, from: id, kind: 'card.authorize', data: { amount: p.authorized } });
  };

  const host: Host = {
    async authorize(payment, amount) {
      if (typeof payment !== 'string') return refuse('invalid payment id');
      if (!validAmount(amount)) return refuse('amount must be 1 or 2');
      if (payments.has(payment)) return refuse('payment already exists');
      const p: Payment = { status: 'authorizing', authorized: amount, captured: 0, refunded: 0, requests: 0 };
      payments.set(payment, p);
      request(payment, p);
      return ok();
    },

    async timedOut(payment) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorizing') return refuse('payment is not authorizing');
      if (p.requests >= MAX_REQUESTS) p.status = 'failed';
      else request(payment, p);
      return ok();
    },

    async capture(payment, amount) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorized') return refuse('payment is not authorized');
      if (!validAmount(amount)) return refuse('amount must be 1 or 2');
      if (amount > p.authorized) return refuse('amount exceeds authorized amount');
      p.captured = amount;
      p.status = 'captured';
      return ok();
    },

    async void(payment) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorized' || p.captured !== 0) return refuse('payment is not authorized and uncaptured');
      p.status = 'voided';
      return ok();
    },

    async refund(payment, amount) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'captured') return refuse('payment is not captured');
      if (!validAmount(amount)) return refuse('amount must be 1 or 2');
      if (p.refunded + amount > p.captured) return refuse('refund exceeds captured amount');
      p.refunded += amount;
      if (p.refunded === p.captured) p.status = 'refunded';
      return ok();
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
      if (outcome === 'ok') p.status = 'authorized';
      else if (outcome === 'failed') p.status = 'declined';
    },
  };
  return host;
};

export default createHost;
