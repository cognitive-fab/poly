// Vercel AI SDK adapter — wire a Polyman into `generateText` / `streamText` /
// `Agent` as an in-line, default-deny tool gate.
//
//   const res = await generateText({ model, tools, ...wrapVercel(pm, { session }) });
//
// It maps polyman's two phases onto the SDK's native hooks:
//   • gate   → `toolApproval` (runs BEFORE every SDK-executed tool; can deny)
//   • settle → `onStepEnd`    (runs AFTER a step; applies response-time taint)
//
// Structural types below are verified against ai@7.0.34
// (GenericToolApprovalFunction / ToolApprovalStatus / StaticToolResult) so
// polyman does NOT hard-depend on `ai` — it is an OPTIONAL PEER dependency; a
// non-Vercel user installs polyman with no `ai` present.
import type { Polyman, ToolCall } from './types.ts';

// ── minimal ai@7 surface (structural) ────────────────────────────────────────
export type ToolApprovalStatus =
  | undefined | 'not-applicable' | 'approved' | 'denied' | 'user-approval'
  | { type: 'not-applicable' }
  | { type: 'approved'; reason?: string }
  | { type: 'denied'; reason?: string }
  | { type: 'user-approval' };

interface ApprovalOptions {
  toolCall: { toolName: string; input: unknown; providerExecuted?: boolean };
  tools?: Record<string, unknown> | undefined;
}
export type ToolApprovalFunction = (options: ApprovalOptions) => Promise<ToolApprovalStatus>;

interface StepLike {
  toolResults?: Array<{ toolName: string; output?: unknown; providerExecuted?: boolean }>;
}
export type OnStepEnd = (step: StepLike) => Promise<void>;

// ── wrapVercel ────────────────────────────────────────────────────────────────
export interface WrapVercelOptions {
  /** The per-session taint key (e.g. the conversation id). One session, one record. */
  session: string;
  /**
   * Optionally pass your tool set so polyman refuses to run if any tool is
   * provider-executed (those BYPASS toolApproval — polyman cannot mediate them).
   * Complete mediation or it does not count (AS-5).
   */
  tools?: Record<string, unknown>;
  /** On a policy denial: 'deny' (default, block the call) or 'user-approval' (escalate to a human). */
  onDeny?: 'deny' | 'user-approval';
  /** Called when a provider-executed result is observed (a call that slipped past the gate). */
  onUnmediated?: (toolName: string) => void;
}

export interface VercelHooks {
  toolApproval: ToolApprovalFunction;
  onStepEnd: OnStepEnd;
}

export function wrapVercel(pm: Polyman, opts: WrapVercelOptions): VercelHooks {
  const { session } = opts;
  if (opts.tools) assertMediatable(opts.tools);

  const toolApproval: ToolApprovalFunction = async ({ toolCall }) => {
    const call: ToolCall = { tool: toolCall.toolName, args: toolCall.input };
    const decision = await pm.gate(session, call);
    if (decision.ok) return 'approved';
    return opts.onDeny === 'user-approval'
      ? { type: 'user-approval' }
      : { type: 'denied', reason: decision.reason };
  };

  const onStepEnd: OnStepEnd = async (step) => {
    for (const r of step.toolResults ?? []) {
      if (r.providerExecuted) {
        // This call ran on the provider side and never hit the gate. Not silent.
        opts.onUnmediated?.(r.toolName);
        continue;
      }
      await pm.settle(session, { tool: r.toolName }, r.output);
    }
  };

  return { toolApproval, onStepEnd };
}

/**
 * Refuse PROVIDER-EXECUTED tools — they run on the model provider's servers and
 * bypass `toolApproval` entirely, so polyman cannot mediate them and the monitor
 * would not be total (AS-5).
 *
 * The authoritative discriminator in ai@7 is the tool's `isProviderExecuted`
 * flag: a `ProviderExecutedTool` sets it `true`. Client-executed tools —
 * function (`type` undefined/'function'), dynamic ('dynamic'), and even a
 * provider-DEFINED tool that runs client-side (`isProviderExecuted: false`) — do
 * NOT, and go through the gate normally, so they are allowed. (Keying off
 * `type === 'provider-defined'` would be wrong both ways: it misses real
 * provider-executed tools and wrongly refuses client-executed provider-defined
 * ones.) The runtime `onUnmediated` hook is the backstop for any that slip past
 * this startup check (e.g. tools not passed to wrapVercel).
 */
export function assertMediatable(tools: Record<string, unknown>): void {
  const offenders = Object.entries(tools)
    .filter(([, tool]) => (tool as { isProviderExecuted?: boolean })?.isProviderExecuted === true)
    .map(([name]) => name);
  if (offenders.length) {
    throw new Error(
      `polyman cannot mediate provider-executed tool(s): ${offenders.join(', ')}. ` +
      'They run on the model provider and bypass toolApproval — remove them or run an equivalent client-side so every call passes the gate (complete mediation).',
    );
  }
}
