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
const MAX_AUTHORIZED = 3;
const isUnit = (amount: unknown): amount is number => amount === 1 || amount === 2;
const isCaptureAmount = (amount: unknown): amount is number => amount === 1 || amount === 2 || amount === 3;

const createHost: CreateHost = async () => {
  const payments = new Map<string, Payment>();
  const pending = new Map<string, Effect>();
  let nextEffect = 0;

  const requestAuthorization = (id: string, p: Payment): void => {
    nextEffect += 1;
    const effectId = `eff-${nextEffect}`;
    pending.set(effectId, { id: effectId, from: id, kind: 'card.authorize', data: { amount: p.authorized } });
    p.requests += 1;
  };

  const host: Host = {
    async authorize(payment, amount) {
      if (typeof payment !== 'string') return refuse('invalid-payment-id');
      if (!isUnit(amount)) return refuse('invalid-amount');
      if (payments.has(payment)) return refuse('payment-exists');
      const p: Payment = { status: 'authorizing', authorized: amount, captured: 0, refunded: 0, requests: 0 };
      payments.set(payment, p);
      requestAuthorization(payment, p);
      return ok();
    },

    async timedOut(payment) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown-payment');
      if (p.status !== 'authorizing') return refuse('not-authorizing');
      if (p.requests >= MAX_REQUESTS) p.status = 'failed';
      else requestAuthorization(payment, p);
      return ok();
    },

    async capture(payment, amount) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown-payment');
      if (!isCaptureAmount(amount)) return refuse('invalid-amount');
      // A captured payment takes further parts until anything is refunded.
      if (p.status === 'captured' && p.refunded !== 0) return refuse('already-refunded');
      if (p.status !== 'authorized' && p.status !== 'captured') return refuse('not-capturable');
      if (p.captured + amount > p.authorized) return refuse('exceeds-authorized');
      p.captured += amount;
      p.status = 'captured';
      return ok();
    },

    async void(payment) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown-payment');
      if (p.status !== 'authorized' || p.captured !== 0) return refuse('not-voidable');
      p.status = 'voided';
      return ok();
    },

    async increase(payment) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown-payment');
      if (p.status !== 'authorized' || p.captured !== 0) return refuse('not-increasable');
      if (p.authorized >= MAX_AUTHORIZED) return refuse('at-max-authorized');
      p.authorized += 1;
      return ok();
    },

    async expire(payment) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown-payment');
      if (p.status !== 'authorized' || p.captured !== 0) return refuse('not-expirable');
      p.status = 'expired';
      return ok();
    },

    async refund(payment, amount) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown-payment');
      if (!isUnit(amount)) return refuse('invalid-amount');
      if (p.status !== 'captured') return refuse('not-captured');
      if (p.refunded + amount > p.captured) return refuse('exceeds-captured');
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
      const effect = pending.get(id);
      if (!effect || (outcome !== 'ok' && outcome !== 'failed')) return;
      pending.delete(id);
      const p = payments.get(effect.from);
      if (!p || p.status !== 'authorizing') return;
      p.status = outcome === 'ok' ? 'authorized' : 'declined';
    },
  };
  return host;
};

export default createHost;
