// A minimal MCP stdio server — newline-delimited JSON-RPC 2.0 over stdin/stdout.
//
// Hand-rolled on purpose: polyflow ships with one runtime dependency, and this
// is the whole protocol we need (initialize, tools/list, tools/call, ping).
// stdout is the transport, so everything diagnostic goes to stderr.

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const PROTOCOL_VERSION = '2025-06-18';

/**
 * A required argument that is absent. A model that forgets one should be told which field it forgot — without this
 * the omission travels down into the store and comes back as a driver error
 * ("cannot be bound to SQLite parameter 1"), which names nothing the model can
 * act on. Types and sizes are checked by argumentProblem, below; the meaning
 * of a value is left to the tool, which knows its own domain.
 */
function missingArgs(tool, args) {
  const required = tool.inputSchema?.required ?? [];
  return required.filter((k) => args[k] === undefined || args[k] === null);
}

/** Limits on what a model can send (P9 security review SEC-MCP1). */
const LIMITS = Object.freeze({ argBytes: 256 * 1024, stringLength: 8192, depth: 32 });

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const depthOf = (v) => (v && typeof v === 'object' ? 1 + Math.max(0, ...Object.values(v).map(depthOf)) : 0);

/**
 * Check arguments against the tool's inputSchema, as far as its vocabulary
 * goes: the type of each declared property, a string's `maxLength` (a
 * default when none is declared), an array's `maxItems`, and the size and
 * depth of the whole. Returns what is wrong, or null. An absent or null
 * optional argument is left to the tool's default.
 */
export function argumentProblem(tool, args, limits = LIMITS) {
  if (typeOf(args) !== 'object') return 'arguments must be an object';
  let size;
  try { size = Buffer.byteLength(JSON.stringify(args)); } catch { return 'arguments are not JSON'; }
  if (size > limits.argBytes) return `arguments are ${size} bytes; the limit is ${limits.argBytes}`;
  if (depthOf(args) > limits.depth) return `arguments nest deeper than ${limits.depth} levels`;
  for (const [k, schema] of Object.entries(tool.inputSchema?.properties ?? {})) {
    const v = args[k];
    if (v === undefined || v === null || !schema?.type) continue;
    const t = typeOf(v);
    const ok = schema.type === t || (schema.type === 'integer' && Number.isInteger(v)) || (schema.type === 'number' && t === 'number' && Number.isFinite(v));
    if (!ok || (t === 'number' && !Number.isFinite(v))) return `'${k}' must be ${schema.type === 'object' || schema.type === 'array' || schema.type === 'integer' ? 'an' : 'a'} ${schema.type}, not ${t}`;
    if (t === 'string' && v.length > (schema.maxLength ?? limits.stringLength)) return `'${k}' is longer than ${schema.maxLength ?? limits.stringLength} characters`;
    if (t === 'array' && schema.maxItems !== undefined && v.length > schema.maxItems) return `'${k}' has more than ${schema.maxItems} items`;
  }
  return null;
}

/**
 * What a model is told when a tool throws. Its own errors (`expected`, or a
 * plain Error, which is how the tools say "unknown instance") pass through.
 * Anything else — a driver, a gRPC status, a network error — names hosts,
 * namespaces and ids the model has no business with: it gets a generic
 * message and a reference, and the detail goes to stderr under that reference.
 */
export function errorText(err, log = (line) => process.stderr.write(`${line}\n`)) {
  const own = err instanceof Error && (err.expected === true || (Object.getPrototypeOf(err) === Error.prototype && err.code === undefined && err.cause === undefined));
  if (own) return String(err.message);
  const ref = randomUUID().slice(0, 8);
  log(`[mcp] internal error ${ref}: ${err?.stack ?? err}`);
  return `internal error (ref ${ref}); the operator's log has the detail`;
}

export function serve({ name, version, tools, stdin = process.stdin, stdout = process.stdout, limits = LIMITS }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const write = (msg) => stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = async (msg) => {
    const { id, method, params } = msg;
    // Notifications carry no id and are never answered.
    if (id === undefined || id === null) return;

    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
        });
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, {
          tools: tools.map(({ name: n, description, inputSchema, outputSchema, annotations }) => ({
            name: n, description, inputSchema,
            ...(outputSchema ? { outputSchema } : {}),
            ...(annotations ? { annotations } : {}),
          })),
        });
      case 'tools/call': {
        const tool = byName.get(params?.name);
        if (!tool) return fail(id, -32602, `unknown tool '${params?.name}'`);
        const args = params.arguments ?? {};
        const problem = argumentProblem(tool, args, limits);
        if (problem) return fail(id, -32602, `${tool.name}: ${problem} — see its inputSchema`);
        const missing = missingArgs(tool, args);
        if (missing.length) {
          return fail(id, -32602,
            `${tool.name} needs ${missing.map((m) => `'${m}'`).join(', ')} — see its inputSchema`);
        }
        try {
          const result = await tool.handler(args);
          return reply(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          });
        } catch (err) {
          // A tool failure is a RESULT the model must see and reason about, not
          // a protocol error that kills the call.
          return reply(id, {
            content: [{ type: 'text', text: errorText(err) }],
            isError: true,
          });
        }
      }
      default:
        return fail(id, -32601, `method not found: ${method}`);
    }
  };

  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return fail(null, -32700, 'parse error'); }
    handle(msg).catch((err) => fail(msg.id ?? null, -32603, errorText(err)));
  });
  return rl;
}
