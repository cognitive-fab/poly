import type { CreateHost, Effect, Host, Outcome, PaymentView } from './types.ts';

const MAX_REQUESTS = 3;

type Status = PaymentView['status'];

interface Payment {
  status: Status;
  authorized: number;
  captured: number;
  refunded: number;
  requests: number;
}

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const isUnits = (amount: number): boolean => amount === 1 || amount === 2;

const createHost: CreateHost = async () => {
  const payments = new Map<string, Payment>();
  const pending = new Map<string, Effect>();
  let nextEffect = 1;

  const requestAuthorization = (id: string, p: Payment): void => {
    const effectId = `e${nextEffect++}`;
    pending.set(effectId, { id: effectId, from: id, kind: 'card.authorize', data: { amount: p.authorized } });
    p.requests += 1;
  };

  const host: Host = {
    async authorize(payment, amount) {
      if (!isUnits(amount)) return refuse('amount must be 1 or 2');
      if (payments.has(payment)) return refuse('payment already exists');
      const p: Payment = { status: 'authorizing', authorized: amount, captured: 0, refunded: 0, requests: 0 };
      payments.set(payment, p);
      requestAuthorization(payment, p);
      return ok;
    },

    async timedOut(payment) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorizing') return refuse('payment is not authorizing');
      if (p.requests >= MAX_REQUESTS) p.status = 'failed';
      else requestAuthorization(payment, p);
      return ok;
    },

    async capture(payment, amount) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorized') return refuse('payment is not authorized');
      if (!isUnits(amount)) return refuse('amount must be 1 or 2');
      if (amount > p.authorized) return refuse('amount exceeds the amount authorised');
      p.captured = amount;
      p.status = 'captured';
      return ok;
    },

    async void(payment) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorized' || p.captured > 0) return refuse('payment is not authorized and uncaptured');
      p.status = 'voided';
      return ok;
    },

    async refund(payment, amount) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'captured') return refuse('payment is not captured');
      if (!isUnits(amount)) return refuse('amount must be 1 or 2');
      if (p.refunded + amount > p.captured) return refuse('refund exceeds the amount captured');
      p.refunded += amount;
      if (p.refunded === p.captured) p.status = 'refunded';
      return ok;
    },

    async payment(payment) {
      const p = payments.get(payment);
      if (!p) return null;
      return { status: p.status, authorized: p.authorized, captured: p.captured, refunded: p.refunded, requests: p.requests };
    },

    async pendingEffects() {
      return [...pending.values()].map((e) => ({ ...e, data: { ...e.data } }));
    },

    async completeEffect(id, outcome) {
      const effect = pending.get(id);
      if (!effect) return;
      pending.delete(id);
      const p = payments.get(effect.from);
      if (!p || p.status !== 'authorizing') return;
      p.status = outcome === 'ok' ? 'authorized' : 'declined';
    },
  };

  return host;
};

export default createHost;
