// Claude Code hook events → gate calls → hook JSON.
//
// The mandatory mount. Every hook payload arrives here (over HTTP from the
// daemon, or over stdin from `polyaxion hook <Event>` in strict mode), is
// turned into canonical actions, and crosses the gate before the effect.
//
//   PreToolUse       merge(actions)     deny → permissionDecision "deny" + witness
//   PostToolUse      observe(effect)    journal only
//   PreCompact       observe(compaction) journal only
//   SessionStart     begin + recall     obligations re-enter context (also after compaction)
//   UserPromptSubmit recall             obligations re-enter context every turn
//   Stop             endCheck           unmet end obligations block the stop, once
//   SessionEnd       end                run closed (forced if unmet; the denial is journaled)
//
// On allow, PreToolUse returns {} — passthrough to Claude Code's own permission
// flow. polyaxion never *grants* a permission; it only withholds effects.
import { extractActions } from './extract.mjs';
import { renderWitness } from '../../core/witness.mjs';

const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PreCompact', 'SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionEnd'];

/**
 * @param {object} gate   engine or client (sync or async)
 * @param {string} event  hook_event_name
 * @param {object} p      the hook payload
 * @param {object} opts   {cwd, scope, config}
 */
export async function handleHook(gate, event, p, opts = {}) {
  const runId = String(p.session_id ?? 'default');
  const scope = opts.scope;
  const cfg = opts.config ?? {};
  try {
    switch (event) {
      case 'PreToolUse': {
        const actions = extractActions(p.tool_name, p.tool_input, { cwd: p.cwd ?? opts.cwd });
        const v = await gate.merge({ run_id: runId, scope, actions, tool: p.tool_name, meta: { tool_use_id: p.tool_use_id ?? null, tool: p.tool_name } });
        if (v.decision === 'deny') {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: v.explanation,
            },
          };
        }
        if (v.decision === 'escalate') {
          // ask narrows: the host prompts the user; the gate has granted nothing (spec 06 §1.2). If the user says yes, PostToolUse lifts the escalation.
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: v.explanation } };
        }
        if (v.warnings && v.warnings.length) {
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'polyaxion warnings:\n' + v.warnings.map(renderWitness).join('\n') } };
        }
        return {};
      }
      case 'PostToolUse': {
        // a call escalated at PreToolUse that the host then ran: a human said yes — re-propose it approved so Σ records the effect (02 §2.6)
        if (p.tool_use_id && typeof gate.escalated === 'function') {
          const e = await gate.escalated({ run_id: runId, scope, ref: String(p.tool_use_id) });
          if (e && e.escalated) {
            const actions = extractActions(p.tool_name, p.tool_input, { cwd: p.cwd ?? opts.cwd });
            if (actions.length) await gate.merge({ run_id: runId, scope, actions, tool: p.tool_name, meta: { tool_use_id: p.tool_use_id, tool: p.tool_name }, approved: { by: 'claude-code', ref: String(p.tool_use_id) } });
          }
        }
        const resp = p.tool_response;
        const summary = typeof resp === 'string' ? resp.slice(0, 500) : resp && typeof resp === 'object' ? summarizeResponse(resp) : null;
        await gate.observe({ run_id: runId, scope, kind: 'effect', body: { tool: p.tool_name, tool_use_id: p.tool_use_id ?? null, response: summary } });
        // settle: the effect classes the catalogue declares for this tool stand in for observation until a mount reports observed effects
        const effects = opts.effectsOf ? opts.effectsOf(p.tool_name) : null;
        // the host's success signal for settle-phase transitions (02 §2.2): explicit `success`, else the absence of an error; unknown when neither can be read
        const ok = resp && typeof resp === 'object' ? (typeof resp.success === 'boolean' ? resp.success : typeof resp.is_error === 'boolean' ? !resp.is_error : 'error' in resp && resp.error ? false : (typeof resp.interrupted === 'boolean' && resp.interrupted) ? false : null) : typeof resp === 'string' ? true : null;
        if (((effects && effects.length) || ok !== null) && typeof gate.settle === 'function') {
          const actions = extractActions(p.tool_name, p.tool_input, { cwd: p.cwd ?? opts.cwd });
          if (actions.length) await gate.settle({ run_id: runId, scope, actions, observed: { effects: effects ?? [], ok, output: typeof summary === 'string' ? summary : summary?.stdout ?? null } });
        }
        return {};
      }
      case 'PreCompact': {
        await gate.observe({ run_id: runId, scope, kind: 'compaction', body: { trigger: p.trigger ?? null, custom_instructions: p.custom_instructions ?? null } });
        return {};
      }
      case 'SessionStart': {
        const source = p.source ?? 'startup';
        await gate.begin({ run_id: runId, scope, reactivate: source === 'resume' || source === 'startup' });
        if (source === 'compact' && cfg.recall_on_compact === false) return {};
        const r = await gate.recall({ run_id: runId, scope });
        const preface = source === 'compact'
          ? 'Context was compacted. The obligations below were NOT in the summary — they are re-read from the constraint store, unchanged.\n\n'
          : '';
        return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: preface + r.text } };
      }
      case 'UserPromptSubmit': {
        if (cfg.recall_on_prompt === false) return {};
        const r = await gate.recall({ run_id: runId, scope, journal: false });
        if (!r.count) return {};
        return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.text } };
      }
      case 'Stop': case 'SubagentStop': {
        if (cfg.enforce_end_on_stop === false || event === 'SubagentStop') return {};
        if (p.stop_hook_active) return {}; // already blocked once; do not loop
        const c = await gate.endCheck({ run_id: runId, scope });
        if (c.ok) return {};
        return { decision: 'block', reason: 'polyaxion: the run cannot end yet — obligations with required end states are unmet.\n' + c.witnesses.map(renderWitness).join('\n') + '\nComplete them, or tell the user why they cannot be completed.' };
      }
      case 'SessionEnd': {
        await gate.end({ run_id: runId, force: true });
        return {};
      }
      default:
        return {};
    }
  } catch (e) {
    // Fail closed on the only event that can withhold an effect; never fail
    // a session on the others.
    if (event === 'PreToolUse') {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `polyaxion: gate error — refusing the effect rather than guessing. ${e.message}` } };
    }
    return {};
  }
}

function summarizeResponse(r) {
  const out = {};
  for (const k of ['stdout', 'stderr', 'interrupted', 'filePath', 'success', 'error']) if (k in r) out[k] = typeof r[k] === 'string' ? r[k].slice(0, 300) : r[k];
  return Object.keys(out).length ? out : { keys: Object.keys(r).slice(0, 10) };
}

export { HOOK_EVENTS };
