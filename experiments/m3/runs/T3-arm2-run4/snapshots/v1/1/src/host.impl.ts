import type { CreateHost, Effect, Host, Outcome, PaymentView } from '../host.ts';

/** How many authorisation requests a payment may send to the provider. */
const MAX_REQUESTS = 3;
/** The most an authorisation can be raised to. */
const MAX_AUTHORIZED = 3;

interface Payment {
  status: PaymentView['status'];
  authorized: number;
  captured: number;
  refunded: number;
  requests: number;
}

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });
const isUnit = (amount: unknown): amount is number => amount === 1 || amount === 2;
const isCaptureAmount = (amount: unknown): amount is number => amount === 1 || amount === 2 || amount === 3;

const createHost: CreateHost = async () => {
  const payments = new Map<string, Payment>();
  const pending = new Map<string, Effect>();
  let nextEffect = 1;

  const requestAuthorization = (id: string, p: Payment): void => {
    p.requests += 1;
    const effectId = `eff-${nextEffect++}`;
    pending.set(effectId, { id: effectId, from: id, kind: 'card.authorize', data: { amount: p.authorized } });
  };

  const host: Host = {
    async authorize(payment, amount) {
      if (!isUnit(amount)) return refuse('amount must be 1 or 2');
      if (payments.has(payment)) return refuse('payment already exists');
      const p: Payment = { status: 'authorizing', authorized: amount, captured: 0, refunded: 0, requests: 0 };
      payments.set(payment, p);
      requestAuthorization(payment, p);
      return ok();
    },

    async timedOut(payment) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorizing') return refuse(`payment is ${p.status}, not authorizing`);
      if (p.requests >= MAX_REQUESTS) p.status = 'failed';
      else requestAuthorization(payment, p);
      return ok();
    },

    async capture(payment, amount) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (!isCaptureAmount(amount)) return refuse('amount must be 1 to 3');
      if (p.status !== 'authorized') return refuse(`payment is ${p.status}, not authorized`);
      if (amount > p.authorized) return refuse('amount exceeds the amount authorised');
      p.captured = amount;
      p.status = 'captured';
      return ok();
    },

    async void(payment) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorized') return refuse(`payment is ${p.status}, not authorized`);
      p.status = 'voided';
      return ok();
    },

    async increase(payment) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (p.status !== 'authorized') return refuse(`payment is ${p.status}, not authorized`);
      if (p.authorized >= MAX_AUTHORIZED) return refuse(`authorised amount is already ${MAX_AUTHORIZED}`);
      p.authorized += 1;
      return ok();
    },

    async refund(payment, amount) {
      const p = payments.get(payment);
      if (!p) return refuse('unknown payment');
      if (!isUnit(amount)) return refuse('amount must be 1 or 2');
      if (p.status !== 'captured') return refuse(`payment is ${p.status}, not captured`);
      if (p.refunded + amount > p.captured) return refuse('refund exceeds the amount captured');
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
      if (!effect) return;
      pending.delete(id);
      const p = payments.get(effect.from);
      // The first answer decides: a payment no longer authorizing ignores later ones.
      if (!p || p.status !== 'authorizing') return;
      p.status = outcome === 'ok' ? 'authorized' : 'declined';
    },
  };
  return host;
};

export default createHost;
