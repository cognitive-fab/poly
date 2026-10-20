// DF15 item 5: the run log of `launch.mjs --log <file>`. One line each, `<ISO time> <text>`, appended to a file the owner keeps (the run's own
// folder is removed at `quit`). The sources are the failure lines (no key, no body, no customer text), the spend lines and the status of the
// presenter's prompt, whose `stripe.reply` list (the Stripe mock-up's WhatsApp sink) is left out, so no line holds a customer's text.
import { appendFileSync } from 'node:fs';

export function openRunLog(file, { now = () => Date.now() } = {}) {
  const stamp = () => new Date(now()).toISOString();
  return {
    line(text) { appendFileSync(file, `${stamp()} ${String(text).replace(/\r?\n/g, ' ')}\n`); },
    status(object) {
      const copy = { ...object, ...(object?.stripe && typeof object.stripe === 'object' ? { stripe: Object.fromEntries(Object.entries(object.stripe).filter(([k]) => k !== 'reply')) } : {}) };
      appendFileSync(file, `${stamp()} status ${JSON.stringify(copy)}\n`);
    },
    close() {},
  };
}
