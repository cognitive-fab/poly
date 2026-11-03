// DF2, DF3, DF4, DF7: the room. People in the room send free text from their phones or laptops; each message is signed as the
// WhatsApp Cloud API signs (signing.mjs) and handed to the runtime's ingress, which verifies it with the certified whatsapp adapter.
// A reply the concierge sends comes back through the transport (transport.mjs) to the room page of the persona it is for. The room
// holds no rule of the concierge: it holds the limits (limits.mjs) and the kill switch, and nothing the customer types chooses a
// principal. A forged or unsigned message never gets here: only `say` signs, and only for a session that has joined.
import { signedWebhook } from './signing.mjs';

// DF28 item 4: the room's own line when a turn ends with no reply. The program cannot send a fixed text (PS1.4a: the only Content
// constant is none), so the page says it, apart from the concierge's replies.
export const UNANSWERED = 'The concierge did not answer this message.';
export const RECORDED_ONLY = 'This room answers only its recorded messages.';

/**
 * `rt` is the runtime (only `receive` is used); `wa` is the channel's configuration (the app secret and the phone number id);
 * `pool` and `limiter` are personas.mjs and limits.mjs; `settle` runs the runtime until it is quiet (the launcher gives it, a test
 * gives a no-op); `onKill` is called once, with who stopped the room. `onReply({ session })` is called after each reply delivered to a guest
 * (the end of a turn, DF10 item 6); `capReached()` is the spend meter's (DF10 item 5): the room is killed with 'spend-cap' when it says so.
 * `messagesOf(persona)` gives a recorded room's guest the texts it has answers for (DF28 item 2); a room without it is not recorded.
 */
export function createRoom({ rt, wa, now = () => Date.now(), pool, limiter, settle = async () => {}, onKill = () => {}, onReply = () => {}, capReached = () => false, channel = 'support', url = 'https://room.invalid/channels/support', messagesOf = null }) {
  const personaOf = new Map(); // session -> persona
  const listeners = new Map(); // session -> Set(fn)
  const histories = new Map(); // session -> replies and notices
  let killed = false;
  let sequence = 0;

  const kill = (by = 'presenter') => {
    if (killed) return;
    killed = true;
    onKill(by);
    for (const session of listeners.keys()) emit(session, { kind: 'halted', at: now() });
  };
  const stopAtCap = () => { if (!killed && capReached()) kill('spend-cap'); };
  const emit = (session, event) => { for (const fn of listeners.get(session) ?? []) fn(event); };
  const sessionOfPersona = (persona) => [...personaOf].find(([, p]) => p === persona)?.[0] ?? null;
  const recorded = messagesOf !== null;

  return {
    get killed() { return killed; },
    persona: (session) => personaOf.get(session) ?? null,
    recorded,
    /** DF28 item 2: the recorded texts the session's guest may send, in a new array; none outside a recorded room. */
    suggestions(session) {
      const persona = personaOf.get(session);
      return recorded && persona ? [...messagesOf(persona)] : [];
    },
    join(session) {
      if (killed) return null;
      const persona = pool.claim(session);
      if (persona) personaOf.set(session, persona);
      return persona;
    },
    async say(session, text) {
      stopAtCap();
      if (killed) return { ok: false, reason: 'halted' };
      const persona = personaOf.get(session);
      if (!persona) return { ok: false, reason: 'no-session' };
      const verdict = limiter.check(persona.id, text);
      if (!verdict.ok) return verdict;
      const undo = limiter.record(persona.id); // before the await, so two quick messages cannot both pass the gap
      const w = signedWebhook({ appSecret: wa.appSecret, phoneNumberId: wa.phoneNumberId, persona, text, id: `wamid.ROOM.${++sequence}`, url, timestamp: String(Math.floor(now() / 1000)) });
      const answer = await rt.receive(channel, w);
      if (answer.status !== 200) { undo(); return { ok: false, reason: 'refused' }; }
      await settle();
      stopAtCap();
      return { ok: true };
    },
    /** A reply for the number `phone`, from the transport: shown to that persona's page, or dropped. */
    deliver(phone, text) {
      if (killed) return false;
      const persona = pool.byPhone(phone);
      const session = persona ? sessionOfPersona(persona) : null;
      if (session === null) return false;
      const event = { kind: 'reply', text, at: now() };
      histories.set(session, [...(histories.get(session) ?? []), event]);
      emit(session, event);
      onReply({ session });
      stopAtCap();
      return true;
    },
    /** DF28 item 4: a turn of the guest of `phone` ended with no reply. Not a reply, so `onReply` is not called. */
    unanswered(phone) {
      if (killed) return false;
      const persona = pool.byPhone(phone);
      const session = persona ? sessionOfPersona(persona) : null;
      if (session === null) return false;
      const event = { kind: 'notice', text: recorded ? `${UNANSWERED} ${RECORDED_ONLY}` : UNANSWERED, at: now() };
      histories.set(session, [...(histories.get(session) ?? []), event]);
      emit(session, event);
      return true;
    },
    subscribe(session, fn) {
      if (!listeners.has(session)) listeners.set(session, new Set());
      listeners.get(session).add(fn);
      if (killed) fn({ kind: 'halted', at: now() });
      return () => listeners.get(session)?.delete(fn);
    },
    history: (session) => (histories.get(session) ?? []).map((e) => ({ ...e })),
    /** The presenter's kill switch: the room stops, for everyone, and stays stopped until the host is started again. */
    kill,
    stats: () => ({ killed, personas: pool.claimed().length, said: pool.claimed().reduce((n, p) => n + limiter.sent(p.id), 0) }),
  };
}
