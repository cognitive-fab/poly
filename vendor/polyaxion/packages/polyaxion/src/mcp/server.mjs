// A minimal MCP server over stdio (NDJSON JSON-RPC 2.0), no SDK dependency.
// Handles initialize / ping / tools/list / tools/call. Diagnostics go to
// stderr only — stdout is the wire.
import { createInterface } from 'node:readline';

export const PROTOCOL_VERSION = '2025-06-18';

/**
 * @param {object} opts {name, version, tools: [{name, description, inputSchema, annotations?, handler(args) -> any|Promise}], input?, output?, instructions?}
 */
export function serve(opts) {
  const tools = new Map(opts.tools.map((t) => [t.name, t]));
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const write = (msg) => output.write(JSON.stringify(msg) + '\n');
  const rl = createInterface({ input, crlfDelay: Infinity });

  // Requests are handled in arrival order: a verify or recall that follows a
  // merge on the wire must observe that merge.
  let chain = Promise.resolve();
  rl.on('line', (line) => { chain = chain.then(() => handle(line)).catch(() => {}); });
  async function handle(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    if (msg.id === undefined) return; // notification
    const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => write({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    try {
      switch (msg.method) {
        case 'initialize':
          return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: opts.name, version: opts.version }, instructions: opts.instructions ?? undefined });
        case 'ping': return reply({});
        case 'tools/list':
          return reply({ tools: [...tools.values()].map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
        case 'tools/call': {
          const name = msg.params?.name;
          const t = tools.get(name);
          if (!t) return fail(-32602, `unknown tool '${name}'`);
          const args = msg.params?.arguments ?? {};
          for (const r of t.inputSchema?.required ?? []) if (args[r] === undefined) return fail(-32602, `missing required argument '${r}'`);
          try {
            const result = await t.handler(args);
            const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            return reply({ content: [{ type: 'text', text }], structuredContent: typeof result === 'object' && result !== null && !Array.isArray(result) ? result : undefined });
          } catch (e) {
            // A tool failure is a result the model must see, not a protocol error.
            return reply({ content: [{ type: 'text', text: `${e.name ?? 'Error'}: ${e.message}` }], isError: true });
          }
        }
        default: return fail(-32601, `method not found: ${msg.method}`);
      }
    } catch (e) {
      process.stderr.write(`[polyaxion mcp] ${e.stack || e}\n`);
      fail(-32603, 'internal error');
    }
  }
  return { close: () => rl.close() };
}
