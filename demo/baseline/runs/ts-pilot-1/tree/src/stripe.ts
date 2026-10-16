export interface Refund {
  id: string;
  status: string;
  amount: number;
}

export interface RefundRequest {
  charge: string;
  amount: number;
  idempotencyKey: string;
  metadata?: Record<string, string>;
}

export interface StripeClient {
  createRefund(req: RefundRequest): Promise<Refund>;
}

export class StripeError extends Error {
  status: number;
  code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.code = code;
  }
}

export function createStripeClient(opts: {
  secretKey: string;
  fetch?: typeof fetch;
  apiBase?: string;
}): StripeClient {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.apiBase ?? 'https://api.stripe.com';

  return {
    async createRefund(req) {
      const form = new URLSearchParams({ charge: req.charge, amount: String(req.amount) });
      for (const [k, v] of Object.entries(req.metadata ?? {})) form.set(`metadata[${k}]`, v);

      const res = await doFetch(`${base}/v1/refunds`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': req.idempotencyKey,
        },
        body: form.toString(),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new StripeError(body?.error?.message ?? `Stripe HTTP ${res.status}`, res.status, body?.error?.code);
      }
      return { id: body.id, status: body.status, amount: body.amount };
    },
  };
}
