// polysec canon — the ONE canonicaliser (docs/polysec-notary-spec.md §3).
//
// DOCTRINE 8 (canonical or unsignable): if two runs that mean the same thing
// can serialise differently, nothing downstream can be hashed, signed, or
// compared. This module decides BYTES; `stable()` (load-spec.mjs) decides
// STATE EQUALITY. The two MUST agree, and that agreement is a test
// (test/polysec-canon.test.mjs), not an assumption.
//
// Rules (§3.2):
//   1. object keys sorted by Unicode code point, recursively
//   2. declared set-like values sorted — OPT-IN, see the divergence note below
//   3. no floats: timestamps are integer ms; a non-integer number is fatal
//   4. absent ≠ null ≠ false: omitted keys stay omitted, never defaulted
//   5. UTF-8, no BOM, no insignificant whitespace, \n only
//   6. unknown fields preserved and canonicalised, never dropped
//
// ── DIVERGENCE NOTE (rule 2 vs `stable()`) ──────────────────────────────────
// The spec's rule 2 says a set-like value (e.g. `capabilities`) carries no
// meaning in its order and must therefore carry no bytes. But `stable()` does
// NOT sort arrays: to the checker, ['a','b'] and ['b','a'] are DIFFERENT
// states. Sorting unconditionally would make canon COARSER than the checker —
// two states the checker distinguishes would share one receipt digest, so a
// receipt would no longer identify the state that was decided on. Refusing to
// sort makes insertion order carry bytes, the problem rule 2 exists to solve.
//
// Resolution: sorting is DECLARED per field and carries a PROOF OBLIGATION.
// `assertSetLikeSound()` checks that no two states in the corpus differ only
// by the order of a declared set-like field — i.e. sorting is a no-op over the
// reachable space, so canon and `stable()` still agree exactly. A field whose
// orderings ARE both reachable is not set-like in that machine, and the
// assertion fails loudly rather than quietly widening what a receipt covers.
import { createHash } from 'node:crypto';

export const CANON_V = 1;

/** Sort by Unicode code point (NOT locale) — the only ordering rule here. */
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Canonicalise a value to its byte string. `setLike` is a set of dotted paths
 * whose array values are sorted by their own canonical form (see the
 * divergence note; pair every use with assertSetLikeSound()).
 */
export function canon(value, { setLike = new Set(), path = '' } = {}) {
  if (value === undefined) {
    // Rule 4: absent ≠ null. A PRESENT key holding undefined is ambiguous —
    // it would serialise as absent and silently erase a distinction.
    throw new Error(`canon: undefined at '${path || '<root>'}' — absent, null and false are distinct; omit the key or write null`);
  }
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error(`canon: non-finite number at '${path}' (${value})`);
    // Rule 3: no floats. Every declared domain is finite (spec §0) and time is
    // integer ms, so a fractional value means someone changed the contract.
    if (!Number.isInteger(value)) throw new Error(`canon: non-integer number at '${path}' (${value}) — canonical windows carry integers only`);
    return String(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (t === 'bigint') return `"${value.toString()}"`;
  if (t !== 'object') throw new Error(`canon: unserialisable ${t} at '${path}'`);

  if (Array.isArray(value)) {
    const parts = value.map((v, i) => canon(v, { setLike, path: `${path}[${i}]` }));
    if (setLike.has(path)) parts.sort(byCodePoint);   // rule 2, declared only
    return '[' + parts.join(',') + ']';
  }
  // Rule 1 + rule 6: every own key, sorted, nothing dropped.
  const keys = Object.keys(value).sort(byCodePoint);
  const body = keys.map((k) => {
    const child = canon(value[k], { setLike, path: path ? `${path}.${k}` : k });
    return JSON.stringify(k) + ':' + child;
  });
  return '{' + body.join(',') + '}';
}

/** sha256 of a canonical form, tagged so the algorithm travels with the value. */
export function digest(value, opts) {
  const bytes = typeof value === 'string' ? value : canon(value, opts);
  return 'sha256:' + createHash('sha256').update(bytes, 'utf8').digest('hex');
}

// ── Scope seal (SAIL spec §2.2 / P0-B) ──────────────────────────────────────

/** The four fields a capability set declares. Order here is NOT significant. */
export const SEAL_FIELDS = ['tools', 'mcpServers', 'connectors', 'scopes'];

/**
 * Digest of a declared capability set — the SEAL the proof is scoped to.
 *
 * Sorting is MANDATORY here, and that is sound — unlike the `stable()`
 * divergence note above, which this deliberately resembles. There, array order
 * is state the checker distinguishes, so sorting needs a per-field proof
 * obligation. Here the value is a catalogue: "which tools exist" genuinely is
 * a set, no checker ever explores an ordering of it, and an unsorted digest
 * would make two identical catalogues hash differently on listing order —
 * a false drift alarm. The two cases LOOK alike; they are not.
 *
 * `onExcess` is deliberately NOT covered: it is enforcement posture, not
 * capability. Weakening it is visible in the report, but it does not
 * invalidate the seal — the proof was over the set, not the knob.
 */
export function sealDigest(capabilitySet) {
  if (!capabilitySet || typeof capabilitySet !== 'object') {
    throw new Error('sealDigest: capabilitySet must be an object');
  }
  const sets = {};
  for (const f of SEAL_FIELDS) {
    const v = capabilitySet[f] === undefined ? [] : capabilitySet[f];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      throw new Error(`sealDigest: capabilitySet.${f} must be an array of strings`);
    }
    const dup = v.find((x, i) => v.indexOf(x) !== i);
    if (dup !== undefined) throw new Error(`sealDigest: capabilitySet.${f} declares '${dup}' twice — a set carries no multiplicity`);
    sets[f] = [...v].sort(byCodePoint);
  }
  return digest({ sealV: CANON_V, ...sets });
}

/**
 * The canonical WINDOW (§3.1): the journal entry plus the identity of what the
 * decision depended on. Tool arguments become `argsDigest` — a receipt is
 * exportable, a journal is not, and arguments routinely carry the very secrets
 * the policy exists to protect.
 */
export function canonicalWindow(w, { setLike = new Set(), principal = null } = {}) {
  if (!w || typeof w !== 'object') throw new Error('canonicalWindow: not a window');
  for (const k of ['pre', 'action', 'post']) {
    if (!(k in w)) throw new Error(`canonicalWindow: missing '${k}' — refusing to sign a partial record`);
  }
  const out = { v: CANON_V };
  if (principal) out.principal = principal;
  else if (w.principal) out.principal = w.principal;
  out.pre = w.pre;
  out.action = w.action;
  // args → digest, never the args themselves.
  if (w.data !== undefined) {
    const d = { ...w.data };
    if (d.args !== undefined) { d.argsDigest = digest(d.args, { setLike }); delete d.args; }
    out.data = d;
  }
  out.post = w.post;
  if (w.decision !== undefined) out.decision = w.decision;
  if (w.misfire !== undefined && w.misfire !== null) out.misfire = w.misfire;
  if (w.reason !== undefined && w.reason !== null) out.reason = w.reason;
  if (w.stage !== undefined) out.stage = w.stage;
  if (w.region !== undefined) out.region = w.region;
  if (w.tier !== undefined) out.tier = w.tier;
  if (w.ts !== undefined) out.ts = w.ts;
  // Rule 6: anything else the journal carried rides along canonicalised.
  for (const [k, v] of Object.entries(w)) {
    if (k in out || v === undefined) continue;
    if (['pre', 'action', 'data', 'post', 'principal'].includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Canonical bytes + digest of a window, in one call. */
export function windowDigest(w, opts) {
  return digest(canon(canonicalWindow(w, opts), opts));
}

/**
 * The §3.4 agreement, as a callable check:
 *     stable(a) === stable(b)   ⟺   canon(a) === canon(b)
 * Returns the disagreeing pair (or null). `stable` is injected so this module
 * never reaches into the sibling repo itself.
 */
export function agreementViolation(states, stable, opts) {
  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      const sameStable = stable(states[i]) === stable(states[j]);
      const sameCanon = canon(states[i], opts) === canon(states[j], opts);
      if (sameStable !== sameCanon) {
        return { a: states[i], b: states[j], sameStable, sameCanon };
      }
    }
  }
  return null;
}

/**
 * The proof obligation that licenses rule 2 (see the divergence note): over
 * the given states, no two differ ONLY by the order of a declared set-like
 * field. When this holds, sorting is a no-op over the reachable space and
 * canon stays exactly as fine as `stable()`. Returns the offending pair, or
 * null when sorting is sound.
 */
export function setLikeUnsound(states, setLike, stable) {
  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      const differ = stable(states[i]) !== stable(states[j]);
      const sameSorted = canon(states[i], { setLike }) === canon(states[j], { setLike });
      if (differ && sameSorted) {
        return { a: states[i], b: states[j], why: 'two reachable states differ only by set-like order — the field is not set-like in this machine' };
      }
    }
  }
  return null;
}
