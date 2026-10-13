// plan-e3.md E3.9: a local stand-in for the Anthropic Messages API, for the driver's tests. It listens on the loopback only, records
// every request it receives (headers and parsed body), and answers each from a script: a function of the request and its number.
// No key, no network, no spend. The key in the tests is a canary string, and the server keeps the headers it saw so that a test
// can show that the key reached the one header it belongs in and nowhere else.
import http from 'node:http';

export const CANARY_KEY = 'sk-ant-api03-CANARYCANARYCANARY0123456789abcdefghij';

/** An API answer: content blocks, a stop reason and the usage it reports. */
export const answer = ({ blocks = [{ type: 'text', text: 'ok' }], stop = 'end_turn', usage = {} } = {}) => ({
  status: 200,
  body: { id: 'msg_test', type: 'message', role: 'assistant', model: 'test', content: blocks, stop_reason: stop, usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage } },
});
export const toolUse = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ type: 'tool_use', id, name, input });
export const failure = (status, message) => ({ status, body: { type: 'error', error: { type: 'api_error', message } } });

/** @param {(req: { n: number, headers: object, body: object }) => { status: number, body: object } | Promise<object>} script */
export async function fakeApi(script) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      // not JSON: recorded as null
    }
    const entry = { n: seen.length + 1, method: req.method, url: req.url, headers: { ...req.headers }, body, raw };
    seen.push(entry);
    const out = await script(entry);
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}
