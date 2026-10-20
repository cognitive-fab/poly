// DF17 item 4: the line the presenter's prompt prints for `approve <intent id>`. The runtime's approve returns nothing, so the launcher used to
// print `undefined`. This says what happened: the intent was approved and by which key, or why it was refused.

// A thrown value can be anything: an Error, a string, a plain object with a message, an object with no prototype.
function messageOf(e) {
  try {
    if (e instanceof Error) return e.message;
    if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;
    return String(e);
  } catch { return 'unreadable error'; }
}
const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();

/** Runs the approval and returns { ok, line }; it never throws. */
export async function runApprove(demo, intentId) {
  if (typeof intentId !== 'string' || intentId === '') return { ok: false, line: 'usage: approve <intent id>' };
  try {
    const r = await demo.approve(intentId);
    return { ok: true, line: `approved: intent ${r.intent}, signed by the presenter key ${r.by}` };
  } catch (e) {
    const message = oneLine(messageOf(e)).replace(/^approval refused: /, '').slice(0, 200);
    return { ok: false, line: `approval refused: ${message}` };
  }
}
