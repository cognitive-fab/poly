import type { CreateHost, Effect, Host, Outcome, PaymentView } from '../host.ts';

const MAX_REQUESTS = 3;
const MAX_AUTHORIZED = 3;

type Status = PaymentView['status'];

interface Payment {
  status: Status;
  authorized: number;
  captured: number;
  refunded: number;
  requests: number;
}

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });
const isUnit = (amount: unknown): amount is number => amount === 1 || amount === 2;

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
    async authorize(id, amount) {
      if (!isUnit(amount)) return refuse('amount must be 1 or 2');
      if (payments.has(id)) return refuse('payment already exists');
      const p: Payment = { status: 'authorizing', authorized: amount, captured: 0, refunded: 0, requests: 0 };
      payments.set(id, p);
      request(id, p);
      return ok();
    },

    async timedOut(id) {
      const p = payments.get(id);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorizing') return refuse('payment is not authorizing');
      if (p.requests >= MAX_REQUESTS) p.status = 'failed';
      else request(id, p);
      return ok();
    },

    async capture(id, amount) {
      const p = payments.get(id);
      if (!p) return refuse('unknown payment');
      if (amount !== 1 && amount !== 2 && amount !== 3) return refuse('amount must be 1 to 3');
      if (p.status !== 'authorized') return refuse('payment is not authorized');
      if (amount > p.authorized) return refuse('amount exceeds authorised amount');
      p.captured = amount;
      p.status = 'captured';
      return ok();
    },

    async void(id) {
      const p = payments.get(id);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorized') return refuse('payment is not authorized');
      p.status = 'voided';
      return ok();
    },

    async increase(id) {
      const p = payments.get(id);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorized') return refuse('payment is not authorized');
      if (p.authorized >= MAX_AUTHORIZED) return refuse('authorised amount is at its maximum');
      p.authorized += 1;
      return ok();
    },

    async expire(id) {
      const p = payments.get(id);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorized') return refuse('payment is not authorized');
      p.status = 'expired';
      return ok();
    },

    async refund(id, amount) {
      const p = payments.get(id);
      if (!p) return refuse('unknown payment');
      if (!isUnit(amount)) return refuse('amount must be 1 or 2');
      if (p.status !== 'captured') return refuse('payment is not captured');
      if (p.refunded + amount > p.captured) return refuse('refund exceeds captured amount');
      p.refunded += amount;
      if (p.refunded === p.captured) p.status = 'refunded';
      return ok();
    },

    async payment(id) {
      const p = payments.get(id);
      return p ? { ...p } : null;
    },

    async pendingEffects() {
      return [...pending.values()].map((e) => ({ ...e, data: { ...e.data } }));
    },

    async completeEffect(effectId, outcome) {
      const e = pending.get(effectId);
      if (!e) return;
      pending.delete(effectId);
      const p = payments.get(e.from);
      if (!p || p.status !== 'authorizing') return;
      p.status = outcome === 'ok' ? 'authorized' : 'declined';
    },
  };
  return host;
};

export default createHost;
