// The handler of helpdesk.createDraft (docs/examples/support-drafts.md). It holds no rule: the gate has escalated the
// intent and the owner's signed approval has released it, and the runtime has checked that the body may go to the owner.
// It reads the draft's text through content.read and posts it to the helpdesk with the intent's idempotency key. A draft
// has no natural key at the helpdesk beyond that, and one attempt is made: an answer that is not a definite refusal means
// the draft may exist, so it is delivered as exhausted and the owner decides.
import type { Effects } from '../.poly/build/drafts.Ticket/types.js';

interface Caps {
  content: { read(digest: string): Promise<string> };
  egress: { post(url: string, body: unknown, options?: { headers?: Record<string, string> }): Promise<{ status: number }> };
}

const DRAFTS_URL = 'https://helpdesk.example/v1/drafts';

/** A refusal the same request would meet again, so the draft was not created. */
const definite = (message: string): Error => Object.assign(new Error(message), { permanent: true });
/** The draft may exist: not permanent, so the attempts are used up and it is delivered as exhausted. */
const ambiguous = (message: string): Error => Object.assign(new Error(message), { ambiguous: true });

export async function createDraft(payload: Effects['helpdesk.createDraft'], caps: Caps, ctx: { idempotencyKey?: string }): Promise<{ ok: true }> {
  if (payload.body === null) throw definite('a draft has a body');
  let text: string;
  try {
    text = await caps.content.read(payload.body);
  } catch (e) {
    // Nothing has left yet: a failure here means no draft was created.
    throw definite(String((e as Error)?.message ?? e));
  }
  let status: number;
  try {
    const headers: Record<string, string> = ctx.idempotencyKey ? { 'idempotency-key': ctx.idempotencyKey } : {};
    status = (await caps.egress.post(DRAFTS_URL, { body: text }, { headers })).status;
  } catch (e) {
    throw ambiguous(`helpdesk did not answer: ${String((e as Error)?.message ?? e)}`);
  }
  if (status === 200 || status === 201) return { ok: true };
  if (status >= 400 && status < 500 && status !== 429) throw definite(`helpdesk answered ${status}`);
  throw ambiguous(`helpdesk answered ${status}`);
}
