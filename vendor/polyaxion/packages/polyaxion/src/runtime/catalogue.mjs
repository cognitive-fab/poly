// The label catalogue behind the labeler: polysec's signed, versioned tool
// labels (effects, reversibility, sensitive/untrusted flags). Loaded lazily
// from the polysec package; absent (a trimmed install), the labeler runs
// without enrichment and `action.effects` stays unknown, which a policy can
// refuse with has(action.effects).
import { core } from './deps.mjs';

let promise = null;

/** @returns {Promise<{ labelFor(tool): object|null, version, digest } | null>} */
export function catalogue() {
  if (!promise) {
    promise = core('tool-labels')
      .then((m) => ({ labelFor: (tool) => { for (const n of claudeNames(tool)) { const r = m.labelFor(n); if (r) return r; } return null; }, version: m.CATALOGUE_VERSION, digest: m.CATALOGUE_DIGEST, size: m.CATALOGUE_SIZE }))
      .catch(() => null);
  }
  return promise;
}

/** Claude Code tool names as the catalogue may alias them ('claude-code:read', 'claude-code:notebook-edit', 'web-fetch'); MCP tools by their tail. */
const ALIASES = { Skill: 'claude-code:slash-command', SlashCommand: 'claude-code:slash-command', Agent: 'claude-code:task' };
function claudeNames(tool) {
  if (typeof tool !== 'string') return [];
  if (ALIASES[tool]) return [ALIASES[tool]];
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (m) return [m[2], m[2].replace(/_/g, '-')];
  const kebab = tool.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return [...new Set(['claude-code:' + tool.toLowerCase(), 'claude-code:' + kebab, kebab, tool.toLowerCase()])];
}
