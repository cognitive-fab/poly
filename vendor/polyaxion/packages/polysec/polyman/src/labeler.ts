// Labeler — maps a concrete tool call to abstract policy actions
// (docs/polyman-spec.md §5). The bridge that lets a proof over ~6 abstract
// actions cover a whole tool catalogue. Tool→label is human-confirmed intent.
//
// A post-label may carry a trailing `?` to mean CONDITIONAL: apply the taint
// only when the tool's RESULT actually carried something (isPresent) — e.g.
// `"READ_SENSITIVE?"` taints only a read that returned data. The `?` is honored
// in the post phase; in the pre phase (the worst-case gate, before any result
// exists) it is meaningless and the label is applied unconditionally.
import type { AbstractAction, Labeler, ToolCall } from './types.ts';
import type { SecurityManifest, ToolLabel } from './config.ts';

interface NormalizedAction {
  action: string;
  data: Record<string, unknown>;
  conditional: boolean;
}

function normalize(entries: ToolLabel['pre']): NormalizedAction[] {
  if (!entries) return [];
  return entries.map((e) => {
    if (typeof e === 'string') {
      const conditional = e.endsWith('?');
      return { action: conditional ? e.slice(0, -1) : e, data: {}, conditional };
    }
    return { action: e.action, data: e.data ?? {}, conditional: false };
  });
}

const strip = ({ action, data }: NormalizedAction): AbstractAction => ({ action, data });

/**
 * A tool result "carries something": non-null and not an empty string / array /
 * object. Numbers and booleans (incl. 0 / false) are real values → present.
 * This is the condition a `?` post-label is gated on.
 */
export function isPresent(result: unknown): boolean {
  if (result == null) return false;
  if (typeof result === 'string') return result.length > 0;
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result === 'object') return Object.keys(result as object).length > 0;
  return true;
}

export function makeLabeler(security: SecurityManifest): Labeler {
  const tools = security.tools;
  return {
    unknownToolPolicy: 'reject',
    hasTool: (tool: string) => Object.prototype.hasOwnProperty.call(tools, tool),
    pre(call: ToolCall): AbstractAction[] {
      const decl = tools[call.tool];
      // Pre-phase is the worst-case gate: `?` is meaningless before the call
      // runs, so a conditional marker is applied unconditionally (strip it).
      return decl ? normalize(decl.pre).map(strip) : [];
    },
    post(call: ToolCall, result: unknown): AbstractAction[] {
      const decl = tools[call.tool];
      if (!decl) return [];
      // Post-phase honors `?`: a conditional label applies only when the result
      // actually carried something; unconditional post labels always apply.
      return normalize(decl.post)
        .filter((n) => !n.conditional || isPresent(result))
        .map(strip);
    },
  };
}
