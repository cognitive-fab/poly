// polysec catalogue — the tool labels as a SIGNED, VERSIONED DATA ARTEFACT.
//
// v1 track 3, item 9 (docs/polysec-v1-custody-spec.md F-2). Condition V3: the
// catalogue must be maintainable by someone other than us.
//
// ── Why this is not a source file any more ──────────────────────────────────
//
// The cost curve is the whole business question. Four layers, four very
// different rates of change:
//
//   format readers    per format      2 today       engineering
//   effect vocabulary —               11 classes    doctrine change
//   TOOL LABELS       per tool        81 today      **a data row**
//   forbidden regions per property    2             doctrine change
//
// Adding an integration has to cost a data row, never a release. A catalogue
// compiled into the package cannot be that, and 81 hand-curated rows is fine
// while 5,000 is a data-quality problem.
//
// ── The hole this closes ────────────────────────────────────────────────────
//
// The notary hashes `module`, `security` and `contract` — but NOT the
// catalogue that produced the security manifest. So today, before this:
//
//   a later catalogue relabels a tool you use. You do not re-import. Your
//   receipt stays PERFECTLY CURRENT against a security.json that is quietly
//   wrong.
//
// That is the currency mechanism failing exactly where it was designed to
// work. The catalogue digest now joins the bound parts, and currency degrades
// when the catalogue moves — the existing degraded-is-not-invalid semantics,
// no new concept.
//
// ── The asymmetry that governs QA ───────────────────────────────────────────
//
// A row wrong in the RESTRICTIVE direction is noise. A row wrong in the
// PERMISSIVE direction is a breach we certified. These are not symmetric and
// the version rules below do not treat them as such: widening is minor,
// NARROWING IS MAJOR and requires provenance.
//
// $0 API. Reads two JSON files; opens no socket.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canon, digest } from './polysec-canon.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LABELS_DIR = join(HERE, '..', 'labels');

/** How a row may change, and what that costs in version terms. */
export const BUMP = {
  add: 'minor',        // a new tool is additive
  widen: 'minor',      // more effects / more sensitive — the safe direction
  narrow: 'major',     // fewer effects / less sensitive — REQUIRES provenance
  remove: 'major',     // a label that vanishes silently un-covers a tool
};

export function loadCatalogue({ dir = LABELS_DIR } = {}) {
  const raw = readFileSync(join(dir, 'catalogue.json'), 'utf-8');
  const cat = JSON.parse(raw);
  const meta = JSON.parse(readFileSync(join(dir, 'catalogue.meta.json'), 'utf-8'));

  // The digest is over the CANONICAL serialisation, not the file bytes:
  // reformatting the JSON must not change the catalogue's identity, and
  // listing order must carry no information — the same discipline as the
  // scope seal.
  const computed = digest(canon(cat));
  if (meta.digest !== computed) {
    throw new Error(
      `catalogue: meta.digest ${meta.digest} does not match the catalogue (${computed}).\n`
      + '  The catalogue and its metadata have diverged — a signed artefact whose digest\n'
      + '  is wrong is worse than an unsigned one, because it looks checked.\n'
      + '  Run `npm run labels:seal` after editing labels/catalogue.json.');
  }
  return { catalogue: cat, meta, digest: computed };
}

/** The digest alone, for binding into a receipt. */
export function catalogueDigest({ dir = LABELS_DIR } = {}) {
  return loadCatalogue({ dir }).digest;
}

/** The version string a report and a register row carry. */
export function catalogueVersion({ dir = LABELS_DIR } = {}) {
  return loadCatalogue({ dir }).meta.version;
}

/**
 * Classify a change between two catalogues, per row.
 *
 * This is the function the version rules rest on, and it exists because
 * "narrowing is major" is unenforceable as a convention — somebody has to
 * compute which direction a row moved.
 */
export function classifyChange(before, after) {
  const changes = [];
  const bt = before.tools || {};
  const at = after.tools || {};

  for (const name of Object.keys(at)) {
    if (!(name in bt)) { changes.push({ name, kind: 'add', bump: BUMP.add }); continue; }
    const b = bt[name];
    const a = at[name];
    const bEff = new Set(b.effects || []);
    const aEff = new Set(a.effects || []);
    const lostEffects = [...bEff].filter((e) => !aEff.has(e));
    const gainedEffects = [...aEff].filter((e) => !bEff.has(e));
    // Losing a flag is a narrowing: the tool is now described as less
    // dangerous than it was, and if that is wrong it is wrong permissively.
    const lostFlags = ['untrusted', 'sensitive'].filter((f) => b[f] && !a[f]);
    const gainedFlags = ['untrusted', 'sensitive'].filter((f) => !b[f] && a[f]);
    const loosenedReversibility = b.reversibility === 'irreversible' && a.reversibility !== 'irreversible';

    if (lostEffects.length || lostFlags.length || loosenedReversibility) {
      changes.push({
        name, kind: 'narrow', bump: BUMP.narrow,
        lost: [...lostEffects, ...lostFlags, ...(loosenedReversibility ? ['irreversible'] : [])],
      });
    } else if (gainedEffects.length || gainedFlags.length) {
      changes.push({ name, kind: 'widen', bump: BUMP.widen, gained: [...gainedEffects, ...gainedFlags] });
    }
  }
  for (const name of Object.keys(bt)) {
    if (!(name in at)) changes.push({ name, kind: 'remove', bump: BUMP.remove });
  }
  return changes;
}

/**
 * A narrowing without recorded provenance is refused.
 *
 * Wrong-restrictive is noise; wrong-permissive is a breach we certified. The
 * tooling must not treat them alike, so the direction that can hurt has to
 * carry a source, a date and a reviewer.
 */
export function checkProvenance(changes, meta) {
  const missing = changes
    .filter((c) => c.bump === 'major')
    .filter((c) => {
      const p = (meta.provenance || {})[c.name];
      return !p || !p.source || !p.read || !p.reviewer;
    })
    .map((c) => c.name);
  return { ok: missing.length === 0, missing };
}
