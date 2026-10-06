// The email adapter (S183): inbound mail by Mailgun's route webhook, delivery reports by Mailgun's event webhooks,
// one-click unsubscribe by RFC 8058, and sends by SMTP submission, from the documentation read on 2026-10-05
// (packages/poly-io/PROVENANCE.md). Mailgun signs a webhook with HMAC-SHA256 under the webhook signing key over the
// timestamp and the token, hex: in the fields timestamp, token and signature of a route POST, and in the object
// signature of an event webhook. The body is not signed, so the token is the webhook's nonce, taken once in the store
// (the cache Mailgun recommends). A one-click unsubscribe is a POST of List-Unsubscribe=One-Click to the URL the
// adapter put in the bulk mail's List-Unsubscribe header, which carries the recipient, the time the URL was issued,
// and a token only it can make.
import { createHash } from 'node:crypto';
import type { ChannelAdapter, Refusal, SendResult, Verified, Webhook } from '@poly/runtime/adapters';
import { form, fresh, hmac, json, sameText, signatureMatches, made, need, oneLine, type AdapterFault } from '../util.js';
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
  /** A seeded mutant, for the tests only (ADAPTER_FAULTS). */
  fault?: AdapterFault;
}

const tokenOf = (c: Pick<EmailConfig, 'unsubscribeKey'>, recipient: string, issued: string) => hmac('sha256', c.unsubscribeKey, `unsubscribe:${recipient}:${issued}`).toString('hex');

/**
 * The one-click URL of a recipient (RFC 8058): the recipient, base64url, the time it was issued (ms), and its token.
 * Review C-F3 (M8b): the issue time makes each mail's URL its own, so a later unsubscribe is a message of its own
 * and not the replay of an earlier one.
 */
export function unsubscribeUrl(c: Pick<EmailConfig, 'unsubscribeKey' | 'unsubscribeUrl'>, recipient: string, issuedAtMs: number): string {
  const u = new URL(c.unsubscribeUrl);
  const issued = String(Math.floor(issuedAtMs));
  u.searchParams.set('r', Buffer.from(recipient, 'utf8').toString('base64url'));
  u.searchParams.set('i', issued);
  u.searchParams.set('t', tokenOf(c, recipient, issued));
  return u.toString();
}

/**
 * Review C-F1 (M8b): one recipient, one addr-spec: a local part and a domain with no space, angle bracket, comma,
 * semicolon, quote or CR and LF, which would add a recipient or a command to the session.
 */
const ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+$/;

/**
 * Review C-F4 (M8b): RFC 8058 says the one-click POST SHOULD be multipart/form-data, and allows the urlencoded form; in
 * either, the body is the one field List-Unsubscribe with the value One-Click.
 */
function oneClick(w: Webhook): boolean {
  const type = w.headers['content-type'] ?? '';
  const m = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(type);
  if (!m) return w.body.trim() === 'List-Unsubscribe=One-Click';
  const boundary = `--${m[1] ?? m[2]}`;
  const parts = w.body.split(boundary).slice(1);
  const fields: [string, string][] = [];
  for (const part of parts) {
    if (part.startsWith('--')) break;
    const at = part.indexOf('\r\n\r\n');
    if (at < 0) return false;
    const name = /content-disposition:\s*form-data;\s*name="([^"]*)"/i.exec(part.slice(0, at))?.[1];
    if (name === undefined) return false;
    fields.push([name, part.slice(at + 4).replace(/\r\n$/, '')]);
  }
  return fields.length === 1 && fields[0][0] === 'List-Unsubscribe' && fields[0][1] === 'One-Click';
}

interface MailgunEvent { event?: unknown; id?: unknown; severity?: unknown; recipient?: unknown; reason?: unknown; message?: { headers?: Record<string, unknown> }; 'delivery-status'?: { code?: unknown; message?: unknown } }

export function email(c: EmailConfig): ChannelAdapter {
  need('email', { signingKey: c.signingKey, unsubscribeKey: c.unsubscribeKey, unsubscribeUrl: c.unsubscribeUrl, from: c.from, heloName: c.heloName });
  oneLine('email', { from: c.from, subject: c.subject, heloName: c.heloName });
  if (!ADDRESS.test(c.from)) throw new Error(`email: from is not one address (${JSON.stringify(c.from)})`);
  const tolerance = c.toleranceSeconds ?? 300;
  /** Mailgun's signature over timestamp and token, checked; the token is the nonce, kept while the timestamp is fresh. */
  const signed = (timestamp: unknown, token: unknown, signature: unknown, now: number): Refusal | { nonce: Verified['nonce'] } => {
    if (typeof timestamp !== 'string' || typeof token !== 'string' || typeof signature !== 'string' || !timestamp || !token || !signature) return { refused: 'signature-missing' };
    if (!fresh(timestamp, now, tolerance, c.fault)) return { refused: 'timestamp-stale' };
    if (!signatureMatches(signature, hmac('sha256', c.signingKey, timestamp + token).toString('hex'), c.fault)) return { refused: 'signature-invalid' };
    // Review C-F7 (M8b): fresh() takes the signature until our clock passes timestamp + tolerance, so the store keeps
    // the token until then, whatever the skew between Mailgun's clock and ours.
    return { nonce: { key: `mailgun:${token}`, until: (Number(timestamp) + tolerance) * 1000 } };
  };
  return made({
    kind: 'email',
    provider: 'mailgun-routes+smtp',
    // Mailgun keeps bounces and unsubscribes per sending domain.
    sender: c.from.split('@')[1] ?? c.from,
    verify(w, now): Verified | Refusal {
      if (w.method !== 'POST') return { refused: 'not-a-post' };
      const url = new URL(w.url);
      const r = url.searchParams.get('r');
      const i = url.searchParams.get('i');
      const t = url.searchParams.get('t');
      if (r !== null || i !== null || t !== null) {
        const recipient = Buffer.from(r ?? '', 'base64url').toString('utf8');
        if (!r || !i || !/^\d+$/.test(i) || !t || !sameText(t, tokenOf(c, recipient, i))) return { refused: 'unsubscribe-token-invalid' };
        if (!oneClick(w)) return { refused: 'unsubscribe-body-invalid' };
        // The token proves the request came from a holder of the mail sent to this recipient at that time.
        return { messages: [{ providerMessageId: `unsubscribe:${recipient}:${i}`, fields: { from: recipient, event: 'Unsubscribe' }, body: '', claims: { verified: true, sender: recipient } }], receipts: [] };
      }
      if ((w.headers['content-type'] ?? '').startsWith('application/json')) {
        // An event webhook: { signature: { timestamp, token, signature }, event-data: { … } }.
        const doc = json(w.body) as { signature?: { timestamp?: unknown; token?: unknown; signature?: unknown }; 'event-data'?: MailgunEvent };
        const s = signed(doc.signature?.timestamp, doc.signature?.token, doc.signature?.signature, now);
        if ('refused' in s) return s;
        const e = doc['event-data'];
        if (!e || typeof e.id !== 'string' || typeof e.recipient !== 'string') return { refused: 'event-malformed' };
        // PS15.4: a permanent failure is a bounce, which std.channels.email's suppression reads: the provider event Bounce
        // on the recipient's thread. Any other report is a receipt, recorded only.
        if (e.event === 'failed' && e.severity === 'permanent') {
          return { messages: [{ providerMessageId: `mailgun-event:${e.id}`, fields: { from: e.recipient, event: 'Bounce' }, body: '', claims: { verified: true, sender: 'mailgun' } }], receipts: [], nonce: s.nonce };
        }
        const id = e.message?.headers?.['message-id'];
        const status = e.event === 'delivered' ? 'delivered' : e.event === 'failed' ? 'failed' : null;
        if (typeof id !== 'string' || !status) return { messages: [], receipts: [], nonce: s.nonce };
        return { messages: [], receipts: [{ providerId: id.startsWith('<') ? id : `<${id}>`, status }], nonce: s.nonce };
      }
      const p = form(w.body);
      const s = signed(p.timestamp, p.token, p.signature, now);
      if ('refused' in s) return s;
      const sender = p.sender;
      const id = p['Message-Id'];
      if (!sender || !id || p['body-plain'] === undefined) return { refused: 'message-malformed' };
      // An email address is not authenticated by the route webhook, so the claim is unverified (K11). Review C-F3
      // (M8b): the id is prefixed, so a mail's own Message-Id, which its sender writes, cannot take the id of an
      // unsubscribe or a Mailgun event and have it deduplicated away.
      return { messages: [{ providerMessageId: `mail:${id}`, fields: { from: sender, event: 'Mail' }, body: p['body-plain'], claims: { verified: false, sender } }], receipts: [], nonce: s.nonce };
    },
    async send(out, t): Promise<SendResult> {
      // Review C-F1 (M8b): the recipient goes into RCPT TO and the To header, so it is one address and nothing more.
      if (!ADDRESS.test(out.to)) return { ok: false, permanent: true, error: `the recipient is not one address (${JSON.stringify(out.to)})` };
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
        ...(out.kind === 'Bulk' ? [`List-Unsubscribe: <${unsubscribeUrl(c, out.to, out.now)}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'] : []),
      ];
      // Review C-F2 (M8b): a bare CR is a line end too.
      const body = out.body.replace(/\r\n|\r|\n/g, '\r\n');
      const r = await submit(t.smtp, { from: c.from, to: out.to, heloName: c.heloName, username: c.username, password: c.password, message: `${headers.join('\r\n')}\r\n\r\n${body}` });
      if (r.ok) return { ok: true, providerId: messageId };
      const { stage, ...failed } = r;
      // Review B-F5 (M8b): only the recipient's own rejection, a 5yz reply to RCPT TO, is a bounce, the provider event
      // std.channels.email's suppression reads (PS15.4). A refused login or sender is a failure of ours, not theirs.
      if (stage === 'rcpt' && r.permanent) return { ...failed, events: [{ providerId: `bounce:${messageId}`, fields: { from: out.to, event: 'Bounce' } }] };
      return failed;
    },
  });
}
