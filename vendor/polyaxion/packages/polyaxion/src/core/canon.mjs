// Canonical serialization and hashing.
//
// Every hash in polyaxion (policy version, state digest, journal chain) is
// sha256 over this canonical form, so two processes that hold the same value
// compute the same digest regardless of key insertion order or platform.
import { createHash } from 'node:crypto';

/** Deterministic JSON: keys sorted, no whitespace, non-finite numbers made explicit. */
export function canon(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v) {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) return { $nonfinite: String(v) };
    if (v === undefined) return null;
    return v;
  }
  if (Array.isArray(v)) return v.map(sortKeys);
  const out = {};
  for (const k of Object.keys(v).sort()) {
    if (v[k] === undefined) continue;
    out[k] = sortKeys(v[k]);
  }
  return out;
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** `sha256:<hex>` of the canonical form of a value. */
export function digest(value) {
  return 'sha256:' + sha256(canon(value));
}

/** Structural deep clone through the canonical form (drops undefined, functions). */
export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function deepEqual(a, b) {
  return canon(a) === canon(b);
}
