// In-process mounts for SDK harnesses: the polyman adapters, unchanged.
//   wrapMcp(pm, upstream, { session })          gate an MCP client's tools/call, hide unmediated tools
//   wrapVercel(pm, { session, onDeny, ... })     toolApproval (gate) + onStepEnd (settle) for the Vercel AI SDK
// `pm` is a polyman kernel; polyaxion's Gate exposes its kernel as `gate.kernel`.
import { polyman } from '../runtime/deps.mjs';

export async function wrapMcp(...args) { const m = await polyman('mcp'); return m.wrapMcp(...args); }
export async function wrapVercel(...args) { const m = await polyman('vercel'); return m.wrapVercel(...args); }
