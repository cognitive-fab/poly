import { createHmac, timingSafeEqual } from "node:crypto";

export interface InboundMessage {
  id: string;
  from: string;
  type: string;
  text?: string;
}

/** Verifies the X-Hub-Signature-256 header Meta attaches to webhook POSTs. */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Extracts customer messages from a Cloud API webhook payload. Status updates etc. are ignored. */
export function parseWebhook(payload: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  if (payload?.object !== "whatsapp_business_account") return out;
  for (const entry of payload.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "messages") continue;
      for (const m of change.value?.messages ?? []) {
        if (typeof m?.id !== "string" || typeof m?.from !== "string") continue;
        out.push({
          id: m.id,
          from: m.from,
          type: String(m.type),
          text: m.type === "text" && typeof m.text?.body === "string" ? m.text.body : undefined,
        });
      }
    }
  }
  return out;
}

export interface WhatsAppClientOptions {
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class WhatsAppClient {
  private readonly opts: WhatsAppClientOptions;
  private readonly fetch: typeof fetch;

  constructor(opts: WhatsAppClientOptions) {
    this.opts = opts;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async sendText(to: string, body: string): Promise<void> {
    const { baseUrl = "https://graph.facebook.com", apiVersion = "v21.0", phoneNumberId, accessToken } = this.opts;
    const res = await this.fetch(`${baseUrl}/${apiVersion}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`WhatsApp send failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  }
}
