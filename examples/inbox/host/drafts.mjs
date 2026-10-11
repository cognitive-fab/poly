// plan-ex.md E2, S455, S459: the handler of gmail.createDraft. It holds no rule: the gate has let the intent through
// (the owner's signed approval, IAC2), the runtime has checked that its envelope is one the source gave (envelope
// origin) and that its body may go to the account (the flow rule). The handler reads the two bodies of its own payload
// through content.read, writes one RFC 5322 message from them, and posts it as a draft in the thread through `api`,
// which sends under the account's compose grant to the exact drafts URL; no token reaches it (PT22.5). It never sends.
//
// Gmail's drafts.create takes { message: { raw, threadId } }; a draft joins the thread when its threadId is given and
// its In-Reply-To, References and Subject match the thread's (developers.google.com/workspace/gmail/api/guides/drafts,
// read 2026-10-10).
export const DRAFTS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts';

/** A header value with no line break, so a value cannot write another header. */
const oneLine = (v) => {
  const s = String(v ?? '');
  if (/[\r\n]/.test(s)) throw new Error('a header value holds a line break');
  return s;
};
/** RFC 2047: a value that is not plain ASCII, as one or more B-encoded words of UTF-8. */
const word = (v) => (/^[\x20-\x7e]*$/.test(v) ? v : Buffer.from(v, 'utf8').toString('base64').match(/.{1,60}/g).map((c) => `=?UTF-8?B?${c}?=`).join(' '));

/** The draft as one message: the envelope's headers and the body as UTF-8 text, base64 so no line is too long. */
export function draftMessage(envelope, body) {
  const e = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  if (!e || typeof e.to !== 'string' || e.to === '') throw new Error('an envelope names its recipient (S459)');
  const lines = [`To: ${oneLine(e.to)}`, `Subject: ${word(oneLine(e.subject ?? ''))}`];
  if (e.inReplyTo) lines.push(`In-Reply-To: ${oneLine(e.inReplyTo)}`);
  if (Array.isArray(e.references) && e.references.length) lines.push(`References: ${e.references.map(oneLine).join(' ')}`);
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '');
  const text = Buffer.from(String(body), 'utf8').toString('base64').match(/.{1,76}/g) ?? [];
  return [...lines, ...text, ''].join('\r\n');
}

/** The thread's Gmail id, from the thread key `<account label>/<thread id>` the source gives (S451). */
export const threadIdOf = (key) => {
  const m = /^[a-z][a-z0-9-]{0,31}\/([0-9a-zA-Z_-]{1,64})$/.exec(String(key ?? ''));
  if (!m) throw new Error('the thread key names no Gmail thread');
  return m[1];
};

/** The handler: reads its payload's envelope and body, and creates the draft in the thread. */
export async function createDraft(payload, caps) {
  const envelope = await caps.content.read(payload.e);
  const body = await caps.content.read(payload.body);
  const raw = Buffer.from(draftMessage(envelope, body), 'utf8').toString('base64url');
  const res = await caps.api.post(DRAFTS_URL, { message: { raw, threadId: threadIdOf(payload.t) } });
  if (res.status !== 200) throw new Error(`drafts.create answered ${res.status}`);
  return { ok: true };
}
