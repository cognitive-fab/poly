// THE TOOL LABEL CATALOGUE — what a tool DOES, which is the one thing no
// configuration file ever says.
//
// A workflow lists `add-comment`. An MCP server advertises
// `conversations_add_message`. Neither says that the first publishes where the
// whole internet can read, or that the second cannot be un-said. A human has to
// know that, for every tool, across every vendor — and that is the single
// hardest step in authoring a security manifest, which is why so many manifests
// are wrong in the permissive direction.
//
// ── THE ROWS NOW LIVE IN `labels/catalogue.json` ────────────────────────────
//
// v1 track 3, item 9. This file was 283 lines of data compiled into the
// package; it is now a LOADER over a signed, versioned data artefact, and the
// exported API is unchanged so nothing downstream had to move.
//
// The reason is a cost curve, not tidiness. Adding an integration must cost a
// DATA ROW, never a release — that difference is what separates a product from
// a consulting business. 81 hand-curated rows is fine; 5,000 compiled into a
// module is not.
//
// It also closes a real hole: the notary hashed `module`, `security` and
// `contract` but never the catalogue that produced the security manifest, so a
// later catalogue could relabel a tool you use while your receipt stayed
// perfectly current against a manifest that was quietly wrong. The catalogue
// digest now binds, and currency degrades when it moves.
//
// ── Reversibility is a judgement, and it is the one that bites ──────────────
//
// `irreversible` does not mean "there is no delete button". It means the EFFECT
// cannot be undone. You can delete a Slack message; you cannot un-read it. You
// can unshare a document; you cannot un-copy it.
//
// ── An unlisted tool resolves to NULL ───────────────────────────────────────
//
// Never to something reasonable. The caller must treat that as `deny` and say
// so. Silence is denial (doctrine 15), and a label nobody confirmed is the kind
// of quiet assumption this project exists to remove.
//
// $0 API. Reads two JSON files; opens no socket.
import { loadCatalogue } from './polysec-catalogue.mjs';

const { catalogue, meta, digest: DIGEST } = loadCatalogue();

export const EFFECT_CLASSES = catalogue.effectClasses;
export const REVERSIBILITY_CLASSES = catalogue.reversibilityClasses;
export const ALIASES = catalogue.aliases;
export const TOOL_LABELS = catalogue.tools;

/** The catalogue's identity — what a receipt binds and a register records. */
export const CATALOGUE_VERSION = meta.version;
export const CATALOGUE_DIGEST = DIGEST;

/** camelCase / snake_case / dot / dash / case, all flattened to one key. */
function normalize(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Candidate keys for a real-world tool name, most specific first.
 *
 * Tails of TWO OR MORE segments only. A one-word tail would let
 * `anything_search` resolve to a catalogue entry called `search`, and a wrong
 * label is worse than no label: it drives the tier, so an over-permissive
 * match turns an irreversible effect into `allow`.
 */
export function candidates(name) {
  const norm = normalize(name);
  const out = [norm];
  const parts = norm.split('-');
  for (let i = 1; i < parts.length - 1; i++) out.push(parts.slice(i).join('-'));
  return out;
}

const BY_NORM = new Map(Object.entries(TOOL_LABELS).map(([k, v]) => [normalize(k), v]));
const ALIAS_BY_NORM = new Map(Object.entries(ALIASES).map(([k, v]) => [normalize(k), normalize(v)]));

export function labelFor(name) {
  if (typeof name !== 'string' || name === '') return null;
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  for (const c of candidates(name)) {
    if (BY_NORM.has(c)) return BY_NORM.get(c);
    const aliased = ALIAS_BY_NORM.get(c);
    if (aliased && BY_NORM.has(aliased)) return BY_NORM.get(aliased);
  }
  return null;
}

/** Every tool whose effects include the given class. */
export function toolsWithEffect(effect) {
  return Object.entries(TOOL_LABELS).filter(([, v]) => v.effects.includes(effect)).map(([k]) => k);
}

/** Every tool carrying a trifecta flag — `untrusted` or `sensitive`. */
export function toolsWithFlag(flag) {
  return Object.entries(TOOL_LABELS).filter(([, v]) => v[flag]).map(([k]) => k);
}

export const CATALOGUE_SIZE = Object.keys(TOOL_LABELS).length;
