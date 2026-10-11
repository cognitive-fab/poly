// plan-ex.md E1 (3.7, decided by the plan's rules): the host tells staff of each refund the gate escalates. A Desk
// cannot name the staff's Notice instance, so the host, which reads each Desk's journal, dispatches Notify to the staff
// thread; Notice posts through its own channel, so the notice crosses the gate like any send. The host holds no rule:
// it forwards the fact that an intent waits, by its id, and nothing of the customer's message or order. A Slack message
// approves nothing (PF11.8): the approval is a person's signed record (`poly approve`, PF9.6).

/** The notice's text: the intent that waits, and how a person approves it. No customer data. */
export const noticeText = (intent) => `A refund waits for a person's approval (intent ${intent}). Approve it with poly approve, signed with your person key; a message here approves nothing.`;

/**
 * Dispatches one Notify for each refund intent escalated on the given Desk instances and not yet noticed. A notice the
 * Notice instance refuses (its previous one still in flight) stays unnoticed and is sent on a later call.
 * Returns the intents noticed by this call.
 */
export async function forwardEscalations(rt, { desks, notice, noticed }) {
  const sent = [];
  for (const id of desks) {
    for (const e of await rt.chain(id)) {
      if (e.kind !== 'verdict' || e.body?.outcome !== 'escalated' || e.body?.effectKind !== 'payments.refund') continue;
      const intent = e.body.intent;
      if (noticed.has(intent)) continue;
      const text = await rt.putContent(noticeText(intent));
      const r = await rt.dispatch(notice, 'Notify', { text });
      if (r.stepKind !== 'accepted') return sent;
      noticed.add(intent);
      sent.push(intent);
    }
  }
  return sent;
}
