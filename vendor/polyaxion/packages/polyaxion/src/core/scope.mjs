// Scopes.
//
// A run lives at a scope path: `/`-separated segments such as
// `acme/payments/nightly`. An obligation carries a scope *selector* — a glob
// over that path (`acme/**`, `*/payments/*`, `**`). `recall(run)` is the set of
// obligations whose selector matches the run's path; it is computed once at
// run begin and cached, so the hot path never re-matches.
import { globMatch } from './expr.mjs';

const SEG = /^[A-Za-z0-9][A-Za-z0-9._:@_-]*$/;

export function scopePathValid(path) {
  if (typeof path !== 'string' || !path) return false;
  return path.split('/').every((s) => SEG.test(s));
}

export function scopeSelectorValid(sel) {
  if (typeof sel !== 'string' || !sel) return false;
  return sel.split('/').every((s) => s === '**' || /^[A-Za-z0-9*?][A-Za-z0-9._:@*?_-]*$/.test(s));
}

export function scopeMatches(selector, path) {
  return globMatch(path, selector);
}

/** Obligations from a list of compiled policies that apply at `path`, sorted by (policy id, obligation id). */
export function activeObligations(policies, path) {
  const out = [];
  for (const p of policies) {
    for (const o of p.compiled) {
      if (scopeMatches(o.scope, path)) out.push({ policy: p.doc.id, policyHash: p.hash, ...o });
    }
  }
  out.sort((a, b) => (a.policy < b.policy ? -1 : a.policy > b.policy ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
