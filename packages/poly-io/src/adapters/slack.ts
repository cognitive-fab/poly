// The Slack adapter (S183): the Events API in, chat.postMessage out, from Slack's documentation read on 2026-10-05
// (packages/poly-io/PROVENANCE.md). A request is signed in X-Slack-Signature as v0=<hex> of HMAC-SHA256 under the
// signing secret over v0:<X-Slack-Request-Timestamp>:<body>, and a timestamp more than five minutes from now is
// refused. url_verification is answered with its challenge. A message, an archive and an unarchive of the channel are
// the conversation's Inbound; the event id is the provider's message id, so Slack's retries are one step.
import { createHash } from 'node:crypto';
import type { ChannelAdapter, Refusal, SendResult, Verified } from '@poly/runtime/adapters';
import { fresh, hmac, httpFailure, json, noAnswer, signatureMatches, made, type AdapterFault } from '../util.js';

export interface SlackConfig {
  signingSecret: string;
  botToken: string;
  /** A seeded mutant, for the tests only (ADAPTER_FAULTS). */
  fault?: AdapterFault;
}

const REPLAY_SECONDS = 300;
const EVENTS: Record<string, string> = { message: 'Posted', channel_archive: 'Archived', channel_unarchive: 'Unarchived' };

interface SlackEvent { type?: unknown; channel?: unknown; user?: unknown; text?: unknown; subtype?: unknown; bot_id?: unknown }

export function slack(c: SlackConfig): ChannelAdapter {
  return made({
    kind: 'slack',
    provider: 'slack-events-api',
    // The bot's token names the workspace and app it posts as; its digest stands for it.
    sender: `bot:${createHash('sha256').update(c.botToken).digest('hex').slice(0, 16)}`,
    verify(w, now): Verified | Refusal {
      const ts = w.headers['x-slack-request-timestamp'];
      const sig = w.headers['x-slack-signature'];
      if (!ts || !sig) return { refused: 'signature-missing' };
      if (!fresh(ts, now, REPLAY_SECONDS, c.fault)) return { refused: 'timestamp-stale' };
      if (!signatureMatches(sig, `v0=${hmac('sha256', c.signingSecret, `v0:${ts}:${w.body}`).toString('hex')}`, c.fault)) return { refused: 'signature-invalid' };
      const doc = json(w.body) as { type?: unknown; challenge?: unknown; event_id?: unknown; event?: SlackEvent };
      if (doc.type === 'url_verification') return { messages: [], receipts: [], answer: { status: 200, contentType: 'text/plain', body: String(doc.challenge ?? '') } };
      if (doc.type !== 'event_callback' || typeof doc.event_id !== 'string' || !doc.event) return { messages: [], receipts: [] };
      const e = doc.event;
      const event = typeof e.type === 'string' ? EVENTS[e.type] : undefined;
      // A bot's message, the app's own post among them, and an edit or a deletion (a subtype) are not inbound messages.
      if (!event || typeof e.channel !== 'string' || (event === 'Posted' && (e.subtype !== undefined || e.bot_id !== undefined))) return { messages: [], receipts: [] };
      const user = typeof e.user === 'string' ? e.user : '';
      // Slack authenticates the user who posted, so the claim is verified (K11).
      return { messages: [{ providerMessageId: doc.event_id, fields: { channel: e.channel, event }, body: event === 'Posted' && typeof e.text === 'string' ? e.text : '', claims: { verified: user !== '', sender: user } }], receipts: [] };
    },
    async send(out, t): Promise<SendResult> {
      if (!t.http) return { ok: false, permanent: true, error: 'no http transport' };
      let r;
      try {
        r = await t.http.request({ method: 'POST', url: 'https://slack.com/api/chat.postMessage', headers: { authorization: `Bearer ${c.botToken}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ channel: out.to, text: out.body }) });
      } catch (e) { return noAnswer(e); }
      let doc: { ok?: unknown; ts?: unknown; channel?: unknown; error?: unknown } = {};
      try { doc = JSON.parse(r.body) as typeof doc; } catch { /* judged by its status */ }
      if (r.status === 200 && doc.ok === true && typeof doc.ts === 'string') return { ok: true, providerId: `${typeof doc.channel === 'string' ? doc.channel : out.to}:${doc.ts}` };
      // Slack answers an error with 200 and ok false; rate_limited (with 429) and an internal error may pass on retry.
      const error = typeof doc.error === 'string' ? doc.error : String(r.status);
      // PS15.4: is_archived is a report std.channels.slack's rule no-post-to-archived reads, so it is the provider event
      // Archived for the channel's conversation.
      if (r.status === 200 && error === 'is_archived') return { ok: false, permanent: true, error, events: [{ providerId: `is_archived:${out.to}`, fields: { channel: out.to, event: 'Archived' } }] };
      if (r.status === 200) return { ok: false, permanent: !['rate_limited', 'ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'].includes(error), error };
      return httpFailure(r, error);
    },
  });
}
