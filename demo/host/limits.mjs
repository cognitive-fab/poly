// DF7: the limits that protect the room. 280 characters a message, one message every 5 seconds a persona, 12 messages a persona.
// A refused message counts for nothing: it starts no gap and uses no part of the 12. `check` judges, `record` counts an accepted one.

export function createLimiter({ now = () => Date.now(), maxChars = 280, minGapMs = 5000, maxMessages = 12 } = {}) {
  const last = new Map();
  const count = new Map();
  return {
    maxChars, minGapMs, maxMessages,
    check(id, text) {
      if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'empty' };
      if ([...text].length > maxChars) return { ok: false, reason: 'too-long' };
      if ((count.get(id) ?? 0) >= maxMessages) return { ok: false, reason: 'too-many' };
      const since = last.has(id) ? now() - last.get(id) : Infinity;
      if (since < minGapMs) return { ok: false, reason: 'too-fast', retryInMs: minGapMs - since };
      return { ok: true };
    },
    /** Counts an accepted message; the function it returns takes the count back (a message the runtime then refused counts for nothing). */
    record(id) {
      const before = { last: last.get(id), count: count.get(id) ?? 0 };
      last.set(id, now());
      count.set(id, before.count + 1);
      return () => {
        if (before.last === undefined) last.delete(id); else last.set(id, before.last);
        count.set(id, before.count);
      };
    },
    sent: (id) => count.get(id) ?? 0,
  };
}
