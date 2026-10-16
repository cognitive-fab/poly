import { createHmac, timingSafeEqual } from 'node:crypto';

export interface InboundMessage {
  id: string;
  from: string;
  type: string;
  text?: string;
}

export interface WhatsAppClient {
  sendText(to: string, body: string): Promise<void>;
}

/** Checks Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the app secret). */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function arr(x: unknown): any[] {
  return Array.isArray(x) ? x : [];
}

/** Pulls customer messages out of a Cloud API webhook payload; status updates are ignored. */
export function extractMessages(payload: unknown): InboundMessage[] {
  const p = payload as any;
  const out: InboundMessage[] = [];
  if (p?.object !== 'whatsapp_business_account') return out;
  for (const entry of arr(p.entry)) {
    for (const change of arr(entry?.changes)) {
      for (const m of arr(change?.value?.messages)) {
        if (typeof m?.id !== 'string' || typeof m?.from !== 'string') continue;
        const text = m.type === 'text' && typeof m.text?.body === 'string' ? m.text.body : undefined;
        out.push({ id: m.id, from: m.from, type: String(m.type), text });
      }
    }
  }
  return out;
}

export function createWhatsAppClient(opts: {
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
  fetch?: typeof fetch;
  apiBase?: string;
}): WhatsAppClient {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.apiBase ?? 'https://graph.facebook.com';
  const version = opts.apiVersion ?? 'v21.0';

  return {
    async sendText(to, body) {
      const res = await doFetch(`${base}/${version}/${opts.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
      });
      if (!res.ok) {
        throw new Error(`WhatsApp send failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
      }
    },
  };
}
