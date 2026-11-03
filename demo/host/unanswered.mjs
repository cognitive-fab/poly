// DF28 item 4: a turn that ends with no reply. A dead `answer`, `reply` or `ack` decision of a guest's Desk is `AnswerFailed` or
// `AckFailed`, which send nothing, so the guest would see nothing. This reads those rows of the runtime's outbox and tells the room,
// which shows its own notice. Other kinds are not ends of a turn: a dead `classify` or `amount` is followed by a `reply`.

const SQL = "SELECT intent_id, instance_id, kind FROM pr_outbox WHERE status = 'dead' AND kind IN ('decision.answer', 'decision.reply', 'decision.ack')";

/**
 * `desks()` gives `{ instance, phone }` for each claimed guest; `onUnanswered(phone)` is called once for each dead row of a desk.
 * An intent is seen once, whether or not it was a desk's: a desk exists only once its guest has spoken.
 */
export function watchUnanswered({ db, desks, onUnanswered, everyMs = 500 }) {
  const seen = new Set();
  let stopped = false;
  const poll = async () => {
    if (stopped) return;
    let rows;
    try { rows = db.prepare(SQL).all(); } catch { return; }
    const fresh = rows.filter((r) => !seen.has(r.intent_id));
    if (fresh.length === 0) return;
    const byInstance = new Map((await desks()).map((d) => [d.instance, d.phone]));
    for (const r of fresh) {
      if (seen.has(r.intent_id)) continue;
      seen.add(r.intent_id);
      const phone = byInstance.get(r.instance_id);
      if (phone !== undefined) onUnanswered(phone);
    }
  };
  const timer = setInterval(() => { poll().catch(() => {}); }, everyMs);
  timer.unref?.();
  return { poll, stop() { stopped = true; clearInterval(timer); } };
}
