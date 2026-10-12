// plan-e3.md E3.3, HF3.4, S559: the fusion classifier. Deterministic code, no model. A model's tool calls are fused (an edit
// and its follow-up command run as one call, and their results come back together) only when the classifier says so. What
// the machine proves is that fusion follows the classifier's verdict; this file is that verdict, the assumption
// "classifier-verdict" of assumptions.json, and its trust is the declared table: a follow-up that must inspect the edit's
// result is not in the table, so it stays separate.
//
// The calls are JSON: [{ "tool": "edit" | "write", "path": ..., ... }, { "tool": "bash", "command": "..." }]. Fusable means
// exactly one edit then one command, the command a test or build runner of the table, written as one plain command with
// no pipe, redirect, substitution, list or newline: such a thing could hide an inspection of the edit.
export const FUSABLE_COMMANDS = [
  /^(npm|pnpm|yarn)( run)? (test|build|lint)( --? ?[\w=.:/-]+)*$/,
  /^node --test( [\w./*-]+)*$/,
  /^(python3?|py) -m (pytest|unittest)( [\w./:=*-]+)*$/,
  /^pytest( [\w./:=*-]+)*$/,
  /^go (test|build|vet)( [\w./.-]+)*$/,
  /^cargo (test|build|check)( [\w./=-]+)*$/,
  /^make( (test|check|build|all))?$/,
  /^tsc( -p [\w./-]+| --noEmit)*$/,
];

const SHELL_META = /[;&|<>`$(){}\n\r\\]/;
const EDITS = new Set(['edit', 'write']);

/** @returns {{ fusable: boolean, reason: string }} */
export function classifyCalls(callsText) {
  let calls;
  try {
    calls = JSON.parse(callsText);
  } catch {
    return { fusable: false, reason: 'not JSON' };
  }
  if (!Array.isArray(calls) || calls.length !== 2) return { fusable: false, reason: 'not exactly two calls' };
  const [first, second] = calls;
  if (!first || !EDITS.has(first.tool)) return { fusable: false, reason: 'the first call is not an edit' };
  if (!second || second.tool !== 'bash' || typeof second.command !== 'string') return { fusable: false, reason: 'the second call is not a command' };
  const cmd = second.command.trim();
  if (SHELL_META.test(cmd)) return { fusable: false, reason: 'the command is not one plain command' };
  if (!FUSABLE_COMMANDS.some((re) => re.test(cmd))) return { fusable: false, reason: 'the command is not a declared runner' };
  return { fusable: true, reason: 'an edit then a declared runner' };
}

/** The effect handler of tool.classify: ok is Fusable, a permanent failure is Separate. The calls are kept either way. */
export async function classify(payload, caps, ctx) {
  const calls = await caps.content.read(payload.calls);
  // the calls are kept for the act effect of the same turn, which reads them by instance (write:store, table calls)
  await caps.store.write('calls', ctx.instanceId, calls);
  // the mechanism can be switched off for the base harness of a paired comparison (Q-E3-2): then nothing is fused
  const cfg = await caps.store.read('mechanisms', 'config');
  const r = cfg && cfg.fusion === false ? { fusable: false, reason: 'action fusion is switched off' } : classifyCalls(calls);
  if (!r.fusable) throw Object.assign(new Error(`separate: ${r.reason}`), { permanent: true });
  return { ok: true };
}
