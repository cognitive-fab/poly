export interface RefundRequest {
  charge: string;
  amount: number;
  idempotencyKey: string;
  metadata: Record<string, string>;
}

export type RefundResult =
  | { kind: "ok"; id: string; status: string }
  /** Stripe rejected the request; nothing was refunded. */
  | { kind: "rejected"; message: string }
  /** Network error or 5xx: the refund may or may not exist. Retry with the same key. */
  | { kind: "uncertain"; message: string };

export interface RefundGateway {
  createRefund(req: RefundRequest): Promise<RefundResult>;
}

export class StripeClient implements RefundGateway {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly attempts: number;

  constructor(secretKey: string, baseUrl = "https://api.stripe.com", attempts = 3) {
    this.secretKey = secretKey;
    this.baseUrl = baseUrl;
    this.attempts = attempts;
  }

  async createRefund(req: RefundRequest): Promise<RefundResult> {
    const body = new URLSearchParams({ charge: req.charge, amount: String(req.amount) });
    for (const [k, v] of Object.entries(req.metadata)) body.set(`metadata[${k}]`, v);

    let last: RefundResult = { kind: "uncertain", message: "not attempted" };
    for (let i = 0; i < this.attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** i));
      last = await this.once(body, req.idempotencyKey);
      if (last.kind !== "uncertain") return last;
    }
    return last;
  }

  private async once(body: URLSearchParams, idempotencyKey: string): Promise<RefundResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/refunds`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      return { kind: "uncertain", message: String(err) };
    }
    const json = (await res.json().catch(() => ({}))) as any;
    // 409 = idempotent request still in progress / conflict; 429 = rate limited. Both are retryable.
    if (res.status >= 500 || res.status === 409 || res.status === 429) {
      return { kind: "uncertain", message: `HTTP ${res.status}: ${json?.error?.message ?? ""}` };
    }
    if (!res.ok) return { kind: "rejected", message: json?.error?.message ?? `HTTP ${res.status}` };
    return { kind: "ok", id: String(json.id), status: String(json.status) };
  }
}
