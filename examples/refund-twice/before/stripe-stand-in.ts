// A Stripe that records each refund it creates, in memory. It honours idempotency keys as Stripe does: a key it has seen
// returns the refund it made for that key and records no new call; a new key makes a new refund. Nothing here reaches the
// network (S588).

export type RefundCall = { charge: string; amount: number; idempotencyKey: string; id: string };
export type Refund = { id: string; amount: number; status: 'succeeded' };

export type StandInStripe = {
  calls: RefundCall[];
  refunds: { create(params: { charge: string; amount: number }, options: { idempotencyKey: string }): Promise<Refund> };
};

export function standInStripe(): StandInStripe {
  const calls: RefundCall[] = [];
  const byKey = new Map<string, Refund>();
  return {
    calls,
    refunds: {
      async create(params, options) {
        const seen = byKey.get(options.idempotencyKey);
        if (seen) return seen;
        const refund: Refund = { id: `re_${calls.length + 1}`, amount: params.amount, status: 'succeeded' };
        calls.push({ charge: params.charge, amount: params.amount, idempotencyKey: options.idempotencyKey, id: refund.id });
        byKey.set(options.idempotencyKey, refund);
        return refund;
      },
    },
  };
}
