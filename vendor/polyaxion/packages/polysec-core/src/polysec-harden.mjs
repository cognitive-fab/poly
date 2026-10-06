// polysec harden — the design-time fully-mediated gate (docs/polysec-spec.md
// §3.1, §4.4, §6). Runs three checks over ONE (machine, security.json) pair,
// each reusing the Polygraph BFS checker (scripts/check.mjs):
//
//   (a) from-init security-invariant check  — shortest counterexample
//   (b) HAVOC check                          — modeled ∪ havoc; a counterexample
//                                              that uses a havoc edge NAMES the
//                                              unmediated adversarial variable
//   (c) FULLY-MEDIATED gate-deletion check   — delete the designated gates and
//                                              test reachability to each
//                                              forbidden region; shortest bypass
//
// Fully-mediated verdict = (a) clean ∧ no havoc counterexample ∧ no bypass.
// Written to security-report.{json,md}.
//
// No API key, no network, no clock — pure exploration. A bounded/empty/failed
// exploration exits nonzero and says why (no silent-clean paths).
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check, loadSpec, loadSecurity, securityInvariants, stateKeysOf,
  augmentWithHavoc, deleteGates, havocVarsInPath, pathUsesHavoc, dischargeTiers,
  augmentWithCaller, callerProfilesInPath, CALLER_HAVOC, scopeProvenance, atScopeBound,
} from './polysec-lib.mjs';
import { sealDigest, SEAL_FIELDS } from './polysec-canon.mjs';

const MAX_STATES = 100000;

/** Render a counterexample path to compact lines (mirrors check.mjs's render). */
function renderPath(path = []) {
  const lines = [];
  path.forEach((step, i) => {
    const st = typeof step.state === 'string' ? step.state : JSON.stringify(step.state);
    if (i === 0 && step.action === null) lines.push(`    init  ${st}`);
    else lines.push(`    ${step.action}(${JSON.stringify(step.data)}) -> ${st}`);
  });
  return lines;
}

/** A check() result that is anything but a completed, in-domain exploration is fatal. */
function assertHonest(label, r) {
  if (r.error) throw new Error(`${label}: exploration error — ${r.error}`);
  if (r.capHit) throw new Error(`${label}: exploration hit the ${MAX_STATES}-state cap — result is BOUNDED, not exhaustive; refusing to report a verdict`);
  if (r.nondeterministic) throw new Error(`${label}: the machine explored NONDETERMINISTICALLY — its verdict cannot be trusted`);
  if (r.statesExplored === 0) throw new Error(`${label}: explored 0 states — empty domain, not a clean pass`);
}

/**
 * Run the three gates. Returns a structured report object. `spec` and
 * `security` are already loaded so callers (the demo, tests) can drive many
 * pairs without re-reading files.
 */
/**
 * Check (a) ALONE — is a forbidden state reachable at all?
 *
 * `harden` refuses to return a mediation verdict when nothing is designated as
 * a gate, which is correct: you cannot be told your mediation is sound when you
 * have none. But "is the bad state reachable?" is still answerable, and on a
 * gateless artifact it is the only question left worth asking. Exported so a
 * caller can ask it without pretending to a verdict.
 */
export function fromInitCheck({ spec, contract, security }) {
  const stateKeys = stateKeysOf(spec);
  const { stateInvariants } = securityInvariants(security, stateKeys);
  const r = check({ specModule: spec, contract, invariants: { stateInvariants }, maxStates: MAX_STATES });
  assertHonest('from-init check', r);
  return {
    ok: r.ok,
    statesExplored: r.statesExplored,
    violations: r.violations.map((v) => ({ invariant: v.invariant, detail: v.detail, path: v.path })),
  };
}

export function harden({ spec, contract, security, label = 'machine', coverage = null }) {
  const stateKeys = stateKeysOf(spec);
  const { stateInvariants, conditionalInvariants } = securityInvariants(security, stateKeys);
  const invariants = { stateInvariants };
  const regionNames = stateInvariants.map((i) => i.region);

  // ── (a) from-init security-invariant check ───────────────────────────────
  const a = check({ specModule: spec, contract, invariants, maxStates: MAX_STATES });
  assertHonest('from-init check', a);
  const fromInit = {
    ok: a.ok,
    statesExplored: a.statesExplored,
    violations: a.violations.map((v) => ({ invariant: v.invariant, detail: v.detail, path: v.path })),
  };

  // ── (b) HAVOC check ──────────────────────────────────────────────────────
  const { module: havocMod, steps: havocStepsAll, havocSteps } = augmentWithHavoc(spec, security);
  let havoc;
  if (havocSteps.length === 0) {
    // Nothing declared adversarial: the havoc check is VACUOUS. Say so — never
    // report a silent clean.
    havoc = { ran: false, reason: 'no adversarial variables declared — havoc check is vacuous', counterexamples: [], namedVariables: [] };
  } else {
    const b = check({ specModule: havocMod, contract, invariants, steps: havocStepsAll, maxStates: MAX_STATES });
    assertHonest('havoc check', b);
    // A havoc COUNTEREXAMPLE is a violation whose shortest path uses a havoc
    // edge; a violation that does not is already a from-init finding.
    const ces = b.violations.filter((v) => pathUsesHavoc(v.path));
    const named = [...new Set(ces.flatMap((v) => havocVarsInPath(v.path)))];
    havoc = {
      ran: true,
      statesExplored: b.statesExplored,
      counterexamples: ces.map((v) => ({ invariant: v.invariant, namedVariables: havocVarsInPath(v.path), path: v.path })),
      namedVariables: named,
    };
  }

  // ── (c) FULLY-MEDIATED gate-deletion check ───────────────────────────────
  const { module: gdMod, steps: gdSteps, deletedActions } = deleteGates(spec, security);
  if (deletedActions.length === 0) {
    throw new Error(`gate-deletion check: security.json declares gates ${JSON.stringify(security.gates)} but none are explorable intents of ${label} — refusing to report a mediation verdict on a gate set that does not exist`);
  }
  let gateDeletion;
  if (gdSteps.length === 0) {
    // EVERY explorable action is a gate. With all of them deleted, nothing
    // moves: the reachable set is exactly { init }, so the only possible
    // bypass is init itself already lying inside a region — which (a) would
    // have caught. Evaluated directly rather than handed to check(), whose
    // empty-domain refusal exists for a different failure (a contract that
    // declares nothing), not for a total mediation surface.
    const initState = (() => { const m = gdMod.init(); return m; })();
    const initViolations = invariants.stateInvariants
      .filter((inv) => !inv.pred(initState))
      .map((inv) => ({ region: inv.name, via: [], path: [{ action: null, data: null, state: initState }] }));
    gateDeletion = {
      deletedGates: deletedActions,
      totalSurface: true,
      ok: initViolations.length === 0,
      bypasses: initViolations,
    };
  } else {
    const c = check({ specModule: gdMod, contract, invariants, steps: gdSteps, maxStates: MAX_STATES });
    assertHonest('gate-deletion check', c);
    gateDeletion = {
      deletedGates: deletedActions,
      ok: c.ok,
      bypasses: c.violations.map((v) => ({
        region: v.invariant,
        // The transitions the surviving path uses (excluding the init root) — the
        // bypass names WHICH ungated edge reached the region.
        via: [...new Set((v.path || []).filter((s) => s.action).map((s) => s.action))],
        path: v.path,
      })),
    };
  }

  // ── (g) IRREVERSIBLE-EFFECT mediation (SAIL spec §2.6 / SAIL 6.14) ───────
  // Every path to an irreversible effect must cross a designated gate, even
  // when the effect sits OUTSIDE every forbidden region. Same machinery as
  // (c): delete the gates, wrap the machine with a synthetic fired-flag per
  // irreversible effect, and ask whether it can still fire. A surviving path
  // is a bypass — an undoable-by-nobody act reachable without mediation.
  const irrTools = Object.entries(security.tools || {})
    .filter(([, d]) => d && d.reversibility === 'irreversible')
    .map(([tool, d]) => ({ tool, effects: d.effect ? [d.effect] : (d.pre || []) }));
  let irreversibles;
  if (irrTools.length === 0) {
    irreversibles = { ran: false, reason: 'no irreversible tools declared', bypasses: [] };
  } else {
    const { module: gdMod2, steps: gdSteps2 } = deleteGates(spec, security);
    const effectActions = [...new Set(irrTools.flatMap((t) => t.effects))];
    const wrapped = {
      init: () => ({ ...gdMod2.init(), __fired: null }),
      transition: (state, action, data) => {
        const { __fired, ...rest } = state;
        const post = gdMod2.transition(rest, action, data);
        const fired = __fired ?? (effectActions.includes(action) && JSON.stringify(post) !== JSON.stringify(rest) ? action : null);
        return { ...post, __fired: fired };
      },
    };
    const inv = { stateInvariants: [{ name: 'irreversible:unfired', pred: (s) => !s.__fired }] };
    const g = check({ specModule: wrapped, contract, invariants: inv, steps: gdSteps2, maxStates: MAX_STATES });
    assertHonest('irreversible-effect check', g);
    irreversibles = {
      ran: true,
      statesExplored: g.statesExplored,
      tools: irrTools,
      bypasses: g.violations.map((v) => {
        const firedStep = (v.path || []).find((s) => s.state && typeof s.state === 'object' && s.state.__fired);
        const effect = firedStep ? firedStep.state.__fired : null;
        return {
          effect,
          tools: irrTools.filter((t) => t.effects.includes(effect)).map((t) => t.tool),
          via: [...new Set((v.path || []).filter((s) => s.action).map((s) => s.action))],
          path: v.path,
        };
      }),
    };
    irreversibles.ok = irreversibles.bypasses.length === 0;
  }
  if (!irreversibles.ran) irreversibles.ok = true;

  // ── (e) CALLER-HAVOC check (SAIL 5.20, confused deputy) ──────────────────
  // Maximal nondeterminism over the declared principal profiles: for EVERY
  // caller the system admits — including one smuggled in mid-session — is
  // every forbidden region still unreachable? Same shape as (b), different
  // quantifier. A counterexample NAMES the profile (F-C-4).
  let callerHavoc;
  if (!security.principals) {
    callerHavoc = { ran: false, reason: 'no principals declared — caller-havoc check is vacuous', counterexamples: [], namedProfiles: [] };
  } else {
    const { module: cMod, steps: cSteps } = augmentWithCaller(spec, security);
    const e = check({ specModule: cMod, contract, invariants, steps: cSteps, maxStates: MAX_STATES });
    assertHonest('caller-havoc check', e);
    // A caller counterexample is a violation whose shortest path switches the
    // caller; one that does not is already a from-init finding under the
    // declared init profile.
    const ces = e.violations.filter((v) => (v.path || []).some((s) => s && s.action === CALLER_HAVOC));
    const named = [...new Set(ces.flatMap((v) => callerProfilesInPath(v.path)))];
    callerHavoc = {
      ran: true,
      statesExplored: e.statesExplored,
      initProfile: security.principals.init,
      profiles: Object.keys(security.principals.profiles),
      counterexamples: ces.map((v) => ({ invariant: v.invariant, namedProfiles: callerProfilesInPath(v.path), path: v.path })),
      namedProfiles: named,
    };
  }

  // ── (d) TIER obligations ─────────────────────────────────────────────────
  // An `approve` tier is an ordering constraint, so it is discharged by the
  // same from-init machinery that proves UC-3's handshake ≺ app-data. A tier
  // whose ordering harden cannot establish is a FINDING, not a configuration
  // (notary spec §6.2).
  const tiers = dischargeTiers(security, fromInit);

  // ── rubber-stamp resistance (SAIL 6.13, report-only) ─────────────────────
  // Approval transitions are ordinary actions in the explored alphabet with no
  // precondition that a human deliberated, so the from-init BFS ALREADY
  // explores the world in which every approval is granted, instantly, always.
  // A clean safety region therefore means: unreachable even under
  // unconditional approval. This block SURFACES that existing property; it
  // proves nothing new and changes no verdict. (Ordering regions are excluded
  // — "reachable without approval" is exactly what they exist to detect, so
  // "safe when everything is approved" would be a vacuous claim about them.)
  const violatedRegions = new Set(fromInit.violations.map((v) => String(v.invariant).replace(/^forbidden:/, '')));
  const rubberStamp = {
    regions: security.forbiddenRegions
      .filter((r) => (r.kind || 'safety') === 'safety')
      .map((r) => ({ region: r.name, safeUnderRubberStamp: !violatedRegions.has(r.name) })),
  };

  // ── scope seal (SAIL spec §2.2 / P0-B) ───────────────────────────────────
  // The proof is over a declared capability set; the seal is that set's digest.
  // It rides in the report, so verdictDigest covers it and every receipt binds
  // it with no receipt-format change (F-B-3). Absence is vacuous-loud, and it
  // does NOT gate the verdict — the seal scopes the proof, it is not a gate.
  const seal = security.capabilitySet
    ? {
        declared: true,
        digest: sealDigest(security.capabilitySet),
        counts: Object.fromEntries(SEAL_FIELDS.map((f) => [f, (security.capabilitySet[f] || []).length])),
        onExcess: security.capabilitySet.onExcess || 'deny-new',
      }
    : { declared: false, reason: 'no capabilitySet declared — the proof is not scoped to a sealed catalogue, and runtime growth past it cannot be detected' };

  // ── SCOPE DEPENDENCE (S07 §4) — the polarity rule, derived not declared ──
  //
  // There is no single safe direction for an unresolved caller scope. Widening
  // is conservative for a POSITIVE capability test and unsound for a NEGATED
  // one, and our shipped predicate is the negated kind:
  //
  //   positive   declaredEffective.includes(cap)    over-estimate → safe
  //   negated   !declaredEffective.includes(cap)    over-estimate → MISS
  //
  // So a general mechanism cannot "take the safe direction" — it would need the
  // monotonicity of every scope reference. Rather than make authors declare
  // polarity (one more thing to get wrong), DERIVE it: run the region at both
  // ends of the admissible range. If reachability differs, the finding's truth
  // depends on a scope nobody resolved, and it says so instead of picking.
  //
  // Annotation only. It never moves the verdict, for the same reason the
  // conditional tier does not: a verdict must not turn on an assumption the
  // reader did not make.
  const scope = scopeProvenance(security);
  // `declared` gates the whole thing. Without a principals block both bounds
  // are the SAME manifest — `atScopeBound` has nothing to vary — so the two
  // runs are one run and `scopeDependent` could never be true. Reporting "the
  // answer is the same either way" from that is a reassurance manufactured by
  // running the identical check twice. (Reaching here at all now requires a
  // principals block: `securityInvariants` refuses an unbound scope binding.)
  if (scope.declared && scope.referencedBy.length) {
    const premiseOfRegion = Object.fromEntries(
      (security.forbiddenRegions || []).map((r) => [r.name, r.premise || null]));

    // Compare the conjuncts that actually EVALUATE the regions. From-init
    // alone was not enough: a predicate over `caller` moves only under the
    // caller-havoc augmentation, and the annotation then said the scope did
    // not matter while `noCallerHavocCounterexample` flipped between bounds —
    // a false reassurance, which is the failure this whole file is about.
    const reachAt = (end) => {
      const boundedSec = atScopeBound(security, end);
      const bounded = securityInvariants(boundedSec, stateKeys);
      const inv = {
        stateInvariants: [...bounded.stateInvariants, ...bounded.conditionalInvariants]
          .filter((i) => scope.referencedBy.includes(i.region)),
      };
      const hits = new Set();
      const absorb = (r) => { for (const v of r.violations) hits.add(String(v.invariant).replace(/^forbidden:/, '')); };

      const fi = check({ specModule: spec, contract, invariants: inv, maxStates: MAX_STATES });
      assertHonest(`scope-dependence from-init (${end})`, fi);
      absorb(fi);

      // Caller-havoc — the conjunct that IS about who the caller is.
      if (boundedSec.principals) {
        const { module: cMod, steps: cSteps } = augmentWithCaller(spec, boundedSec);
        const ch = check({ specModule: cMod, contract, invariants: inv, steps: cSteps, maxStates: MAX_STATES });
        assertHonest(`scope-dependence caller-havoc (${end})`, ch);
        absorb(ch);
      }
      return hits;
    };
    const widest = reachAt('widest');
    const narrowest = reachAt('narrowest');
    // Named so the report can say what was compared instead of implying "the
    // verdict". Havoc and gate-deletion are NOT re-run at the bounds.
    scope.comparedConjuncts = ['fromInit', 'callerHavoc'];
    scope.notCompared = ['havoc', 'gateDeletion', 'tiers', 'irreversibles'];
    scope.dependence = scope.referencedBy.map((region) => {
      const w = widest.has(region);
      const n = narrowest.has(region);
      return {
        region,
        reachableAtWidest: w,
        reachableAtNarrowest: n,
        scopeDependent: w !== n,
        // Which direction hides it — the actionable half.
        hiddenBy: w === n ? null : (w ? 'a NARROWER real scope than declared' : 'a WIDER real scope than declared'),
        // A conditional region's truth rests on TWO things. Carrying the
        // premise here stops the report presenting it as scope-conditional
        // only, when it is also premise-conditional.
        premise: premiseOfRegion[region] || null,
      };
    });
    scope.anyDependent = scope.dependence.some((d) => d.scopeDependent);
  } else if (scope.referencedBy.length) {
    scope.dependenceVacuous = 'no principals block, so both ends of the range are the same manifest — running the check twice would prove nothing';
  }

  // ── CONDITIONAL regions (S07 §8a.3) ──────────────────────────────────────
  // Proved the same way, reported separately, and deliberately NOT a conjunct.
  // A mediation verdict must not turn on an adversary premise the reader did
  // not make; a finding may, so long as it names the premise.
  let conditional;
  if (!conditionalInvariants.length) {
    conditional = { ran: false, reason: 'no conditional regions declared', regions: [], findings: [] };
  } else {
    const cc = check({ specModule: spec, contract, invariants: { stateInvariants: conditionalInvariants }, maxStates: MAX_STATES });
    assertHonest('conditional-region check', cc);
    const premiseOf = Object.fromEntries(conditionalInvariants.map((i) => [i.name, i.premise]));
    conditional = {
      ran: true,
      regions: conditionalInvariants.map((i) => i.region),
      statesExplored: cc.statesExplored,
      findings: cc.violations.map((v) => ({
        invariant: v.invariant,
        premise: premiseOf[v.invariant] || 'unstated — a conditional region with no premise is just an unexplained failure',
        path: v.path,
      })),
    };
  }

  const havocClean = !havoc.ran || havoc.counterexamples.length === 0;
  const callerClean = !callerHavoc.ran || callerHavoc.counterexamples.length === 0;
  const fullyMediated = fromInit.ok && havocClean && gateDeletion.ok && tiers.ok && callerClean && irreversibles.ok;

  return {
    label,
    regions: regionNames,
    gates: security.gates,
    adversarial: security.adversarial,
    fromInit,
    // What the caller scope in this proof actually rests on (S07 §3). Data, so
    // no consumer has to read a docstring to learn it was never resolved.
    scope,
    conditional,
    havoc,
    gateDeletion,
    tiers,
    callerHavoc,
    irreversibles,
    rubberStamp,
    seal,
    verdict: {
      fullyMediated,
      // The coverage grade (polyaxion spec 03 §7): what was and was not
      // model-checked, as a fact about the authoring the caller supplies and
      // this report echoes, so the receipt that binds the verdict binds it.
      coverage: coverage ?? null,
      basis: {
        fromInitClean: fromInit.ok,
        noHavocCounterexample: havocClean,
        noBypass: gateDeletion.ok,
        tiersProved: tiers.ok,
        noCallerHavocCounterexample: callerClean,
        irreversiblesMediated: irreversibles.ok,
      },
      // WHICH CONJUNCTS DID NOT ACTUALLY RUN. See `vacuities` below for why
      // this is a v1 bar and not a nicety.
      vacuous: vacuities({ havoc, callerHavoc, irreversibles, tiers }),
    },
  };
}

/**
 * THE VACUITY CHECK (v1 condition V4).
 *
 * A conjunct that did not run reports `true`, because there was nothing to
 * find. Six trues make `fullyMediated`. So a verdict can be a clean tick over
 * three checks that ran and three that had nothing to check — and it looks
 * exactly like a verdict where all six ran.
 *
 * THIS IS NOT HYPOTHETICAL. `buildAgenticArtifacts` never emitted a principals
 * block, so caller-havoc — conjunct (e) — was vacuous on all 135 workflows of
 * the field corpus, and the confused-deputy question was never asked of the
 * format every published number came from (S07 §8a). Nothing lied: every run
 * printed `vacuous (no principals declared)`, exactly as the no-silent-clean
 * doctrine requires. NOBODY READ THE WORD.
 *
 * That is the lesson worth encoding. A condition that holds only while someone
 * reads prose is not a condition — it is a habit, and habits do not survive a
 * corpus of 135. So vacuity becomes DATA on the verdict, and a caller can
 * refuse it mechanically.
 *
 * The same shape as V1: a proof that cannot say what it covered is read as
 * covering everything, and a verdict that cannot say which conjuncts ran is
 * read as all six having run.
 *
 * Returns [] when every conjunct had something to check.
 */
export function vacuities({ havoc, callerHavoc, irreversibles, tiers }) {
  const out = [];
  // (b), (e), (f) carry an explicit `ran` flag and their own reason.
  if (havoc && havoc.ran === false) {
    out.push({ conjunct: 'havoc', basis: 'noHavocCounterexample', why: havoc.reason });
  }
  if (callerHavoc && callerHavoc.ran === false) {
    out.push({ conjunct: 'callerHavoc', basis: 'noCallerHavocCounterexample', why: callerHavoc.reason });
  }
  if (irreversibles && irreversibles.ran === false) {
    out.push({ conjunct: 'irreversibles', basis: 'irreversiblesMediated', why: irreversibles.reason });
  }
  // (d) has no `ran` flag: an empty obligation set discharges vacuously, and
  // `tiers.ok` is `[].every(...)` — true because there was nothing to prove.
  if (tiers && Array.isArray(tiers.obligations) && tiers.obligations.length === 0) {
    out.push({
      conjunct: 'tiers',
      basis: 'tiersProved',
      why: 'no tier obligations declared — nothing to discharge, so this conjunct proves nothing',
    });
  }
  // (a) from-init and (c) gate-deletion always run: `harden` refuses a manifest
  // with no gates rather than grading it, so neither can be vacuous here.
  return out;
}

/**
 * Refuse a clean tick that rests on conjuncts which never ran.
 *
 * `allow` names the conjuncts the caller has deliberately accepted as vacuous
 * — a workflow with no irreversible tool genuinely has nothing to mediate, and
 * saying so beats pretending. Anything NOT named is a silent pass and throws.
 */
export function assertNoSilentVacuity(rep, { allow = [] } = {}) {
  const v = rep && rep.verdict && rep.verdict.vacuous;
  if (!Array.isArray(v)) {
    throw new Error('verdict carries no `vacuous` list — a verdict that cannot say which conjuncts ran is read as all six having run (v1 condition V4)');
  }
  if (!rep.verdict.fullyMediated) return rep;      // a failing verdict claims nothing
  const unacknowledged = v.filter((x) => !allow.includes(x.conjunct));
  if (unacknowledged.length) {
    throw new Error(
      `FULLY MEDIATED rests on ${unacknowledged.length} conjunct(s) that never ran: `
      + unacknowledged.map((x) => `${x.conjunct} (${x.why})`).join('; ')
      + ' — this is a pass over a SMALLER QUESTION than the verdict implies. Acknowledge them explicitly or give them something to check (v1 condition V4).');
  }
  return rep;
}

/**
 * V4, EXTENDED TO GATES — the gate-vacuity check (Kiro Crew field test, finding B).
 *
 * `fullyMediated` says the forbidden region is unreachable. It does NOT say WHY.
 * If the region is unreachable because the state is too coarse to represent the
 * hazard — not because a gate blocks it — the gate is VACUOUS and the verdict is
 * a clean tick over a smaller question. This is the exact V4 defect, in the one
 * place `vacuities()` exempts: its comment claims gate-deletion "cannot be
 * vacuous," and that is false. gate-deletion removes the gate ACTION; when the
 * gate is the region's sole entry, deleting it trivially makes the region
 * unreachable, whether or not the gate's GUARD does any work. Two machines — one
 * where the gate is load-bearing, one where it is vacuous — produce byte-identical
 * harden signals (fromInit.ok, gateDeletion.ok, bypasses, fullyMediated).
 *
 * harden cannot tell them apart from a single black-box machine: the guard and
 * the effect are entangled in the acceptor, and a rejected transition is a no-op
 * it cannot see past. So the load-bearing witness is AUTHOR-SUPPLIED — the same
 * way the deputy example ships a naive AND a repaired machine. Give the region's
 * reachability with the gate's guard OPEN (the ungated machine). A gate is
 * load-bearing iff the region is reachable then. If the verdict is fully mediated
 * but the region was unreachable even with the guard open, the gate mediates
 * nothing.
 *
 * Found by `examples/polysec-delegation-taint`: the same taint-refusing gate is
 * load-bearing on an edge-aware machine and vacuous on a session-isolated one,
 * and harden reported both fully mediated.
 */
export function assertGatesLoadBearing(rep, { ungatedRegionReachable, note = '' } = {}) {
  if (!rep || !rep.verdict || typeof rep.verdict.fullyMediated !== 'boolean') {
    throw new Error('assertGatesLoadBearing: not a harden report');
  }
  if (typeof ungatedRegionReachable !== 'boolean') {
    throw new Error(
      'assertGatesLoadBearing: supply { ungatedRegionReachable } — the forbidden '
      + 'region\'s reachability with the gate GUARD OPEN. harden cannot derive it '
      + 'from a black-box machine (guard and effect are entangled in the acceptor), '
      + 'so a load-bearing claim needs the ungated machine as a witness — the way '
      + 'the deputy example ships next.cjs AND next.approved.cjs.');
  }
  if (!rep.verdict.fullyMediated) return rep;      // a failing verdict claims nothing
  if (!ungatedRegionReachable) {
    throw new Error(
      `FULLY MEDIATED over gates ${JSON.stringify(rep.gates)} — but the forbidden `
      + 'region is UNREACHABLE even with the guard OPEN, so the gate mediates '
      + 'nothing (VACUOUS). It is unreachable for a reason OTHER than the gate — a '
      + 'state too coarse to hold the hazard, or an unrelated ordering. '
      + `${note ? note + ' ' : ''}This is V4 for gates: a clean tick over a SMALLER `
      + 'question than the verdict implies.');
  }
  return rep;
}

// ── report rendering ────────────────────────────────────────────────────────
export function reportMarkdown(rep) {
  const L = [];
  L.push(`# PolySec fully-mediated report — ${rep.label}`);
  L.push('');
  L.push(`**Verdict: ${rep.verdict.fullyMediated ? 'FULLY MEDIATED ✓' : 'NOT FULLY MEDIATED ✗'}**`);
  L.push('');
  // Directly under the verdict, never in a footnote. A conjunct that did not
  // run reports true because there was nothing to find, and six trues make a
  // tick — so the scope of the tick belongs beside the tick (V4).
  // A conditional finding is NOT part of the verdict, so it must sit where the
  // verdict is read. Below the tick, above everything else, premise named.
  const cond = (rep.conditional && rep.conditional.findings) || [];
  if (cond.length) {
    L.push(`> ⚠ **${cond.length} CONDITIONAL finding(s)** — reachable, and outside the verdict above`);
    L.push('> because each rests on an adversary premise you may reject:');
    L.push('>');
    for (const f of cond) {
      L.push(`> - **${f.invariant}** via \`${(f.path || []).filter((x) => x.action).map((x) => x.action).join(' → ')}\``);
      L.push(`>   <br>*Premise:* ${f.premise}`);
    }
    L.push('');
  }

  // If any region tests caller scope, say what that scope rests on. A verdict
  // that turns on `declaredEffective` and does not mention that both operands
  // are hand-declared is the exact over-promise S07 §3 is about.
  if (rep.scope && rep.scope.referencedBy && rep.scope.referencedBy.length) {
    L.push(`> ⚠ **Caller scope was NOT resolved.** ${rep.scope.why}`);
    const dep = (rep.scope.dependence || []).filter((d) => d.scopeDependent);
    if (dep.length) {
      L.push('>');
      L.push(`> Run at both ends of the admissible range (${(rep.scope.comparedConjuncts || []).join(' + ')}), the answer MOVES:`);
      for (const d of dep) {
        L.push(`> - **${d.region}** — reachable at ${d.reachableAtNarrowest ? 'the narrowest' : 'the widest'} scope, `
          + `not at ${d.reachableAtNarrowest ? 'the widest' : 'the narrowest'}. It is hidden by **${d.hiddenBy}**.`);
        if (d.premise) L.push(`>   <br>*And it is CONDITIONAL — premise:* ${d.premise}`);
      }
      L.push('>');
      L.push('> So this finding\'s truth depends on a permission model nobody consulted.');
      L.push('> Neither answer is stated as fact, because neither is one.');
    } else if (rep.scope.dependence) {
      L.push('>');
      L.push(`> Checked at both ends of the admissible range (${(rep.scope.comparedConjuncts || []).join(' + ')}):`);
      L.push('> the answer is the SAME either way, so the unresolved scope does not change');
      L.push(`> those. NOT re-run at the bounds: ${(rep.scope.notCompared || []).join(', ')} —`);
      L.push('> so this is not a claim about the whole verdict.');
    } else if (rep.scope.dependenceVacuous) {
      L.push('>');
      L.push(`> Scope dependence was NOT checked: ${rep.scope.dependenceVacuous}.`);
    }
    L.push('');
  }

  const vac = (rep.verdict && rep.verdict.vacuous) || [];
  if (vac.length) {
    L.push(`> ⚠ **This verdict rests on ${6 - vac.length} of 6 conjuncts. ${vac.length} never ran**, and a check with`);
    L.push('> nothing to check reports clean. Read the tick as covering the smaller question:');
    L.push('>');
    for (const v of vac) L.push(`> - **${v.conjunct}** — ${v.why}`);
    L.push('');
  } else {
    L.push('*All six conjuncts had something to check.*');
    L.push('');
  }
  L.push(`- forbidden regions: ${rep.regions.join(', ')}`);
  L.push(`- designated gates: ${rep.gates.join(', ')}`);
  L.push(`- adversarial (havoc-writable): ${rep.adversarial.length ? rep.adversarial.join(', ') : '(none)'}`);
  L.push(rep.seal && rep.seal.declared
    ? `- scope seal: \`${rep.seal.digest}\` (${Object.entries(rep.seal.counts).map(([k, n]) => `${n} ${k}`).join(', ')}; onExcess: ${rep.seal.onExcess}${rep.seal.onExcess === 'warn' ? ' — WEAKENED posture: excess is reported, not refused' : ''})`
    : '- scope seal: NOT DECLARED — runtime capability growth past this proof cannot be detected');
  L.push('');
  L.push('| gate | result |');
  L.push('|---|---|');
  L.push(`| (a) from-init security invariant | ${rep.fromInit.ok ? 'clean ✓' : `VIOLATED ✗ (${rep.fromInit.violations.length})`} |`);
  L.push(`| (b) havoc / adversary | ${!rep.havoc.ran ? 'vacuous (no adversarial vars)' : rep.havoc.counterexamples.length ? `COUNTEREXAMPLE ✗ — unmediated: ${rep.havoc.namedVariables.join(', ')}` : 'clean ✓'} |`);
  L.push(`| (c) fully-mediated gate-deletion | ${rep.gateDeletion.ok ? `no bypass ✓${rep.gateDeletion.totalSurface ? ' (total surface: every action is a gate — only init survives deletion)' : ''}` : `BYPASS ✗ (${rep.gateDeletion.bypasses.length})`} |`);
  L.push(`| conditional regions | ${!rep.conditional || !rep.conditional.ran ? 'none declared' : rep.conditional.findings.length ? `${rep.conditional.findings.length} FINDING(S) — outside the verdict, premise named above` : `clean ✓ (${rep.conditional.regions.join(', ')})`} |`);
  L.push(`| (e) caller-havoc / confused deputy | ${!rep.callerHavoc || !rep.callerHavoc.ran ? 'vacuous (no principals declared)' : rep.callerHavoc.counterexamples.length ? `COUNTEREXAMPLE ✗ — profiles: ${rep.callerHavoc.namedProfiles.join(', ')}` : `clean ✓ (${rep.callerHavoc.profiles.length} profiles)`} |`);
  if (rep.irreversibles && rep.irreversibles.ran) {
    L.push(`| (g) irreversible-effect mediation | ${rep.irreversibles.ok ? `gated ✓ (${rep.irreversibles.tools.length} tools)` : `BYPASS ✗ (${rep.irreversibles.bypasses.length})`} |`);
  }
  if (rep.tiers && rep.tiers.obligations.length) {
    L.push(`| (d) approve-tier ordering | ${rep.tiers.ok ? `proved ✓ (${rep.tiers.obligations.length})` : `NOT PROVED ✗ (${rep.tiers.obligations.filter((o) => !o.proved).length})`} |`);
  }
  L.push('');

  if (rep.rubberStamp && rep.rubberStamp.regions.length) {
    L.push('## rubber-stamp resistance (SAIL 6.13)');
    L.push('');
    L.push('The from-init check explores approval transitions unconditionally — no');
    L.push('precondition says a human deliberated. A clean safety region is therefore');
    L.push('unreachable **even if every approval is rubber-stamped**:');
    L.push('');
    for (const r of rep.rubberStamp.regions) {
      L.push(`- \`${r.region}\`: safe under rubber-stamping — ${r.safeUnderRubberStamp ? 'YES ✓' : 'NO ✗ (reachable; see from-init counterexample)'}`);
    }
    L.push('');
  }

  if (rep.tiers && rep.tiers.obligations.length) {
    L.push('## (d) tiered authority — approve ≺ effect');
    L.push('');
    L.push('| tool | approval | effect | ordering region | verdict |');
    L.push('|---|---|---|---|---|');
    for (const o of rep.tiers.obligations) {
      L.push(`| \`${o.tool}\` | ${o.approval} | ${o.effect} | ${o.region} | ${o.proved ? 'proved ✓' : 'NOT PROVED ✗'} |`);
    }
    L.push('');
    L.push('> A tier routes what falls OUTSIDE the forbidden region; it can never make');
    L.push('> anything inside it reachable. `approve` is not a softer deny — it is the');
    L.push('> ordering constraint *approval ≺ effect*, discharged by the same check that');
    L.push('> proves handshake ≺ app-data. A tier this gate cannot establish is a finding.');
    L.push('');
  }

  if (!rep.fromInit.ok) {
    L.push('## (a) from-init counterexample(s)');
    for (const v of rep.fromInit.violations) {
      L.push(`\n**${v.invariant}** — ${v.detail}`);
      L.push('```');
      L.push(...renderPath(v.path));
      L.push('```');
    }
  }
  if (rep.havoc.ran && rep.havoc.counterexamples.length) {
    L.push('## (b) havoc counterexample(s)');
    for (const ce of rep.havoc.counterexamples) {
      L.push(`\n**${ce.invariant}** — φ violable via unmediated write to: **${ce.namedVariables.join(', ')}**`);
      L.push('```');
      L.push(...renderPath(ce.path));
      L.push('```');
    }
  }
  if (rep.callerHavoc && rep.callerHavoc.ran && rep.callerHavoc.counterexamples.length) {
    L.push('## (e) caller-havoc counterexample(s)');
    L.push(`Profiles quantified: ${rep.callerHavoc.profiles.join(', ')} (init: ${rep.callerHavoc.initProfile})`);
    for (const ce of rep.callerHavoc.counterexamples) {
      L.push(`\n**${ce.invariant}** — reachable when the session serves: **${ce.namedProfiles.join(', ')}** (declaredEffective = agent ∩ caller, both DECLARED)`);
      L.push('```');
      L.push(...renderPath(ce.path));
      L.push('```');
    }
  }
  if (rep.irreversibles && rep.irreversibles.ran && !rep.irreversibles.ok) {
    L.push('## (g) irreversible-effect bypass(es)');
    for (const b of rep.irreversibles.bypasses) {
      L.push(`\n**${b.effect}** (tool: ${b.tools.join(', ')}) — an IRREVERSIBLE effect fires with the designated gates removed, via: **${b.via.join(', ')}**`);
      L.push('```');
      L.push(...renderPath(b.path));
      L.push('```');
    }
  }
  if (!rep.gateDeletion.ok) {
    L.push('## (c) gate-deletion bypass(es)');
    L.push(`Designated gates deleted: ${rep.gateDeletion.deletedGates.join(', ')}`);
    for (const b of rep.gateDeletion.bypasses) {
      L.push(`\n**${b.region}** — reachable with the designated gates removed, via: **${b.via.join(', ')}**`);
      L.push('```');
      L.push(...renderPath(b.path));
      L.push('```');
    }
  }
  L.push('');
  L.push('> Scope: this verdict is exhaustive over the finite declared domains and');
  L.push('> the observable projection only (docs/polysec-spec.md §0). Havoc');
  L.push('> over-approximates (safe direction); gate-deletion reachability is');
  L.push('> monotone, so any bypass it reports is also a from-init violation — its');
  L.push('> distinct value is the witness that NAMES the surviving transition.');
  return L.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────
// Run as a CLI when this file — or the shim that re-exports it from packages/polysec/scripts — is the entry point.
if (process.argv[1] && basename(resolve(process.argv[1])) === basename(fileURLToPath(import.meta.url))) {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) { args[process.argv[i].slice(2)] = process.argv[i + 1]; i++; }
  if (!args.module || !args.contract || !args.security) {
    console.error('usage: node polysec-harden.mjs --module <next.cjs> --contract <c.json> --security <security.json> [--out <dir>] [--label name]');
    process.exit(2);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    console.error('note: polysec harden makes NO model calls; ANTHROPIC_API_KEY is set but will not be used.');
  }
  const { readFileSync } = await import('node:fs');
  const spec = loadSpec(args.module);
  const contract = JSON.parse(readFileSync(resolve(args.contract), 'utf-8'));
  const security = loadSecurity(args.security);
  let rep;
  try {
    rep = harden({ spec, contract, security, label: args.label || args.module });
  } catch (e) {
    console.error(`polysec harden FAILED: ${e && e.message}`);
    process.exit(2);
  }
  const md = reportMarkdown(rep);
  console.log(md);
  if (args.out) {
    const dir = resolve(args.out);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'security-report.json'), JSON.stringify(rep, null, 2));
    writeFileSync(join(dir, 'security-report.md'), md);
    console.log(`\nwrote ${join(dir, 'security-report.json')} and security-report.md`);
  }
  // Exit code: 0 iff fully mediated. A failed gate is a nonzero, PR-gateable NO.
  process.exit(rep.verdict.fullyMediated ? 0 : 1);
}
