// The handlers of model.call and mail.send (docs/examples/pii-guard.md, S587). They hold no rule: the machine sent only
// after a scan and, unless the facts were Absent, a verified redaction, and the gate checked the same on the snapshot. Each
// reads its text through content.read and posts it with the intent's idempotency key. Neither service documents that key,
// so one attempt is made: an answer that is not a definite refusal means the text may have left, and it is delivered as
// exhausted, for a person to look at (PS23.5, finding 31).
import type { Effects } from '../.poly/build/pii.Outbound/types.js';

interface Caps {
  content: { read(digest: string): Promise<string | null | undefined> };
  egress: { post(url: string, body: unknown, options?: { headers?: Record<string, string> }): Promise<{ status: number }> };
}

const MODEL_URL = 'https://model.example/v1/complete';
const MAIL_URL = 'https://mail.example/v1/send';

/** A refusal the same request would meet again: nothing left. */
const definite = (message: string): Error => Object.assign(new Error(message), { permanent: true });
/** The text may have left: not permanent, so the one attempt is used up and the send is delivered as exhausted. */
const ambiguous = (message: string): Error => Object.assign(new Error(message), { ambiguous: true });

/** Reads a stored body; nothing has left yet, so a body that cannot be read is a definite failure. */
async function read(caps: Caps, digest: string | null, what: string): Promise<string> {
  if (digest === null) throw definite(`no ${what}`);
  let text: string | null | undefined;
  try {
    text = await caps.content.read(digest);
  } catch (e) {
    throw definite(`the ${what} cannot be read: ${String((e as Error)?.message ?? e)}`);
  }
  if (typeof text !== 'string') throw definite(`the ${what} is not stored`);
  return text;
}

async function post(caps: Caps, url: string, body: unknown, key: string | undefined, service: string): Promise<{ ok: true }> {
  let status: number;
  try {
    const headers: Record<string, string> = key ? { 'idempotency-key': key } : {};
    status = (await caps.egress.post(url, body, { headers })).status;
  } catch (e) {
    throw ambiguous(`${service} did not answer: ${String((e as Error)?.message ?? e)}`);
  }
  if (status === 200 || status === 201) return { ok: true };
  if (status >= 400 && status < 500 && status !== 429) throw definite(`${service} answered ${status}`);
  throw ambiguous(`${service} answered ${status}`);
}

export async function callModel(payload: Effects['model.call'], caps: Caps, ctx: { idempotencyKey?: string }): Promise<{ ok: true }> {
  const text = await read(caps, payload.text, 'text');
  return post(caps, MODEL_URL, { input: text }, ctx.idempotencyKey, 'the model');
}

export async function sendMail(payload: Effects['mail.send'], caps: Caps, ctx: { idempotencyKey?: string }): Promise<{ ok: true }> {
  const text = await read(caps, payload.text, 'text');
  const to = await read(caps, payload.to, 'address');
  return post(caps, MAIL_URL, { to, body: text }, ctx.idempotencyKey, 'the mail server');
}
