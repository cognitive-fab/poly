// `poly mcp` (PF9.1, PT14, S167, M6 step 6): the command registry served as MCP tools over stdio, newline-delimited
// JSON-RPC 2.0, with no SDK, as polyflow's own server does. Each tool's inputSchema and outputSchema are the
// registry's, published under schemas/; a result is returned as structuredContent and as its JSON text. Commands with
// no tool name (a person's key: approve, accept, admit-witness) are not served. The server knows no host: an agent
// harness reaches it through its own MCP client, configured by a host adapter (adapters/).
import { createInterface } from 'node:readline';
import { COMMANDS, type Command } from '@poly/check';

const PROTOCOL_VERSION = '2025-06-18';

interface Message { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }

export interface McpOptions { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; version?: string }

/** The tools the server lists: one per registry command that has a tool name. */
export function mcpTools(): { name: string; description: string; inputSchema: unknown; outputSchema: unknown }[] {
  return COMMANDS.filter((c) => c.mcp).map((c) => ({ name: c.mcp!, description: c.summary, inputSchema: c.input, outputSchema: c.output }));
}

export function serveMcp(opts: McpOptions = {}): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const byTool = new Map<string, Command>(COMMANDS.filter((c) => c.mcp).map((c) => [c.mcp!, c]));
  const write = (m: unknown) => stdout.write(JSON.stringify(m) + '\n');
  const reply = (id: Message['id'], result: unknown) => write({ jsonrpc: '2.0', id, result });
  const fail = (id: Message['id'], code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = async (msg: Message) => {
    const { id, method, params } = msg;
    // A notification has no id and is never answered.
    if (id === undefined || id === null) return;
    switch (method) {
      case 'initialize':
        return reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'poly', version: opts.version ?? '0.0.0' } });
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: mcpTools() });
      case 'tools/call': {
        const name = String(params?.name ?? '');
        const cmd = byTool.get(name);
        if (!cmd) return fail(id, -32602, `unknown tool ${name}`);
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const o = await cmd.run(args);
          return reply(id, { content: [{ type: 'text', text: JSON.stringify(o.result) }], structuredContent: o.result, isError: false });
        } catch (e) {
          // A usage error or a refusal is the tool's answer, which the model can act on; it never crashes the server.
          return reply(id, { content: [{ type: 'text', text: `${name}: ${(e as Error).message}` }], isError: true });
        }
      }
      default:
        return fail(id, -32601, `method not found: ${method}`);
    }
  };

  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin });
    // One call at a time, in arrival order: a check writes .poly/report.json, which witness and fix then read.
    let chain: Promise<void> = Promise.resolve();
    rl.on('line', (line) => {
      let msg: Message;
      try { msg = JSON.parse(line) as Message; } catch { fail(null, -32700, 'parse error'); return; }
      chain = chain.then(() => handle(msg)).then(() => undefined, (e) => { process.stderr.write(`[poly mcp] ${(e as Error).stack ?? e}\n`); });
    });
    rl.on('close', () => { void chain.then(resolve); });
  });
}
