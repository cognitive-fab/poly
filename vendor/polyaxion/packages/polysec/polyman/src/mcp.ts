// MCP-proxy adapter — put polyman's gate in front of ANY MCP server (the §4.2
// gateway / man-in-the-middle deployment of docs/polyman-broker-spec.md). polyman
// presents the upstream's tool surface, gates every `tools/call` through
// `mediate()`, forwards allowed calls, and returns an MCP error result on a deny.
// Works in front of any MCP server — e.g. a spec-driven capability server — so
// the gate lives OUTSIDE the agent (more tamper-resistant than the in-process
// Vercel adapter).
//
// Structurally typed against the MCP tools/list + tools/call shapes, so polyman
// does not hard-depend on an MCP SDK; wire it to @modelcontextprotocol/sdk's
// Client/Server transports at the edges.
import type { Polyman, ToolCall } from './types.ts';

export interface McpToolResult {
  content: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

/** The minimal upstream MCP surface polyman proxies to. */
export interface McpUpstream {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(req: { name: string; arguments?: unknown }): Promise<McpToolResult>;
}

export interface WrapMcpOptions {
  /** Per-session taint key — one MCP connection = one session (broker spec §4.2). */
  session: string;
}

/**
 * Wrap an upstream MCP server with polyman's gate. `tools/list` advertises only
 * the tools the policy actually labels — an unlabeled tool is default-denied at
 * call time, so exposing it in the listing would only invite a call the gate
 * refuses (default-deny consistency). `tools/call` is mediated — a
 * trifecta-completing call is denied (an MCP `isError` result with the
 * contract-anchored reason) BEFORE it reaches upstream.
 */
export function wrapMcp(pm: Polyman, upstream: McpUpstream, opts: WrapMcpOptions): McpUpstream {
  return {
    async listTools() {
      const { tools, ...rest } = await upstream.listTools();
      return { ...rest, tools: tools.filter((t) => pm.mediates(t.name)) };
    },
    async callTool(req) {
      const call: ToolCall = { tool: req.name, args: req.arguments };
      try {
        return (await pm.mediate(opts.session, call, () => upstream.callTool(req))) as McpToolResult;
      } catch (e) {
        const pol = (e as { polyman?: { decision?: string; reason?: string; region?: string } }).polyman;
        if (pol && pol.decision === 'reject') {
          return {
            content: [{ type: 'text', text: `blocked by policy: ${pol.reason}` }],
            isError: true,
            _polyman: pol,
          };
        }
        throw e;
      }
    },
  };
}
