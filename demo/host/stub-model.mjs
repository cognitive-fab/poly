// DF10 item 3: the stub model. It stands where the model provider's API stands for the live providers, answers locally from the
// request alone, opens no socket and reads no key. It exists to prove the launcher (the cap, the meter, the spend line) with no key and
// no network. It says nothing about a model.
import { API_URL } from '../../examples/inbox/host/providers.mjs';
import { TASKS } from './live-providers.mjs';

const SENTENCE = 'Thank you for your message. A member of staff will follow up.';

const noRoute = (url) => Object.assign(new Error(`no route: the stub model answers the Messages URL alone, not ${url}`), { code: 'ENOROUTE' });

/** The task of a request: the sentence of TASKS that the system or user text holds, or null. */
function taskOf(text) {
  for (const name of ['classify', 'amount', 'answer', 'reply']) if (text.includes(TASKS[name])) return name;
  return null;
}

/** The customer's text: inside the message tags of the user turn, else the whole user turn. */
function customerText(user) {
  const m = /<message>\n([\s\S]*?)\n<\/message>/.exec(user);
  return m ? m[1] : user;
}

export function stubTransport() {
  return {
    async request(q) {
      if (q.method !== 'POST' || q.url !== API_URL) throw noRoute(q.url);
      let body;
      try { body = JSON.parse(q.body); } catch { return { status: 400, headers: {}, body: JSON.stringify({ error: { type: 'invalid_request_error' } }) }; }
      const system = typeof body.system === 'string' ? body.system : '';
      const user = (body.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const task = taskOf(`${system}\n${user}`);
      const text = customerText(user);
      let answer;
      if (task === 'classify') answer = { answer: /refund|money back/i.test(text) ? 'Refund' : /order|where|status/i.test(text) ? 'Status' : 'Other' };
      else if (task === 'amount') {
        const id = /<order id="([^"]+)">/.exec(user)?.[1];
        answer = { value: Number(/\d+/.exec(text)?.[0] ?? 0), cites: id ? [id] : [] };
      } else answer = { answer: SENTENCE, cites: [] };
      const out = { type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: Math.ceil((system.length + user.length) / 4), output_tokens: 20 } };
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) };
    },
  };
}
