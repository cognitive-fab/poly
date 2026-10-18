export interface RefundRequest {
  charge: string;
  amount: number;
  idempotencyKey: string;
  metadata: Record<string, string>;
}

export interface StripeRefund {
  id: string;
  status: string; // succeeded | pending | requires_action | failed | canceled
  amount: number;
}

/** Thrown for Stripe API errors. `transient` means retrying with the same idempotency key is safe and may succeed. */
export class StripeError extends Error {
  readonly transient: boolean;
  readonly code: string | undefined;
  constructor(message: string, transient: boolean, code?: string) {
    super(message);
    this.name = "StripeError";
    this.transient = transient;
    this.code = code;
  }
}

export interface StripeClientOptions {
  secretKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class StripeClient {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(opts: StripeClientOptions) {
    this.secretKey = opts.secretKey;
    this.baseUrl = opts.baseUrl ?? "https://api.stripe.com";
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async createRefund(req: RefundRequest): Promise<StripeRefund> {
    const body = new URLSearchParams({
      charge: req.charge,
      amount: String(req.amount),
      reason: "requested_by_customer",
    });
    for (const [k, v] of Object.entries(req.metadata)) body.set(`metadata[${k}]`, v);

    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}/v1/refunds`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": req.idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new StripeError(`Stripe request failed: ${(err as Error).message}`, true);
    }

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const transient = res.status === 429 || res.status >= 500;
      throw new StripeError(
        `Stripe ${res.status}: ${data?.error?.message ?? "unknown error"}`,
        transient,
        data?.error?.code,
      );
    }
    if (typeof data?.id !== "string" || typeof data?.status !== "string") {
      throw new StripeError("Unexpected Stripe response", true);
    }
    return { id: data.id, status: data.status, amount: data.amount };
  }
}
