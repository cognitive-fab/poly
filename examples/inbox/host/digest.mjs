// plan-ex.md E2, "Run it yourself": the digest the host prints after each pass. It reads what the machines recorded (each
// Message's verdict, each Todo's title and due bucket) and the sender and subject from the host's own mail store, and it
// goes to standard output and nowhere else: no title, subject or body is written to a file, a log or the journal here,
// so the property that no mail text is kept outside the content store and the mail store (IAC7) holds for the host too.

/** The sender and subject of a stored item, from the headers its text begins with (gmail.ts writes From, To, Subject, Date). */
export function headersOf(body) {
  const line = (name) => (new RegExp(`^${name}: (.*)$`, 'mi').exec(body ?? '')?.[1] ?? '').trim();
  return { from: line('From'), subject: line('Subject') };
}

/**
 * The digest's model: counts per account, the open to-dos, and the messages the assistant could not decide. `accounts`
 * is the config's list of { label, owner }; `source` is the Gmail source (for the stored headers).
 */
export async function readDigest(rt, { accounts, source, now = new Date() }) {
  const labelOf = (owner) => accounts.find((a) => a.owner === owner)?.label ?? 'unknown';
  const ids = (machine) => rt.store.db.prepare('SELECT instance_id FROM pr_instance WHERE machine_id = ? ORDER BY instance_id').all(machine).map((r) => r.instance_id);
  const perAccount = Object.fromEntries(accounts.map((a) => [a.label, { messages: 0, actionable: 0, filed: 0, held: 0, pending: 0 }]));
  const held = [];
  for (const id of ids('inbox.Message')) {
    const s = (await rt.getState(id)).state;
    const label = labelOf(s.account);
    const c = (perAccount[label] ??= { messages: 0, actionable: 0, filed: 0, held: 0, pending: 0 });
    c.messages += 1;
    c[{ Actionable: 'actionable', Filed: 'filed', Held: 'held' }[s.seen] ?? 'pending'] += 1;
    if (s.seen === 'Held') held.push({ id, label, ...headersOf(await source.resolve(s.id).catch(() => null)) });
  }
  const todos = [];
  for (const id of ids('inbox.Todo')) {
    const s = (await rt.getState(id)).state;
    if (s.status === 'Done' || s.status === 'Dismissed') continue;
    const title = typeof s.title === 'string' && s.title !== 'none' ? await rt.contentBody(s.title).catch(() => null) : null;
    todos.push({ id, label: labelOf(s.account), status: s.status, title, due: s.due, reply: s.reply });
  }
  // A proposed draft waits for the owner's signed approval (IAC2): its intent is escalated and not yet run.
  const approvals = [];
  for (const r of rt.store.db.prepare("SELECT intent_id, instance_id FROM pr_outbox WHERE kind = 'gmail.createDraft' AND status IN ('pending', 'inflight') ORDER BY intent_id").all()) {
    if (await rt.escalationOf(r.intent_id).catch(() => null)) approvals.push({ intent: r.intent_id, todo: r.instance_id });
  }
  return { at: now.toISOString(), accounts: perAccount, todos, held, approvals };
}

/** The digest as text: a line for each account, each open to-do, and each message that needs the owner's eyes. */
export function formatDigest(model, { drafts }) {
  const out = [`Inbox digest at ${model.at}; ${drafts ? 'drafts are allowed' : 'read-only: no draft is proposed'}.`];
  for (const [label, c] of Object.entries(model.accounts)) {
    out.push(`  ${label}: ${c.messages} message(s): ${c.actionable} to do, ${c.filed} filed, ${c.held} held for you, ${c.pending} being read`);
  }
  if (model.todos.length) {
    out.push('To do:');
    for (const t of model.todos) out.push(`  [${t.label}] ${t.title ?? '(no title yet)'}${t.status !== 'Open' ? ` [${t.status.toLowerCase()}]` : ''}${t.due && t.due !== 'Unstated' ? ` (due: ${t.due})` : ''}${t.reply ? ', a reply is wanted' : ''}  <${t.id}>`);
  }
  if (model.held.length) {
    out.push('Held for you (the assistant was unsure, or the model could not be asked):');
    for (const h of model.held) out.push(`  [${h.label}] ${h.subject || '(no subject)'}${h.from ? ` from ${h.from}` : ''}`);
  }
  if (model.approvals?.length) {
    out.push('Waiting for your approval (sign it with poly approve, README.md, step 8):');
    for (const a of model.approvals) out.push(`  the draft of ${a.todo}: intent ${a.intent}`);
  }
  return out.join('\n');
}
