import type { CreateHost, Effect, Host, OrderView, Outcome } from '../host.ts';
import { INITIAL, step } from './order.ts';
import type { Action, OrderState } from './order.ts';

/** A step listener: the capture seam, called once per command or completion with pre/post. */
export type StepListener = (w: { order: string; pre: OrderState; action: Action; post: OrderState; ok: boolean }) => void;

export function makeHost(listener?: StepListener): Host {
  const orders = new Map<string, OrderState>();
  const pending = new Map<string, Effect>();
  let nextEffectId = 1;

  const apply = (order: string, action: Action): Outcome => {
    const pre = orders.get(order) ?? INITIAL;
    const r = step(pre, action);
    if (!r.ok) {
      listener?.({ order, pre, action, post: pre, ok: false });
      return { ok: false, reason: r.reason };
    }
    orders.set(order, r.next);
    // Only the charge awaits an answer; a refund is counted and needs none.
    if (r.effect && r.effect.kind === 'payment.charge') {
      const id = `e${nextEffectId++}`;
      pending.set(id, { id, from: order, kind: r.effect.kind, data: { ...r.effect.data } });
    }
    listener?.({ order, pre, action, post: r.next, ok: true });
    return { ok: true };
  };

  return {
    create: async (order) => apply(order, 'create'),
    addItem: async (order) => apply(order, 'addItem'),
    removeItem: async (order) => apply(order, 'removeItem'),
    place: async (order) => apply(order, 'place'),
    ship: async (order) => apply(order, 'ship'),
    cancel: async (order) => apply(order, 'cancel'),
    order: async (order): Promise<OrderView | null> => {
      const s = orders.get(order);
      if (!s || s.status === 'none') return null;
      return { status: s.status, items: s.items, charges: s.charges, refunds: s.refunds };
    },
    pendingEffects: async () => [...pending.values()].map((e) => ({ ...e, data: { ...e.data } })),
    completeEffect: async (id, outcome) => {
      const e = pending.get(id);
      if (!e) return;
      pending.delete(id);
      apply(e.from, outcome === 'ok' ? 'chargeOk' : 'chargeFailed');
    },
  };
}

const createHost: CreateHost = async () => makeHost();
export default createHost;
