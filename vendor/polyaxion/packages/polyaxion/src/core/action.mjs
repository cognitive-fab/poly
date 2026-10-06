// Canonical actions.
//
// The gate judges *actions*, not tool calls. A mount's job is to turn a
// harness-specific tool call into one or more canonical actions with a
// `kind` from the vocabulary below (or a harness-defined `custom.*` kind),
// deterministically. Expressions then refer to `action.kind`, `action.path`,
// `action.host`, … regardless of which harness produced them.
//
// Field conventions (all optional unless stated):
//   kind      required — vocabulary below
//   tool      the host tool that produced it (Bash, Edit, mcp__github__push …)
//   target    the primary object as one string (path, url, branch, tool name)
//   path      normalized filesystem path (fs.*)
//   paths     list of paths when a single call touches several
//   url/host/method  http.request
//   command/exe/argv shell-derived actions keep the parsed command
//   content   text being written/sent (fs.write, message)
//   opaque    true when the mount could not fully determine what the call does
//   raw       the original tool input (never used by policies for decisions
//             unless they explicitly reach into it)
import { normPath } from './expr.mjs';

export const ACTION_KINDS = [
  'run.begin', 'run.end', 'compaction',
  'shell', 'shell.opaque',
  'fs.read', 'fs.write', 'fs.delete', 'fs.rename', 'fs.search',
  'vcs.push', 'vcs.commit', 'vcs.checkout', 'vcs.reset', 'vcs.tag', 'vcs.merge',
  'http.request', 'web.search',
  'mcp.call', 'agent.spawn', 'tool.call',
  'message', 'log.write', 'effect.observed',
  'package.install', 'process.run',
];

export class ActionError extends Error {
  constructor(m) { super(m); this.name = 'ActionError'; }
}

const KIND_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$|^[a-z][a-z0-9]*$/;

/** Validate and normalize one action object. Unknown kinds are allowed only under `custom.`. */
export function normalizeAction(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new ActionError('action must be an object');
  if (typeof a.kind !== 'string' || !KIND_RE.test(a.kind)) throw new ActionError(`action.kind must be a dotted lowercase identifier, got ${JSON.stringify(a.kind)}`);
  if (!ACTION_KINDS.includes(a.kind) && !a.kind.startsWith('custom.')) throw new ActionError(`unknown action kind '${a.kind}' (use custom.* for harness-defined kinds)`);
  const out = { ...a };
  if (typeof out.path === 'string') out.path = normPath(out.path);
  if (Array.isArray(out.paths)) out.paths = out.paths.map((p) => normPath(String(p)));
  if (typeof out.url === 'string' && out.host === undefined) {
    try { out.host = new URL(out.url).hostname.toLowerCase(); } catch { /* leave unknown */ }
  }
  if (out.target === undefined) out.target = out.path ?? out.url ?? out.branch ?? out.command ?? out.tool ?? null;
  if (out.opaque !== undefined) out.opaque = !!out.opaque;
  return out;
}

/** Normalize a proposal: `{ action }` or `{ actions: [...] }`, plus optional patch/meta. */
export function normalizeProposal(p) {
  if (!p || typeof p !== 'object') throw new ActionError('proposal must be an object');
  let actions = [];
  if (p.actions !== undefined) {
    if (!Array.isArray(p.actions)) throw new ActionError('proposal.actions must be a list');
    actions = p.actions.map(normalizeAction);
  } else if (p.action !== undefined) {
    actions = [normalizeAction(p.action)];
  }
  if (p.patch !== undefined && p.patch !== null && (typeof p.patch !== 'object' || Array.isArray(p.patch))) throw new ActionError('proposal.patch must be an object (RFC 7386 merge patch)');
  if (actions.length === 0 && (p.patch === undefined || p.patch === null)) throw new ActionError('proposal needs an action, actions, or a patch');
  if (actions.length > 64) throw new ActionError('too many actions in one proposal (max 64)');
  return { actions, patch: p.patch ?? null, meta: p.meta ?? null };
}

/** One-line rendering for witnesses and journals. */
export function summarizeAction(a) {
  if (!a) return '(none)';
  const t = a.target ?? a.path ?? a.url ?? a.command ?? '';
  const parts = [a.kind];
  if (a.tool && a.tool !== a.kind) parts.push(`via ${a.tool}`);
  if (t) parts.push(String(t).length > 120 ? String(t).slice(0, 117) + '…' : String(t));
  if (a.opaque) parts.push('[opaque]');
  return parts.join(' ');
}
