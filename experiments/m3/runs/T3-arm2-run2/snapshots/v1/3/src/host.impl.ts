import type { CreateHost, Effect, Host, Outcome, PaymentView } from '../host.ts';

type Status = PaymentView['status'];

interface Payment {
  status: Status;
  authorized: number;
  captured: number;
  refunded: number;
  requests: number;
}

/** One step of the system, observed by a tracer (used to capture polygraph traces). */
export interface Step {
  payment: string;
  action: string;
  data: Record<string, unknown>;
  pre: { payment: PaymentView | null; pending: number };
  post: { payment: PaymentView | null; pending: number };
  outcome: Outcome;
}

export type Tracer = (step: Step) => void;

const MAX_REQUESTS = 3;

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });
const isUnit = (amount: number): boolean => amount === 1 || amount === 2;
const MAX_AUTHORIZED = 3;
const isCaptureAmount = (amount: number): boolean => Number.isInteger(amount) && amount >= 1 && amount <= MAX_AUTHORIZED;

export function createSystem(tracer?: Tracer): Host {
  const payments = new Map<string, Payment>();
  const pending = new Map<string, Effect>();
  let nextEffect = 1;

  const view = (id: string): PaymentView | null => {
    const p = payments.get(id);
    return p ? { ...p } : null;
  };
  const pendingFor = (id: string): number => {
    let n = 0;
    for (const e of pending.values()) if (e.from === id) n++;
    return n;
  };
  const snapshot = (id: string) => ({ payment: view(id), pending: pendingFor(id) });

  const requestAuthorization = (id: string, p: Payment): void => {
    const effectId = `e${nextEffect++}`;
    pending.set(effectId, { id: effectId, from: id, kind: 'card.authorize', data: { amount: p.authorized } });
    p.requests += 1;
  };

  /** Runs one command on one payment, tracing its pre and post state. */
  const step = (id: string, action: string, data: Record<string, unknown>, body: () => Outcome): Outcome => {
    const pre = tracer ? snapshot(id) : undefined;
    const outcome = body();
    if (tracer && pre) tracer({ payment: id, action, data, pre, post: snapshot(id), outcome });
    return outcome;
  };

  const withPayment = (id: string, body: (p: Payment) => Outcome): Outcome => {
    const p = payments.get(id);
    if (!p) return refuse('unknown payment');
    return body(p);
  };

  return {
    async authorize(payment, amount) {
      return step(payment, 'authorize', { amount }, () => {
        if (!isUnit(amount)) return refuse('amount must be 1 or 2');
        if (payments.has(payment)) return refuse('payment already exists');
        const p: Payment = { status: 'authorizing', authorized: amount, captured: 0, refunded: 0, requests: 0 };
        payments.set(payment, p);
        requestAuthorization(payment, p);
        return ok;
      });
    },

    async timedOut(payment) {
      return step(payment, 'timedOut', {}, () =>
        withPayment(payment, (p) => {
          if (p.status !== 'authorizing') return refuse('payment is not authorizing');
          if (p.requests >= MAX_REQUESTS) p.status = 'failed';
          else requestAuthorization(payment, p);
          return ok;
        }),
      );
    },

    async capture(payment, amount) {
      return step(payment, 'capture', { amount }, () =>
        withPayment(payment, (p) => {
          if (p.status !== 'authorized') return refuse('payment is not authorized');
          if (!isCaptureAmount(amount)) return refuse('amount must be 1 to 3');
          if (amount > p.authorized) return refuse('amount exceeds the authorised amount');
          p.captured = amount;
          p.status = 'captured';
          return ok;
        }),
      );
    },

    async void(payment) {
      return step(payment, 'void', {}, () =>
        withPayment(payment, (p) => {
          if (p.status !== 'authorized') return refuse('payment is not authorized');
          p.status = 'voided';
          return ok;
        }),
      );
    },

    async increase(payment) {
      return step(payment, 'increase', {}, () =>
        withPayment(payment, (p) => {
          if (p.status !== 'authorized') return refuse('payment is not authorized');
          if (p.authorized >= MAX_AUTHORIZED) return refuse('authorised amount is already at most');
          p.authorized += 1;
          return ok;
        }),
      );
    },

    async refund(payment, amount) {
      return step(payment, 'refund', { amount }, () =>
        withPayment(payment, (p) => {
          if (p.status !== 'captured') return refuse('payment is not captured');
          if (!isUnit(amount)) return refuse('amount must be 1 or 2');
          if (p.refunded + amount > p.captured) return refuse('refund exceeds the captured amount');
          p.refunded += amount;
          if (p.refunded === p.captured) p.status = 'refunded';
          return ok;
        }),
      );
    },

    async payment(payment) {
      return view(payment);
    },

    async pendingEffects() {
      return [...pending.values()].map((e) => ({ ...e, data: { ...e.data } }));
    },

    async completeEffect(id, outcome) {
      const effect = pending.get(id);
      if (!effect) return;
      step(effect.from, 'complete', { outcome }, () => {
        pending.delete(id);
        const p = payments.get(effect.from);
        if (p && p.status === 'authorizing') p.status = outcome === 'ok' ? 'authorized' : 'declined';
        return ok;
      });
    },
  };
}

const createHost: CreateHost = async () => createSystem();

export default createHost;
