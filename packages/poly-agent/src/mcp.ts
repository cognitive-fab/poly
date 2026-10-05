// `poly mcp` (PF9.1, PT14, S167, M6 step 6): the command registry served as MCP tools over stdio, newline-delimited
// JSON-RPC 2.0, with no SDK, as polyflow's own server does. Each tool's inputSchema and outputSchema are the
// registry's, published under schemas/; a result is returned as structuredContent and as its JSON text. Commands with
// no tool name (a person's key: approve, accept, admit-witness) are not served. The server knows no host: an agent
// harness reaches it through its own MCP client, configured by a host adapter (adapters/).
import { createInterface } from 'node:readline';
import { COMMANDS, type Command } from '@poly/check';
import { claudeCliProvider, newCommand, samplingProvider, type Provider } from '@poly/new';

/**
 * The agent's commands: the registry's, and `new` (S169), which poly-new defines since it is the only package that may
 * call a model. Its provider is the host's: the client's model by MCP sampling when the client offers it, Claude Code
 * headless under the user's login otherwise.
 */
export function agentCommands(providerOf: () => Provider = () => claudeCliProvider()): Command[] {
  return [...COMMANDS, newCommand(providerOf)];
}

const PROTOCOL_VERSION = '2025-06-18';

interface Message { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }

export interface McpOptions { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; version?: string }

/** The tools the server lists: one per agent command that has a tool name. */
export function mcpTools(commands: Command[] = agentCommands()): { name: string; description: string; inputSchema: unknown; outputSchema: unknown }[] {
  return commands.filter((c) => c.mcp).map((c) => ({ name: c.mcp!, description: c.summary, inputSchema: c.input, outputSchema: c.output }));
}

export function serveMcp(opts: McpOptions = {}): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  // S169: a request the server sends the client (sampling/createMessage), answered out of the queue of calls.
  let sampling = false;
  let nextId = 1;
  const waiting = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  const ask = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    stdout.write(JSON.stringify({ jsonrpc: '2.0', id: `poly-${id}`, method, params }) + '\n');
  });
  const sample = async (prompt: string): Promise<string> => {
    const r = await ask('sampling/createMessage', { messages: [{ role: 'user', content: { type: 'text', text: prompt } }], maxTokens: 8000, systemPrompt: 'You write poly modules. Answer with the module only, in a ```poly block.' });
    return String(r?.content?.text ?? '');
  };
  const commands = agentCommands(() => (sampling ? samplingProvider(sample) : claudeCliProvider()));
  const byTool = new Map<string, Command>(commands.filter((c) => c.mcp).map((c) => [c.mcp!, c]));
  const write = (m: unknown) => stdout.write(JSON.stringify(m) + '\n');
  const reply = (id: Message['id'], result: unknown) => write({ jsonrpc: '2.0', id, result });
  const fail = (id: Message['id'], code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = async (msg: Message) => {
    const { id, method, params } = msg;
    // A notification has no id and is never answered.
    if (id === undefined || id === null) return;
    switch (method) {
      case 'initialize':
        sampling = Boolean((params as { capabilities?: { sampling?: unknown } } | undefined)?.capabilities?.sampling);
        return reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'poly', version: opts.version ?? '0.0.0' } });
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: mcpTools(commands) });
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
      // The client's answer to a request of the server's: settled at once, not queued behind the call that waits on it.
      const answer = msg as Message & { result?: unknown; error?: { message?: string } };
      if (!answer.method) {
        // A response is never answered (JSON-RPC 2.0, review B-F4); one to a request of the server's settles it.
        if (typeof answer.id === 'string' && answer.id.startsWith('poly-')) {
          const w = waiting.get(Number(answer.id.slice(5)));
          waiting.delete(Number(answer.id.slice(5)));
          if (answer.error) w?.reject(new Error(answer.error.message ?? 'the client refused')); else w?.resolve(answer.result);
        }
        return;
      }
      // Review B-F3: a ping is answered at once, even while a call waits on the client's model.
      if (msg.method === 'ping' && msg.id !== undefined && msg.id !== null) { reply(msg.id, {}); return; }
      chain = chain.then(() => handle(msg)).then(() => undefined, (e) => { process.stderr.write(`[poly mcp] ${(e as Error).stack ?? e}\n`); });
    });
    rl.on('close', () => { void chain.then(resolve); });
  });
}
