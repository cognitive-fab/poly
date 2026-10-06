// The Twilio SMS adapter (S183), from Twilio's webhook security, messaging webhook, message resource and opt-out
// keyword documentation read on 2026-10-05 (packages/poly-io/PROVENANCE.md). A webhook is signed in
// X-Twilio-Signature: base64 of HMAC-SHA1 under the auth token over the full URL followed by every POST parameter,
// sorted by name, each name followed by its value. An inbound message carries MessageSid, From, To and Body; a status
// callback carries MessageSid and MessageStatus. The adapter classifies the body's keyword for std.channels.sms.
import type { ChannelAdapter, ProviderReceipt, Refusal, SendResult, Verified } from '@poly/runtime/adapters';
import { encodeForm, formPairs, hmac, httpFailure, noAnswer, signatureMatches, type AdapterFault } from '../util.js';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** The sending number, E.164. */
  from: string;
  /** Where Twilio posts the status of a send, when receipts are wanted. */
  statusCallback?: string;
  /** A seeded mutant, for the tests only (ADAPTER_FAULTS). */
  fault?: AdapterFault;
}

// The keywords Twilio documents, matched without regard to case: opt-out, opt-in, and help.
export const OPT_OUT = ['STOP', 'UNSUBSCRIBE', 'END', 'QUIT', 'STOPALL', 'REVOKE', 'OPTOUT', 'CANCEL'];
export const OPT_IN = ['START', 'UNSTOP'];
export const HELP = ['HELP'];

/** std.channels.sms's Keyword for a message body: a keyword is the whole message, without regard to case or the
 * spaces around it. */
export function keywordOf(body: string): 'Plain' | 'OptOut' | 'OptIn' | 'Help' {
  const w = body.trim().toUpperCase();
  return OPT_OUT.includes(w) ? 'OptOut' : OPT_IN.includes(w) ? 'OptIn' : HELP.includes(w) ? 'Help' : 'Plain';
}

const FINAL = new Map<string, ProviderReceipt['status']>([['sent', 'sent'], ['delivered', 'delivered'], ['undelivered', 'undelivered'], ['failed', 'failed'], ['read', 'read']]);

/** X-Twilio-Signature for a form POST to url. */
export function twilioSignature(authToken: string, url: string, body: string): string {
  const pairs = formPairs(body).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return hmac('sha1', authToken, url + pairs.map(([k, v]) => k + v).join('')).toString('base64');
}

export function sms(c: TwilioConfig): ChannelAdapter {
  return {
    kind: 'sms',
    provider: 'twilio',
    sender: c.from,
    verify(w): Verified | Refusal {
      if (w.method !== 'POST') return { refused: 'not-a-post' };
      const sig = w.headers['x-twilio-signature'];
      if (!sig) return { refused: 'signature-missing' };
      if (!(w.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return { refused: 'content-type-unsupported' };
      if (!signatureMatches(sig, twilioSignature(c.authToken, w.url, w.body), c.fault)) return { refused: 'signature-invalid' };
      const p = Object.fromEntries(formPairs(w.body));
      if (p.AccountSid !== c.accountSid) return { refused: 'account-mismatch' };
      if (typeof p.MessageSid !== 'string' || !p.MessageSid) return { refused: 'message-malformed' };
      if (p.MessageStatus !== undefined) {
        const status = FINAL.get(p.MessageStatus);
        return { messages: [], receipts: status ? [{ providerId: p.MessageSid, status, ...(p.ErrorCode ? { error: p.ErrorCode } : {}) }] : [] };
      }
      if (typeof p.From !== 'string' || typeof p.Body !== 'string') return { refused: 'message-malformed' };
      // An SMS sender's number is not authenticated, so the claim is unverified (K11).
      return { messages: [{ providerMessageId: p.MessageSid, fields: { from: p.From, keyword: keywordOf(p.Body) }, body: p.Body, claims: { verified: false, sender: p.From } }], receipts: [] };
    },
    async send(out, t): Promise<SendResult> {
      if (!t.http) return { ok: false, permanent: true, error: 'no http transport' };
      let r;
      try {
        r = await t.http.request({
          method: 'POST',
          url: `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`,
          headers: { authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: encodeForm({ To: out.to, From: c.from, Body: out.body, ...(c.statusCallback ? { StatusCallback: c.statusCallback } : {}) }),
        });
      } catch (e) { return noAnswer(e); }
      let doc: { sid?: unknown; code?: unknown; message?: unknown } = {};
      try { doc = JSON.parse(r.body) as typeof doc; } catch { /* judged by its status */ }
      if ((r.status === 200 || r.status === 201) && typeof doc.sid === 'string') return { ok: true, providerId: doc.sid };
      // 21610: the recipient has opted out of this sender, perhaps by a keyword poly never saw; a retry fails the same
      // way, and it is the provider event Reported, which std.channels.sms's consent reads (PS15.4).
      if (doc.code === 21610) return { ok: false, permanent: true, error: `${r.status} 21610 ${doc.message ?? ''}`.trim(), events: [{ providerId: `21610:${out.to}`, fields: { from: out.to, keyword: 'Reported' } }] };
      return httpFailure(r, `${r.status} ${doc.code ?? ''} ${doc.message ?? ''}`.trim());
    },
  };
}
