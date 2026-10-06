// PT21.4: ingress. A provider's webhook goes to its channel's adapter; a refusal is recorded on runtime:ingress with
// the provider and the reason, and nothing is dispatched. A verified message's body goes to the content store, its
// sender claims are recorded (K11), and it is dispatched to the channel's conversation with its Content and the
// provider's message id, on which dispatch is idempotent (PF8.2). A provider's receipts are recorded.
import type { ChannelAdapter, IngressHost, Verified, Webhook } from '@poly/runtime/adapters';

export interface IngressAnswer { status: number; contentType: string; body: string }

export function ingress(host: IngressHost, channels: Record<string, ChannelAdapter>, clock: () => number = Date.now): (channel: string, w: Webhook) => Promise<IngressAnswer> {
  return async (channel, w) => {
    const adapter = Object.hasOwn(channels, channel) ? channels[channel] : undefined;
    if (!adapter) return { status: 404, contentType: 'text/plain', body: 'no such channel' };
    let v: Verified | { refused: string };
    // A body the adapter cannot read is a refusal like any other, never an exception out of ingress.
    try { v = adapter.verify(w, clock()); } catch (e) { v = { refused: `malformed: ${e instanceof Error ? e.message : String(e)}` }; }
    if ('refused' in v) {
      await host.ingressRecord(channel, { stage: 'verify', outcome: 'refused', provider: adapter.provider, reason: v.refused });
      return { status: 401, contentType: 'text/plain', body: 'refused' };
    }
    for (const r of v.receipts) {
      await host.ingressRecord(channel, { stage: 'receipt', outcome: 'recorded', provider: adapter.provider, providerId: r.providerId, status: r.status, ...(r.error ? { reason: r.error } : {}) });
    }
    for (const m of v.messages) {
      const content = await host.putContent(m.body);
      await host.ingressRecord(channel, { stage: 'claims', outcome: m.claims.verified ? 'verified' : 'unverified', provider: adapter.provider, messageId: m.providerMessageId, claims: m.claims });
      await host.inbound(channel, { ...m.fields, body: content }, { messageId: m.providerMessageId });
    }
    return v.answer ?? { status: 200, contentType: 'text/plain', body: 'ok' };
  };
}
