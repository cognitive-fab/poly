// plan-ex.md E2: the inbox assistant's host. It holds no rule (IT7): it syncs each mailbox through the Gmail source,
// creates one Message per new item at msg:<account label>:<message id> (IT2.3), announces the items once their
// instances exist, and opens a thread's Todo when a Message has recorded that it is actionable. Each of those is a fact a
// machine or the source recorded; the host forwards it. A creation refused because the instance exists is the
// exactly-once rule doing its work, not an error (IAC1).

/** The instance ids the host names, from the source's item and thread keys, so no id holds an address (S191). */
export const messageId = (item) => `msg:${item.id.replace('/', ':')}`;
export const todoId = (thread) => `todo:${thread.replace('/', ':')}`;

/**
 * One pass over one account: sync the mailbox, create a Message for each fresh item, and announce the items whose
 * instance exists. A crash between the creation and the announcement reports the item again on the next pass, and its
 * creation is refused then, so it is announced and nothing is made twice. Returns the Messages this pass created,
 * each with its thread key, and whether the source fell back from an expired cursor.
 */
export async function syncAccount(rt, source, account) {
  const report = await source.sync(account.owner);
  const created = [];
  const exist = [];
  for (const item of report.fresh) {
    const id = messageId(item);
    // An instance that exists was made by an earlier pass that crashed before announcing (IT2.3); the kernel would
    // create nothing for it either, and the host does not ask.
    if (!(await rt.getState(id).catch(() => null))) {
      await rt.create('inbox.Message', { id, creation: { action: 'Arrived', data: { owner: account.owner, item: item.id } } });
      created.push({ id, thread: item.thread });
    }
    exist.push(item.id);
  }
  await source.announce(exist);
  return { created, fallback: report.fallback };
}

/**
 * Opens the Todo of each actionable Message's thread, once: a Todo is one per thread (IT5), so a second actionable
 * message of a thread finds it open and leaves it. Each message comes with its thread key, as syncAccount gives it.
 * Returns the to-dos opened by this call.
 */
export async function openTodos(rt, messages) {
  const opened = [];
  for (const { id, thread } of messages) {
    const s = (await rt.getState(id)).state;
    if (s.seen !== 'Actionable') continue;
    const todo = todoId(thread);
    if (await rt.getState(todo).catch(() => null)) continue;
    await rt.create('inbox.Todo', { id: todo, creation: { action: 'Open', data: { owner: s.account, at: thread, answer: s.reply } } });
    opened.push(todo);
  }
  return opened;
}
