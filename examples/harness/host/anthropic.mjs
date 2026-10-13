// plan-e3.md E3.9: the model client of the live run. A small client of the Anthropic Messages API: no library, one function, the
// key read from the environment at the moment of each call and never held anywhere else.
//
// The key. It is read from process.env.ANTHROPIC_API_KEY (or the getter given) inside call(), put in one request header, and
// not kept: not in a field of this object, not in the log, not in an error message, not in a returned value. Every string that
// leaves this file (an error, a log line) passes through scrub(), which replaces the key's text, wherever it appears, by [key].
// The log (one JSON line a call) holds the model, the kind of call, the status, the stop reason, the usage by class, the cost in
// micro-units, the latency and the size of the request, and never a header or a body.
//
// Cost. The cost of a call is computed as poly computes it (PS18.3): ceil(sum of tokens of each class times that class's price per
// million) over the classes the API reports, from the price table of the model. The classes are input, output, cache_write
// and cache_read, the names of the tables. poly's own charge, from the usage a provider reports, is what the budget gate uses; this
// figure is the driver's check on it, logged beside each call.
//
// The network. fetchImpl is a parameter, so that the tests give it a function that talks to a local server; the driver never
// takes a base URL from the environment or from the model's output.
import { appendFileSync } from 'node:fs';

const RETRY_STATUS = new Set([429, 500, 502, 503, 529]);
const API_VERSION = '2023-06-01';

/** ceil(sum of n x price / 1e6) over the classes of a usage report, at the table's prices (PS18.3). A class with no price takes the highest. */
export function costOf(usage, table) {
  const p = table.perMillionTokens;
  const highest = Math.max(...Object.values(p));
  let micro = 0;
  for (const [k, n] of Object.entries(usage)) micro += n * (p[k] ?? highest);
  return Math.ceil(micro / 1e6);
}

/** The messages of a request: consecutive messages of one role are joined (the API takes alternating turns); the last carries the cache breakpoint. */
export function toApiMessages(messages, { cacheLast = true } = {}) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const text = String(m.text);
    if (text === '') continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content[0].text += `\n${text}`;
    else out.push({ role, content: [{ type: 'text', text }] });
  }
  if (cacheLast && out.length) out[out.length - 1].content[out[out.length - 1].content.length - 1].cache_control = { type: 'ephemeral' };
  return out;
}

/**
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, getKey?: () => string | undefined, tables: Record<string, object>,
 *   logPath?: string | null, retries?: number, backoffMs?: number, timeoutMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number }} options
 *   tables maps a model id to its price table (prices-live/*.json)
 */
export function createAnthropic({ fetchImpl = globalThis.fetch, baseUrl = 'https://api.anthropic.com', getKey = () => process.env.ANTHROPIC_API_KEY, tables, logPath = null, retries = 2, backoffMs = 1000, timeoutMs = 180_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  let n = 0;
  const totals = { calls: 0, microUsd: 0, byKind: {} };
  // every string that leaves this file passes through here
  const scrub = (s, key) => {
    let t = String(s);
    if (key) t = t.split(key).join('[key]');
    return t.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[key]');
  };
  const log = (entry) => {
    if (!logPath) return;
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  };

  /**
   * @param {{ kind: string, model: string, system: string, messages: { role: string, text: string }[], tools?: object[], maxTokens: number }} req
   * @returns {Promise<{ text: string, blocks: object[], stopReason: string, usage: Record<string, number>, microUsd: number, latencyMs: number }>}
   */
  async function call({ kind, model, system, messages, tools, maxTokens }) {
    const table = tables[model];
    if (!table) throw new Error(`no price table for the model ${model}`);
    const key = getKey();
    if (typeof key !== 'string' || key === '') throw new Error('the key is not set in the environment (ANTHROPIC_API_KEY)');
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: toApiMessages(messages),
      ...(tools?.length ? { tools } : {}),
    });
    n += 1;
    const id = n;
    for (let attempt = 0; ; attempt += 1) {
      const t0 = now();
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION }, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        if (attempt < retries) {
          await sleep(backoffMs * 2 ** attempt);
          continue;
        }
        log({ n: id, kind, model, status: 'network-error', attempt });
        throw new Error(scrub(`the request failed: ${e.message}`, key));
      }
      const text = await res.text();
      if (!res.ok) {
        if (RETRY_STATUS.has(res.status) && attempt < retries) {
          await sleep(backoffMs * 2 ** attempt);
          continue;
        }
        let message = text.slice(0, 300);
        try {
          message = JSON.parse(text).error?.message ?? message;
        } catch {
          // not JSON: the first 300 characters stand
        }
        log({ n: id, kind, model, status: res.status, attempt });
        throw new Error(scrub(`the API answered ${res.status}: ${message}`, key));
      }
      const j = JSON.parse(text);
      const u = j.usage ?? {};
      const usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0 };
      const microUsd = costOf(usage, table);
      const latencyMs = now() - t0;
      totals.calls += 1;
      totals.microUsd += microUsd;
      totals.byKind[kind] = (totals.byKind[kind] ?? 0) + microUsd;
      const blocks = Array.isArray(j.content) ? j.content : [];
      log({ n: id, kind, model, status: res.status, attempt, stopReason: j.stop_reason, usage, microUsd, latencyMs, requestBytes: body.length, toolUses: blocks.filter((b) => b.type === 'tool_use').length });
      return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), blocks, stopReason: j.stop_reason, usage, microUsd, latencyMs };
    }
  }
  return { call, scrub, totals };
}
