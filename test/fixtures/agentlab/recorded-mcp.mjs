// A recorded MCP server for the tests (P3): the Lab's customer-records server, four tools over 50 made-up customers.
// `export_all_customers` exists but the gateway hides it, so tools/list names three. It is an HttpTransport (the same
// shape as poly-io's https transport), so nothing leaves the machine. Options seed the faults the tests need.
import { readFileSync } from 'node:fs';

const CUSTOMERS = JSON.parse(readFileSync(new URL('./customers.json', import.meta.url), 'utf8'));
// The Desk changes phone and address directly; an email change goes through a person's approval, which is the Desk's rule and not the server's.
const UPDATABLE = ['phone', 'address', 'email'];
const SCHEMA = { type: 'object' };
const LISTED = [
  { name: 'find_customers', description: 'Find customers by a text in name, email or city (at most 10).', inputSchema: SCHEMA },
  { name: 'read_customer', description: 'One customer by id.', inputSchema: SCHEMA },
  { name: 'update_customer', description: 'Change one field (phone, address or email) of a customer.', inputSchema: SCHEMA },
];
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
// A find_customers result is { "customers": [...] }, as the text of the one content part and as structuredContent. The host
// counts the customers of a read as the length of that array: parse McpOutcome.text (or read McpOutcome.structured) and take
// `customers.length`. A read_customer result is the bare customer, which counts as one.
const found = (customers) => ({ ...text(JSON.stringify({ customers })), structuredContent: { customers } });

/**
 * opts.status: answer every request with this status (a 403 from the gateway, a 502);
 * opts.callStatus: answer only tools/call with this status;
 * opts.emptyCall: answer tools/call with a JSON-RPC message that has neither result nor error;
 * opts.version: the protocol version initialize answers with;
 * opts.dropAfterSend: throw after the request is recorded, as a connection lost once the request is sent;
 * opts.sse: answer requests as a single-event text/event-stream;
 * opts.initializedStatus: answer only notifications/initialized with this status (item 2 of the review of 2026-11-02);
 * opts.initializedDrop: throw on notifications/initialized after it is recorded, as a request that gets no answer;
 * opts.callResult: answer tools/call with this JSON-RPC result, whatever the tool (item 3 of the review of 2026-11-02).
 */
export function recordedMcp(opts = {}) {
  const customers = CUSTOMERS.map((c) => ({ ...c }));
  const requests = [];
  const sessionId = 'sess-0123456789abcdef';
  const reply = (id, result) => (opts.sse
    ? { status: 200, headers: { 'content-type': 'text/event-stream' }, body: `id: 1\ndata:\n\nid: 2\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n` }
    : { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });

  function call(name, a) {
    if (name === 'find_customers') {
      const q = String(a.query ?? '').toLowerCase();
      const hits = customers.filter((c) => [c.name, c.email, c.city].some((v) => v.toLowerCase().includes(q))).slice(0, 10);
      return found(hits);
    }
    if (name === 'read_customer') {
      const c = customers.find((x) => x.id === a.id);
      return c ? text(JSON.stringify(c)) : text(`no customer ${a.id}`, true);
    }
    if (name === 'update_customer') {
      const c = customers.find((x) => x.id === a.id);
      if (!c) return text(`no customer ${a.id}`, true);
      if (!UPDATABLE.includes(a.field)) return text(`no field ${a.field}`, true);
      if (typeof a.value !== 'string' || a.value === '') return text(`no value for ${a.field}`, true);
      c[a.field] = a.value;
      return text(JSON.stringify(c));
    }
    // The gateway hides export_all_customers; the server behind it still has the tool.
    if (name === 'export_all_customers') return text(JSON.stringify(customers));
    return null;
  }

  return {
    requests,
    customers,
    transport: {
      async request(r) {
        const message = JSON.parse(r.body);
        requests.push({ headers: r.headers, message });
        if (opts.dropAfterSend && message.method === 'tools/call') throw new Error('socket hang up');
        if (opts.initializedDrop && message.method === 'notifications/initialized') throw new Error('socket hang up');
        if (opts.initializedStatus && message.method === 'notifications/initialized') return { status: opts.initializedStatus, headers: {}, body: '' };
        if (opts.emptyCall && message.method === 'tools/call') return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: message.id }) };
        if (opts.callStatus && message.method === 'tools/call') return { status: opts.callStatus, headers: {}, body: '' };
        if (opts.status) return { status: opts.status, headers: {}, body: '' };
        if (message.method === 'initialize') {
          const out = reply(message.id, { protocolVersion: opts.version ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'customer-records', version: '1' } });
          out.headers['mcp-session-id'] = sessionId;
          return out;
        }
        if (r.headers['mcp-session-id'] !== sessionId) return { status: 400, headers: {}, body: '' };
        if (message.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' };
        if (message.method === 'tools/list') return reply(message.id, { tools: LISTED });
        if (message.method === 'tools/call' && opts.callResult) return reply(message.id, opts.callResult);
        if (message.method === 'tools/call') {
          const result = call(message.params.name, message.params.arguments ?? {});
          return result
            ? reply(message.id, result)
            : { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown tool' } }) };
        }
        return { status: 400, headers: {}, body: '' };
      },
    },
  };
}
