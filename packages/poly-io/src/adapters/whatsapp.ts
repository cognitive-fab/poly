// The WhatsApp Cloud API adapter (S183), from Meta's webhook and messages documentation read on 2026-10-05
// (packages/poly-io/PROVENANCE.md). A webhook is signed with HMAC-SHA256 of the raw body under the app secret, in
// X-Hub-Signature-256 as sha256=<hex>; the endpoint's verification is a GET answered with hub.challenge when
// hub.verify_token matches. Messages arrive in entry[].changes[].value.messages, receipts in .statuses.
import type { ChannelAdapter, InboundMessage, ProviderReceipt, Refusal, SendResult, Verified } from '@poly/runtime/adapters';
import { hmac, httpFailure, json, noAnswer, sameText } from '../util.js';

export interface WhatsAppConfig {
  appSecret: string;
  accessToken: string;
  phoneNumberId: string;
  verifyToken: string;
  /** The Graph API version, as Meta names it (v23.0, say). */
  apiVersion: string;
}

const STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

interface WaMessage { from?: unknown; id?: unknown; type?: unknown; text?: { body?: unknown } }
interface WaStatus { id?: unknown; status?: unknown; errors?: { code?: unknown; title?: unknown }[] }

export function whatsapp(c: WhatsAppConfig): ChannelAdapter {
  return {
    kind: 'whatsapp',
    provider: 'whatsapp-cloud-api',
    verify(w): Verified | Refusal {
      const url = new URL(w.url);
      if (w.method === 'GET') {
        if (url.searchParams.get('hub.mode') !== 'subscribe') return { refused: 'not-a-verification-request' };
        if (!sameText(url.searchParams.get('hub.verify_token') ?? '', c.verifyToken)) return { refused: 'verify-token-invalid' };
        return { messages: [], receipts: [], answer: { status: 200, contentType: 'text/plain', body: url.searchParams.get('hub.challenge') ?? '' } };
      }
      const sig = w.headers['x-hub-signature-256'];
      if (!sig) return { refused: 'signature-missing' };
      if (!sameText(sig, `sha256=${hmac('sha256', c.appSecret, w.body).toString('hex')}`)) return { refused: 'signature-invalid' };
      const doc = json(w.body) as { object?: unknown; entry?: { changes?: { value?: { messages?: WaMessage[]; statuses?: WaStatus[] } }[] }[] };
      if (doc.object !== 'whatsapp_business_account') return { refused: 'not-a-whatsapp-notification' };
      const messages: InboundMessage[] = [];
      const receipts: ProviderReceipt[] = [];
      for (const e of doc.entry ?? []) for (const ch of e.changes ?? []) {
        for (const m of ch.value?.messages ?? []) {
          if (typeof m.from !== 'string' || typeof m.id !== 'string') return { refused: 'message-malformed' };
          // A text message's body is its text; any other type's is its own object, kept whole.
          const body = m.type === 'text' && typeof m.text?.body === 'string' ? m.text.body : JSON.stringify((m as Record<string, unknown>)[String(m.type)] ?? {});
          // WhatsApp authenticates the sender's number (wa_id), so the claim is verified (K11).
          messages.push({ providerMessageId: m.id, fields: { from: m.from }, body, claims: { verified: true, sender: m.from } });
        }
        for (const s of ch.value?.statuses ?? []) {
          if (typeof s.id !== 'string' || typeof s.status !== 'string' || !STATUSES.has(s.status)) continue;
          const err = s.errors?.[0];
          receipts.push({ providerId: s.id, status: s.status as ProviderReceipt['status'], ...(err ? { error: `${err.code ?? ''} ${err.title ?? ''}`.trim() } : {}) });
        }
      }
      return { messages, receipts };
    },
    async send(out, t): Promise<SendResult> {
      if (!t.http) return { ok: false, permanent: true, error: 'no http transport' };
      let payload: Record<string, unknown>;
      if (out.kind === 'Templated') {
        // A template's body names the approved template and its values: { name, language, components? }.
        let tpl: { name?: unknown; language?: unknown; components?: unknown };
        try { tpl = JSON.parse(out.body) as typeof tpl; } catch { return { ok: false, permanent: true, error: 'a template body is JSON: { name, language, components }' }; }
        if (typeof tpl.name !== 'string' || typeof tpl.language !== 'string') return { ok: false, permanent: true, error: 'a template body names its template and language' };
        payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: out.to, type: 'template', template: { name: tpl.name, language: { code: tpl.language }, ...(tpl.components ? { components: tpl.components } : {}) } };
      } else {
        payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: out.to, type: 'text', text: { body: out.body } };
      }
      let r;
      try {
        r = await t.http.request({ method: 'POST', url: `https://graph.facebook.com/${c.apiVersion}/${c.phoneNumberId}/messages`, headers: { authorization: `Bearer ${c.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      } catch (e) { return noAnswer(e); }
      let doc: { messages?: { id?: unknown }[]; error?: { code?: unknown; message?: unknown } } = {};
      try { doc = JSON.parse(r.body) as typeof doc; } catch { /* an answer that is not JSON is judged by its status */ }
      const id = doc.messages?.[0]?.id;
      if (r.status === 200 && typeof id === 'string') return { ok: true, providerId: id };
      return httpFailure(r, `${r.status} ${doc.error?.code ?? ''} ${doc.error?.message ?? ''}`.trim());
    },
  };
}
