// The email adapter (S183): inbound mail by Mailgun's route webhook, one-click unsubscribe by RFC 8058, and sends by
// SMTP submission, from the documentation read on 2026-10-05 (packages/poly-io/PROVENANCE.md). Mailgun signs a route
// POST with HMAC-SHA256 under the webhook signing key over the timestamp and the token, hex, in the fields timestamp,
// token and signature; the body is not signed, so a token is taken once (the cache Mailgun recommends). A one-click
// unsubscribe is a POST of List-Unsubscribe=One-Click to the URL the adapter put in the bulk mail's List-Unsubscribe
// header, which carries the recipient and a token only the adapter can make.
import { createHash } from 'node:crypto';
import type { ChannelAdapter, Refusal, SendResult, Verified } from '@poly/runtime/adapters';
import { form, hmac, sameText, skewSeconds } from '../util.js';
import { submit } from '../smtp.js';

export interface EmailConfig {
  /** Mailgun's HTTP webhook signing key. */
  signingKey: string;
  /** The key of the unsubscribe tokens, and the public URL their POST goes to. */
  unsubscribeKey: string;
  unsubscribeUrl: string;
  /** The SMTP submission's sender, greeting name and credentials. */
  from: string;
  heloName: string;
  username: string;
  password: string;
  /** The subject of a message poly sends. */
  subject: string;
  /** How far a webhook's timestamp may be from now, in seconds (300 when not given). */
  toleranceSeconds?: number;
}

const tokenOf = (c: Pick<EmailConfig, 'unsubscribeKey'>, recipient: string) => hmac('sha256', c.unsubscribeKey, `unsubscribe:${recipient}`).toString('hex');

/** The one-click URL of a recipient (RFC 8058): the recipient, base64url, and its token. */
export function unsubscribeUrl(c: Pick<EmailConfig, 'unsubscribeKey' | 'unsubscribeUrl'>, recipient: string): string {
  const u = new URL(c.unsubscribeUrl);
  u.searchParams.set('r', Buffer.from(recipient, 'utf8').toString('base64url'));
  u.searchParams.set('t', tokenOf(c, recipient));
  return u.toString();
}

export function email(c: EmailConfig): ChannelAdapter {
  const tolerance = c.toleranceSeconds ?? 300;
  // Tokens taken within the tolerance; an older one is refused by its timestamp, so it can be forgotten.
  const taken = new Map<string, number>();
  return {
    kind: 'email',
    provider: 'mailgun-routes+smtp',
    verify(w, now): Verified | Refusal {
      if (w.method !== 'POST') return { refused: 'not-a-post' };
      const url = new URL(w.url);
      const r = url.searchParams.get('r');
      const t = url.searchParams.get('t');
      if (r !== null || t !== null) {
        // RFC 8058: the POST body is exactly List-Unsubscribe=One-Click.
        const recipient = Buffer.from(r ?? '', 'base64url').toString('utf8');
        if (!r || !t || !sameText(t, tokenOf(c, recipient))) return { refused: 'unsubscribe-token-invalid' };
        if (w.body.trim() !== 'List-Unsubscribe=One-Click') return { refused: 'unsubscribe-body-invalid' };
        // The token proves the request came from a holder of the mail sent to this recipient.
        return { messages: [{ providerMessageId: `unsubscribe:${recipient}`, fields: { from: recipient, event: 'Unsubscribe' }, body: '', claims: { verified: true, sender: recipient } }], receipts: [] };
      }
      const p = form(w.body);
      if (!p.signature || !p.token || !p.timestamp) return { refused: 'signature-missing' };
      if (!(skewSeconds(p.timestamp, now) <= tolerance)) return { refused: 'timestamp-stale' };
      if (!sameText(p.signature, hmac('sha256', c.signingKey, p.timestamp + p.token).toString('hex'))) return { refused: 'signature-invalid' };
      for (const [k, at] of taken) if (now - at > tolerance * 1000) taken.delete(k);
      if (taken.has(p.token)) return { refused: 'token-replayed' };
      taken.set(p.token, now);
      const sender = p.sender;
      const id = p['Message-Id'];
      if (!sender || !id || p['body-plain'] === undefined) return { refused: 'message-malformed' };
      // An email address is not authenticated by the route webhook, so the claim is unverified (K11).
      return { messages: [{ providerMessageId: id, fields: { from: sender, event: 'Mail' }, body: p['body-plain'], claims: { verified: false, sender } }], receipts: [] };
    },
    async send(out, t): Promise<SendResult> {
      if (!t.smtp) return { ok: false, permanent: true, error: 'no smtp transport' };
      const domain = c.from.split('@')[1] ?? 'localhost';
      // The Message-ID comes from the idempotency key, so a retried send carries the same one.
      const messageId = `<${createHash('sha256').update(out.idempotencyKey).digest('hex').slice(0, 32)}@${domain}>`;
      const headers = [
        `From: ${c.from}`,
        `To: ${out.to}`,
        `Subject: ${c.subject}`,
        `Date: ${new Date(out.now).toUTCString()}`,
        `Message-ID: ${messageId}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        // RFC 8058: bulk mail carries both headers; the relay's DKIM signature must cover them.
        ...(out.kind === 'Bulk' ? [`List-Unsubscribe: <${unsubscribeUrl(c, out.to)}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'] : []),
      ];
      const body = out.body.replace(/\r?\n/g, '\r\n');
      const r = await submit(t.smtp, { from: c.from, to: out.to, heloName: c.heloName, username: c.username, password: c.password, message: `${headers.join('\r\n')}\r\n\r\n${body}` });
      return r.ok ? { ok: true, providerId: messageId } : r;
    },
  };
}
