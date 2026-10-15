// DF2: the presenter terminal's staff panel. The concierge tells its staff of each refund the gate escalates by a post on its staff
// channel (examples/concierge/host/notice.mjs); in the demo that post is not sent to Slack but shown here, on the presenter's side
// only. The feed holds what was posted and tells whoever listens. It approves nothing: a person approves with `poly approve`.

export function createStaffFeed({ now = () => Date.now() } = {}) {
  const items = [];
  const listeners = new Set();
  return {
    post(text) {
      const entry = { seq: items.length + 1, at: now(), text };
      items.push(entry);
      for (const fn of listeners) fn(entry);
      return entry;
    },
    entries: () => items.map((e) => ({ ...e })),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
