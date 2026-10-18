import { createHmac, timingSafeEqual } from "node:crypto";

export interface IncomingMessage {
  id: string;
  from: string;
  text: string | null; // null for non-text messages (images, stickers, ...)
}

export interface MessageSender {
  sendText(to: string, body: string): Promise<void>;
}

/** Verifies Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the app secret). */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Extracts customer messages from a Cloud API webhook payload; ignores status updates etc. */
export function parseWebhook(payload: any): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  if (payload?.object !== "whatsapp_business_account") return out;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      for (const m of change.value?.messages ?? []) {
        if (typeof m?.id !== "string" || typeof m?.from !== "string") continue;
        out.push({ id: m.id, from: m.from, text: m.type === "text" ? String(m.text?.body ?? "") : null });
      }
    }
  }
  return out;
}

export class WhatsAppClient implements MessageSender {
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly baseUrl: string;

  constructor(accessToken: string, phoneNumberId: string, baseUrl = "https://graph.facebook.com/v23.0") {
    this.accessToken = accessToken;
    this.phoneNumberId = phoneNumberId;
    this.baseUrl = baseUrl;
  }

  async sendText(to: string, body: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`WhatsApp send failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
}
