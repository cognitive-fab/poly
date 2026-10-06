// polyaxion's Labeler for the polyman kernel: a tool call → PROPOSE / GATE__ /
// PATCH / END / SETTLE actions over canonical actions.
//
// Two call shapes reach the kernel:
//   { tool: 'polyaxion:actions', args: { actions: [canonical…], patch?, end? } }   — MCP merge, probes, the M2 harness
//   { tool: '<host tool name>', args: { input: tool_input, cwd } }                 — Claude Code hooks
// Canonical actions are enriched from the label catalogue (effects, reversibility,
// sensitive, untrusted) when the host tool is known to it.
//
// The session's history window (for runtime-only rules) travels on a Symbol
// property of `args`, so it reaches the compiled acceptor as `data.history`
// without being journaled: JSON serialization ignores symbol keys.
import { extractActions } from '../mounts/claude-code/extract.mjs';
import { normalizeAction } from '../core/action.mjs';
import { routeAction } from '../core/step.mjs';

export const HISTORY = Symbol.for('polyaxion.history');
export const RUN = Symbol.for('polyaxion.run');
export const ACTIONS_TOOL = 'polyaxion:actions';

const CLAUDE_TOOLS = new Set(['Bash', 'PowerShell', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write', 'Read', 'Glob', 'Grep', 'LSP', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'ToolSearch', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'KillShell', 'BashOutput', 'Skill']);

/**
 * @param {object} plan          the composite plan (routing)
 * @param {object} [opts]        { catalogue?: { labelFor(tool) }, knownTools?: Set<string>, allowUnknown?: boolean }
 */
export function makeLabeler(plan, opts = {}) {
  const catalogue = opts.catalogue ?? null;
  const known = opts.knownTools ?? new Set();
  const enrich = (a, tool) => {
    if (!catalogue || !tool) return a;
    const row = catalogue.labelFor(tool);
    if (!row) return a;
    return { ...a, effects: a.effects ?? row.effects ?? null, reversibility: a.reversibility ?? row.reversibility ?? null, sensitive: a.sensitive ?? row.sensitive ?? null, untrusted: a.untrusted ?? row.untrusted ?? (Array.isArray(row.effects) && row.effects.includes('read:store') ? true : null) };
  };
  const canonicalOf = (call) => {
    const args = call.args ?? {};
    if (call.tool === ACTIONS_TOOL) return (args.actions ?? []).map((a) => normalizeAction(a));
    return extractActions(call.tool, args.input ?? {}, { cwd: args.cwd }).map((a) => enrich(a, call.tool));
  };
  return {
    unknownToolPolicy: 'reject',
    hasTool(tool) {
      if (tool === ACTIONS_TOOL) return true;
      if (CLAUDE_TOOLS.has(tool) || /^mcp__/.test(tool) || known.has(tool)) return true;
      return !!opts.allowUnknown;
    },
    pre(call) {
      const args = call.args ?? {};
      const history = args[HISTORY] ?? [];
      const run = args[RUN] ?? { id: '', scope: '', step: 0 };
      const out = [];
      const approved = call.tool === ACTIONS_TOOL && args.approved && typeof args.approved === 'object' ? args.approved : null;
      if (call.tool === ACTIONS_TOOL && args.patch && typeof args.patch === 'object') out.push({ action: 'PATCH', data: { patch: args.patch, history, run, approved } });
      for (const a of canonicalOf(call)) {
        if (a.kind === 'run.end') out.push({ action: 'END', data: { reason: 'end', history, run } });
        else out.push({ action: routeAction(plan, a), data: { action: a, history, run, approved } });
      }
      if (call.tool === ACTIONS_TOOL && args.end) out.push({ action: 'END', data: { reason: 'end', history, run } });
      return out;
    },
    post(call, result) {
      // observed effects: what the result shows the tool actually did; today the
      // catalogue's declared effects stand in for observation (labels audit
      // reconciles them after the fact), plus explicit observations a mount supplies
      const args = call.args ?? {};
      const observed = args.observed ?? (result && typeof result === 'object' && Array.isArray(result.effects) ? { effects: result.effects } : null);
      if (!observed) return [];
      const ok = typeof observed.ok === 'boolean' ? observed.ok : null;
      const output = typeof observed.output === 'string' ? observed.output.slice(0, 2000) : null;
      // fresh effects only (the declared ones were stepped at PROPOSE), plus the success signal settle-phase transitions read (02 §2.2)
      return canonicalOf(call).map((a) => {
        const declared = new Set(a.effects ?? []);
        const fresh = (observed.effects ?? []).filter((e) => !declared.has(e));
        if (!fresh.length && ok === null) return null;
        return { action: 'SETTLE', data: { action: { ...a, effects: fresh.length ? fresh : (a.effects ?? null), observed: true }, observed: { effects: fresh, ok, output } } };
      }).filter(Boolean);
    },
    canonicalOf,
  };
}
