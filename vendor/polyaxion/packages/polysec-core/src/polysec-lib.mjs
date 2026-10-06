// PolySec core — the reusable pieces the harden gates are built from.
//
// DOCTRINE: reuse, don't fork. Reachability, state equality, and stepping all
// come from the Polygraph engines next door (readonly ../polygraph):
//   • check()            — the BFS model checker (scripts/check.mjs)
//   • loadSpec, stable() — the ONE spec loader / state-equality (load-spec.mjs)
//   • makeSamAdapter,    — the {init,transition} bridge + manifest domain reader
//     domainFromManifest   (sam-adapter.cjs)
// PolySec adds only: the security.json sidecar reader, the forbidden-region
// compiler, and the two augmentations (havoc, gate-deletion) expressed as
// (module, steps) overrides handed straight to check(). No second BFS, no
// second notion of state equality.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Resolve the sibling Polygraph repo relative to THIS file so the scripts work
// from any cwd. Overridable for unusual layouts.
// Layouts, in order: POLYGRAPH_DIR (explicit); the published package @cognitive-fab/polygraph (an
// installed polyaxion); a sibling checkout next to this package's home (packages/polysec-core in
// the monorepo, so ../../../polygraph) or next to the monorepo itself.
function installedPolygraph() {
  try { return dirname(createRequire(import.meta.url).resolve('@cognitive-fab/polygraph/package.json')); } catch { return null; }
}
const polygraphCandidates = [resolve(HERE, '..', '..', '..', 'polygraph'), resolve(HERE, '..', '..', '..', '..', 'polygraph')];
export const POLYGRAPH_DIR = process.env.POLYGRAPH_DIR
  ? resolve(process.env.POLYGRAPH_DIR)
  : (installedPolygraph() ?? polygraphCandidates.find((d) => existsSync(resolve(d, 'scripts', 'check.mjs'))) ?? polygraphCandidates[0]);
/** Where the engines came from: 'env' | 'package' | 'sibling' | 'missing' — reported by polyaxion's status. */
export const POLYGRAPH_SOURCE = process.env.POLYGRAPH_DIR ? 'env' : installedPolygraph() ? 'package' : existsSync(resolve(POLYGRAPH_DIR, 'scripts', 'check.mjs')) ? 'sibling' : 'missing';

const pgUrl = (rel) => pathToFileURL(resolve(POLYGRAPH_DIR, 'scripts', rel)).href;

// check.mjs re-exports loadSpec; sam-adapter is CJS.
export const { check, render, loadSpec } = await import(pgUrl('check.mjs'));
// `stable()` is the ONE notion of state equality (doctrine: no second one).
// The canonicaliser's bytes must agree with it — asserted in
// test/polysec-canon.test.mjs (notary spec §3.4).
export const { stable } = await import(pgUrl('load-spec.mjs'));
const samAdapter = createRequire(import.meta.url)(resolve(POLYGRAPH_DIR, 'scripts', 'sam-adapter.cjs'));
export const { makeSamAdapter, domainFromManifest, isSamV2Module } = samAdapter;

export const HAVOC = '__HAVOC__';

// Region kinds (SAIL spec §2.5a / F-E-1). `safety` = must never happen, full
// stop; `ordering` = states that an effect fired without its prerequisite
// (approval ≺ effect, handshake ≺ app-data). The distinction is what lets the
// rubber-stamp report speak only about the regions where "unreachable even
// when every approval is granted" is the meaningful claim.
//
// `conditional` = a region whose reachability is proved EXACTLY like a safety
// region, but whose adversary premise is declared and may be rejected by the
// reader. The motivating case (S07 §8a.3): with `on.roles` gated to write
// access, a stranger cannot fire the workflow, but a collaborator's account can
// be phished, stolen or turned. The disclosure path is identical; what differs
// is whether you accept that premise.
//
// It is NOT part of `fullyMediated`, and that is a deliberate, narrow claim:
// a verdict must not depend on an assumption the reader did not make. It is
// also NOT hidden — a conditional region that is reachable is reported beside
// the verdict with its premise named, and CI can be told to fail on it.
// Silence would just be the old bug wearing a new word.
export const REGION_KINDS = ['safety', 'ordering', 'conditional'];

/** Read + minimally validate a security.json manifest. Loud on malformed input. */
export function loadSecurity(pathArg) {
  const abs = resolve(pathArg);
  let raw;
  try { raw = JSON.parse(readFileSync(abs, 'utf-8')); }
  catch (e) { throw new Error(`security.json '${pathArg}': ${e && e.message}`); }
  for (const k of ['projection', 'protected', 'adversarial', 'forbiddenRegions', 'gates']) {
    if (!(k in raw)) throw new Error(`security.json '${pathArg}': missing required key '${k}'`);
  }
  if (!Array.isArray(raw.forbiddenRegions) || raw.forbiddenRegions.length === 0) {
    throw new Error(`security.json '${pathArg}': forbiddenRegions must be a non-empty array`);
  }
  for (const r of raw.forbiddenRegions) {
    if (!r || typeof r !== 'object') continue; // securityInvariants throws the shape error
    if (r.kind === undefined) {
      // Default is `safety` — the CONSERVATIVE direction: it makes the
      // rubber-stamp report stricter, never falsely reassuring. Named loudly
      // so manifests migrate rather than lean on the default forever.
      console.warn(`security.json '${pathArg}': region '${r.name}' declares no 'kind' — defaulting to 'safety' (declare "kind": "safety" | "ordering" explicitly)`);
      r.kind = 'safety';
    } else if (!REGION_KINDS.includes(r.kind)) {
      throw new Error(`security.json '${pathArg}': region '${r.name}' has unknown kind '${r.kind}' — kinds are ${REGION_KINDS.join(' | ')}`);
    }
  }
  if (raw.capabilitySet !== undefined) validateCapabilitySet(raw.capabilitySet, pathArg);
  if (raw.principals !== undefined) validatePrincipals(raw.principals, pathArg);
  return raw;
}

// ── Principal profiles (SAIL spec §2.3 / P1-A, SAIL 5.20) ───────────────────

function validatePrincipals(p, where = 'security.json') {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`${where}: principals must be an object`);
  if (!p.profiles || typeof p.profiles !== 'object' || Object.keys(p.profiles).length === 0) {
    throw new Error(`${where}: principals.profiles must be a non-empty object — a profile set that cannot be enumerated cannot be checked (F-C-5)`);
  }
  for (const [name, prof] of Object.entries(p.profiles)) {
    if (!prof || !Array.isArray(prof.entitlements) || prof.entitlements.some((e) => typeof e !== 'string')) {
      throw new Error(`${where}: principals.profiles['${name}'].entitlements must be an array of strings`);
    }
  }
  if (!Array.isArray(p.agent) || p.agent.some((e) => typeof e !== 'string')) {
    throw new Error(`${where}: principals.agent must be an array of strings — declaredEffective is agent ∩ caller, and an unstated agent side makes the intersection undefined`);
  }
  if (typeof p.init !== 'string' || !(p.init in p.profiles)) {
    throw new Error(`${where}: principals.init '${p.init}' is not a declared profile — an undeclared caller profile is refused, not defaulted (F-C-5)`);
  }
}

/**
 * The predicate bindings a principals block provides.
 *
 *   caller             the current profile name
 *   declaredEffective  agent ∩ caller entitlements — SAIL 5.20's formula,
 *                      computed rather than prescribed
 *   effective          the SAME function, kept working for manifests that
 *                      already say `effective`
 *
 * Computed FROM state, never stored IN it, so the state space does not grow.
 * On a state with no `caller` key (the base machine, outside the caller-havoc
 * augmentation) the caller is the declared init profile.
 *
 * ── WHY THE CANONICAL NAME IS `declaredEffective` (S07 §3) ──────────────────
 *
 * BOTH OPERANDS ARE DECLARED. `p.agent` is a hand-typed string array and
 * `profiles[x].entitlements` is a hand-typed string array; the loader checks
 * that they are arrays of strings and nothing further. Nothing here resolves a
 * real permission model — no sharing rule, no grant inheritance, no
 * requested-vs-granted reconciliation.
 *
 * So this computes the intersection of two DECLARED sets: a narrower declared
 * scope, not an effective one. The bare name `effective` promised a resolution
 * that does not exist anywhere in this repository, and a reader of the manifest
 * saw the word and stopped asking. That is the most dangerous form the
 * declared-vs-effective gap takes, because it is invisible.
 *
 * `effective` still resolves — breaking every manifest that already uses it
 * would be a worse trade — but the honest name is the one generated manifests
 * emit, and `scopeProvenance()` puts the limitation on the verdict as DATA so
 * it does not depend on anyone reading this comment.
 */
export function principalBindings(security) {
  const p = security && security.principals;
  if (!p) return null;
  const agent = new Set(p.agent);
  const callerOf = (s) => (s && s.caller !== undefined ? s.caller : p.init);
  const intersect = (s) => {
    const who = callerOf(s);
    const prof = p.profiles[who];
    if (!prof) throw new Error(`principals: state names caller '${who}', which is not a declared profile`);
    return prof.entitlements.filter((e) => agent.has(e));
  };
  return {
    caller: callerOf,
    declaredEffective: intersect,
    effective: intersect,          // the older spelling, still honoured
  };
}

/** Every binding name that means "agent ∩ caller". */
export const EFFECTIVE_BINDINGS = ['declaredEffective', 'effective'];

/**
 * Does this predicate read a caller-scope binding?
 *
 * ONE definition, used by the orphan guard, by `scopeProvenance`, and by the
 * experiment. Built from an escaped STRING rather than a template literal on
 * purpose: a backslash-b escape inside a template literal or a quoted string
 * regex compiles cleanly and matches nothing, and every caller silently
 * reports "no scope reference". That exact bug shipped twice in one day.
 */
export function referencesScope(predicate) {
  if (typeof predicate !== 'string') return false;
  const B = String.raw`\b`;                    // NOT '\b' — that is BACKSPACE
  return EFFECTIVE_BINDINGS.some((b) => new RegExp(B + b + B).test(predicate));
}

/**
 * The manifest with caller scope pinned to one END of its admissible range.
 *
 *   'widest'     every profile holds the full declared agent set, so
 *                declaredEffective = agent
 *   'narrowest'  no profile holds anything, so declaredEffective = ∅
 *
 * These are the true mathematical bounds on `agent ∩ caller` when the caller
 * side is unresolved: the intersection cannot exceed `agent`, and cannot go
 * below empty. Whatever a real permission model would say lies between them.
 *
 * THE AGENT SIDE IS LEFT ALONE. It is the grant, and widening it models a
 * different question — an agent with more authority than it declared, which is
 * the scope seal's job, not this one.
 *
 * Shared with `examples/polysec-scope-dependence/run.mjs` deliberately: an
 * experiment that measures a bound with its own private copy of that bound is
 * measuring its copy.
 */
export function atScopeBound(security, end) {
  // Argument check FIRST. Behind the no-principals guard it would silently
  // no-op on a typo, in exactly the configuration where the caller has no
  // other signal that nothing happened.
  if (end !== 'widest' && end !== 'narrowest') {
    throw new Error(`atScopeBound: end must be 'widest' | 'narrowest', got '${end}'`);
  }
  const p = security && security.principals;
  if (!p) return security;
  const ents = end === 'widest' ? [...p.agent] : [];
  return {
    ...security,
    principals: {
      ...p,
      profiles: Object.fromEntries(Object.keys(p.profiles).map((k) => [k, { entitlements: [...ents] }])),
    },
  };
}

/**
 * WHAT THE SCOPE IN THIS PROOF ACTUALLY RESTS ON, as data.
 *
 * Same move as the coverage grade and the vacuity list: a limitation that only
 * exists in prose is a limitation nobody applies. Any consumer can now refuse a
 * verdict whose scope was never resolved, or say so beside it, without reading
 * a docstring.
 *
 * `resolved` was hard-coded false until a permission-model resolver existed
 * (S07 §5). One now does — pass the output of `resolveScope`
 * (`polysec-scope-snapshot.mjs`) as `resolution` and this is where it announces
 * itself. Without one the answer is unchanged, which is the honest default.
 *
 * Note that `resolved: true` does NOT mean "fully known". A snapshot resolves
 * what its permission model can enumerate offline and marks the rest UNKNOWN,
 * because falsification 1 showed all three real models have a residual that no
 * flat capability set can hold. `partial` carries that, and a consumer that
 * reads only `resolved` and stops is making the §3 mistake again.
 */
export function scopeProvenance(security, resolution = null) {
  const p = security && security.principals;
  const regions = (security && security.forbiddenRegions) || [];
  const referencedBy = regions
    .filter((r) => r && referencesScope(r.predicate))
    .map((r) => r.name);
  if (!p) return { declared: false, resolved: false, referencedBy, why: 'no principals block — this proof makes no claim about caller scope' };

  if (resolution && resolution.resolved) {
    return {
      declared: true,
      resolved: true,
      partial: !!resolution.anyUnknown,
      basis: resolution.basis,
      model: resolution.model,
      snapshot: resolution.snapshot,
      capturedAt: resolution.capturedAt,
      agentSource: 'security.json principals.agent — hand-declared. The GRANT side is declared by design; resolving it is the scope seal\'s job, not this one',
      callerSource: `resolved against a ${resolution.model} snapshot (${resolution.snapshot})`,
      referencedBy,
      why: resolution.anyUnknown
        ? `caller scope was RESOLVED against a ${resolution.model} snapshot, but some capabilities remain UNKNOWN and stay bracketed rather than assumed — see the resolution records for the residual predicates (S07 §8.1)`
        : `caller scope was fully resolved against a ${resolution.model} snapshot; no capability is undecided, so no verdict here can be scope-dependent`,
    };
  }

  return {
    declared: true,
    resolved: false,
    basis: 'declared ∩ declared',
    agentSource: 'security.json principals.agent — hand-declared, not resolved from a permission model',
    callerSource: 'security.json principals.profiles[*].entitlements — hand-declared',
    referencedBy,
    why: referencedBy.length
      ? `region(s) ${referencedBy.join(', ')} test a caller scope that NO PERMISSION MODEL WAS CONSULTED FOR. Both operands are declared, so this is a narrower DECLARED scope, not an effective one (S07 §3).`
      : 'no region tests caller scope, so nothing in this verdict depends on it',
  };
}

// ── Scope seal (SAIL spec §2.2 / P0-B) ──────────────────────────────────────

export const SEAL_ON_EXCESS = ['warn', 'deny-new', 'fail-closed'];

// The GRANTED half of the catalogue: capability somebody deliberately handed
// to the agent.
export const SEAL_GRANTED_FIELDS = ['tools', 'mcpServers', 'connectors', 'scopes'];

// The AMBIENT half: capability a workload holds by virtue of WHERE IT RUNS,
// which nobody granted per-workload and which therefore nobody reviews.
//
// This half exists because of the July 2026 Hugging Face intrusion. Every leg
// of that campaign rode on ambient authority: the service-account token every
// pod carries, a reachable instance-metadata endpoint, a database password
// sitting in the environment, a secret object with 136 keys within reach, and
// unrestricted egress to paste sites. Not one of those is a tool, an MCP
// server, a connector or a scope, so the original seal could not see any of it
// — a policy could be perfectly proved and perfectly sealed while running
// inside all of that.
//
//   mounts     filesystem paths the workload can read (token projections,
//              secret volumes, docker sockets)
//   envKeys    environment variable NAMES that carry authority. NAMES ONLY —
//              see the identifier check below.
//   endpoints  network endpoints reachable from the workload (metadata
//              services, internal brokers). DECLARED, never probed: probing is
//              a network call and this toolchain does not make them.
//   egress     outbound destinations the workload may reach.
export const SEAL_AMBIENT_FIELDS = ['mounts', 'envKeys', 'endpoints', 'egress'];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateCapabilitySet(cs, where = 'security.json') {
  if (!cs || typeof cs !== 'object' || Array.isArray(cs)) {
    throw new Error(`${where}: capabilitySet must be an object`);
  }
  for (const f of SEAL_GRANTED_FIELDS) {
    if (cs[f] === undefined) continue;
    if (!Array.isArray(cs[f]) || cs[f].some((x) => typeof x !== 'string')) {
      throw new Error(`${where}: capabilitySet.${f} must be an array of strings`);
    }
  }
  if (cs.ambient !== undefined) {
    const amb = cs.ambient;
    if (!amb || typeof amb !== 'object' || Array.isArray(amb)) {
      throw new Error(`${where}: capabilitySet.ambient must be an object of ${SEAL_AMBIENT_FIELDS.join(' | ')}`);
    }
    for (const k of Object.keys(amb)) {
      if (!SEAL_AMBIENT_FIELDS.includes(k)) {
        throw new Error(`${where}: capabilitySet.ambient.${k} is not an ambient field — fields are ${SEAL_AMBIENT_FIELDS.join(' | ')} (an unrecognised one would seal nothing while looking like it did)`);
      }
      if (!Array.isArray(amb[k]) || amb[k].some((x) => typeof x !== 'string')) {
        throw new Error(`${where}: capabilitySet.ambient.${k} must be an array of strings`);
      }
    }
    // NAMES, NEVER VALUES. A manifest is committed, diffed and shipped to an
    // auditor; a secret VALUE in it is a disclosure, not a declaration. An env
    // name is a plain identifier, so anything else is refused rather than
    // sealed — the check cannot catch every value, but it catches the shape of
    // one, and a loud refusal beats a committed credential.
    for (const k of amb.envKeys || []) {
      if (!ENV_NAME.test(k)) {
        throw new Error(`${where}: capabilitySet.ambient.envKeys entry '${k.slice(0, 12)}…' is not an environment variable NAME — declare the name, never the value (a manifest is committed and shipped to auditors)`);
      }
    }
  }
  if (cs.onExcess !== undefined && !SEAL_ON_EXCESS.includes(cs.onExcess)) {
    throw new Error(`${where}: capabilitySet.onExcess '${cs.onExcess}' — must be ${SEAL_ON_EXCESS.join(' | ')}`);
  }
}

/**
 * Compare an OBSERVED capability catalogue against the SEALED (declared) one.
 *
 * The asymmetry is the feature (F-B-5, doctrine 26): EXCESS capability —
 * observed but never proved over — voids the proof. MISSING capability does
 * not: a catalogue that shrank is a narrowing, and narrowing is automatic.
 *
 * Returns { ok, excess, missing, action }. `ok` is false iff excess exists.
 * `action` is what the caller must do about it: 'warn' | 'deny-new' |
 * 'fail-closed' (default deny-new — the undeclared capability is refused,
 * the declared ones keep working).
 */
export function sealCheck(observed, security) {
  const cs = security && security.capabilitySet;
  if (!cs) {
    return { ok: false, ran: false, reason: 'no capabilitySet declared — seal check is vacuous', excess: [], missing: [], action: null };
  }
  validateCapabilitySet(cs);
  const obs = observed || {};
  const excess = [];
  const missing = [];
  for (const f of SEAL_GRANTED_FIELDS) {
    const sealed = new Set(cs[f] || []);
    const seen = new Set(obs[f] || []);
    for (const x of seen) if (!sealed.has(x)) excess.push(`${f}:${x}`);
    for (const x of sealed) if (!seen.has(x)) missing.push(`${f}:${x}`);
  }
  // The ambient half, under the SAME asymmetry. A workload that shed a mount
  // narrowed; one that gained a service-account token widened past its proof.
  // Declaring no `ambient` block is VACUOUS, not clean: it means nobody asked,
  // and the result says so rather than reporting an empty diff as agreement.
  const ambientDeclared = cs.ambient !== undefined;
  const ambientObserved = SEAL_AMBIENT_FIELDS.some((f) => obs.ambient && obs.ambient[f] !== undefined);
  if (ambientDeclared) {
    for (const f of SEAL_AMBIENT_FIELDS) {
      const sealed = new Set((cs.ambient && cs.ambient[f]) || []);
      const seen = new Set((obs.ambient && obs.ambient[f]) || []);
      for (const x of seen) if (!sealed.has(x)) excess.push(`ambient.${f}:${x}`);
      for (const x of sealed) if (!seen.has(x)) missing.push(`ambient.${f}:${x}`);
    }
  }
  const ambient = ambientDeclared
    ? {
        ran: true,
        excess: excess.filter((x) => x.startsWith('ambient.')).sort(),
        missing: missing.filter((x) => x.startsWith('ambient.')).sort(),
      }
    : {
        ran: false,
        reason: ambientObserved
          ? 'the runtime reported ambient authority (mounts, env keys, endpoints, egress) and the manifest seals none of it — the clause is VACUOUS, and what it would have covered is exactly where the July 2026 Hugging Face campaign lived'
          : 'no capabilitySet.ambient declared — the ambient clause is vacuous. Capability a workload holds by virtue of where it runs is unsealed and therefore unchecked',
        excess: [],
        missing: [],
      };
  return {
    ok: excess.length === 0,
    ran: true,
    excess: excess.sort(),
    missing: missing.sort(),   // reported, never a failure — see the asymmetry
    ambient,
    action: cs.onExcess || 'deny-new',
  };
}

/**
 * Compile a forbidden-region predicate string (over bare state-variable names,
 * e.g. "untrusted && sensitive && egress") into (state) => boolean, TRUE when
 * the state is INSIDE the region. The state keys are destructured in scope so
 * the expression may also read e.g. capabilities.length. The expression comes
 * from the (human-confirmed) manifest — author-controlled config, same trust as
 * a contract's dataDomain.
 */
export function compileRegion(predicate, stateKeys, bindings = null) {
  const keys = [...stateKeys];
  // Names are interpolated into a Function body (the predicate itself is
  // author-controlled manifest, same trust as a contract's dataDomain — see
  // the docstring), so every NAME must be a plain identifier: a state key or
  // binding name that could close a const and open a statement is refused.
  const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  // Bindings (e.g. `declaredEffective`, `caller` from a principals block) are COMPUTED
  // from state, not injected as state — the state space does not grow. A
  // binding whose name is already a state key defers to the state key.
  const bnames = bindings ? Object.keys(bindings).filter((n) => !keys.includes(n)) : [];
  for (const n of [...keys, ...bnames]) {
    if (!IDENT.test(n)) throw new Error(`compileRegion: '${n}' is not a plain identifier — refusing to compile a predicate over it`);
  }
  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function('__s', '__b',
      `const { ${keys.join(', ')} } = __s; ` +
      bnames.map((n) => `const ${n} = __b['${n}'](__s); `).join('') +
      `return (${predicate});`);
  } catch (e) {
    throw new Error(`forbidden-region predicate '${predicate}' failed to compile: ${e && e.message}`);
  }
  return (state) => {
    try { return !!fn(state, bindings); }
    catch (e) { throw new Error(`forbidden-region predicate '${predicate}' threw on a state: ${e && e.message}`); }
  };
}

/** State-key names from a spec's init snapshot (the canonical shape). */
export function stateKeysOf(spec) {
  const base = makeSamAdapter(spec);
  return Object.keys(base.init());
}

/**
 * Build check()-shaped stateInvariants from the forbidden regions — one per
 * region, HOLDS (true) exactly when the state is OUTSIDE the region. This is the
 * security invariant the from-init / havoc / gate-deletion checks all evaluate.
 */
export function securityInvariants(security, stateKeys) {
  const bindings = principalBindings(security);
  // A region that reads `declaredEffective` with no principals block compiles
  // to an UNBOUND IDENTIFIER. The ReferenceError is thrown inside the
  // predicate, `check` catches it and records a violation, and the region
  // reports REACHABLE for a reason that has nothing to do with the state. A
  // wrong answer that looks like a finding is worse than an error.
  if (!bindings) {
    const orphan = (security.forbiddenRegions || []).find((r) => r && typeof r.predicate === 'string'
      && referencesScope(r.predicate));
    if (orphan) {
      throw new Error(`security.json: region '${orphan.name}' reads a caller-scope binding but no 'principals' block is declared — the identifier is unbound, so the region would report REACHABLE for a reason unrelated to the state. Declare principals or drop the scope test.`);
    }
  }
  const compiled = security.forbiddenRegions.map((r) => {
    if (!r || typeof r.predicate !== 'string' || !r.name) {
      throw new Error('each forbiddenRegion needs a { name, predicate } — got ' + JSON.stringify(r));
    }
    const inRegion = compileRegion(r.predicate, stateKeys, bindings);
    return { name: `forbidden:${r.name}`, region: r.name, kind: r.kind || 'safety', premise: r.premise || null, inRegion, pred: (s) => !inRegion(s) };
  });
  // Conditional regions are split OUT of `stateInvariants` so that every
  // existing consumer keeps the exact meaning it had: what participates in a
  // mediation verdict is unchanged. `harden` checks the conditional set
  // separately and reports it beside the verdict, never inside it.
  return {
    stateInvariants: compiled.filter((i) => i.kind !== 'conditional'),
    conditionalInvariants: compiled.filter((i) => i.kind === 'conditional'),
  };
}

/** The finite havoc domain for an adversarial variable. */
function havocDomain(security, variable, initState) {
  const declared = security.domains && security.domains[variable];
  if (Array.isArray(declared) && declared.length) return declared;
  if (typeof initState[variable] === 'boolean') return [false, true];
  throw new Error(
    `adversarial variable '${variable}' has no finite domain — declare it in security.json "domains" ` +
    `(no silent skip: an unbounded adversarial variable cannot be havoc-checked)`
  );
}

/**
 * The augmented machine `modeled ∪ havoc`. `havoc` is a single action whose
 * (action, data) STEPS each nondeterministically set ONE adversarial variable
 * to ONE value in its declared finite domain — so a counterexample that uses a
 * havoc edge NAMES the unmediated variable via step.data.var. Returned as an
 * ALREADY-ADAPTED {init,transition} relation + explicit steps, handed straight
 * to check() (no second BFS). check() admits a pre-adapted relation only with
 * an explicit `steps` domain, since it carries no manifest() to read one from.
 */
export function augmentWithHavoc(spec, security) {
  const base = makeSamAdapter(spec);
  const init = base.init();
  const { steps: modeled } = domainFromManifest(spec);
  const havocSteps = [];
  for (const v of security.adversarial) {
    for (const value of havocDomain(security, v, init)) {
      havocSteps.push({ action: HAVOC, data: { var: v, value } });
    }
  }
  const module = {
    init: base.init,
    transition: (state, action, data) => {
      if (action === HAVOC) return { ...state, [data.var]: data.value };
      return base.transition(state, action, data);
    },
  };
  return { module, steps: [...modeled, ...havocSteps], havocSteps, modeledSteps: modeled };
}

/**
 * The gate-deleted machine: the modeled machine with the security.json `gates`
 * transitions removed from the explored alphabet. Reachability to a forbidden
 * region over THIS machine is a bypass of the designated gates.
 */
export function deleteGates(spec, security) {
  const base = makeSamAdapter(spec);
  const gates = new Set(security.gates);
  const { steps: modeled, notes } = domainFromManifest(spec);
  const kept = modeled.filter((s) => !gates.has(s.action));
  const deletedActions = [...new Set(modeled.map((s) => s.action))].filter((a) => gates.has(a));
  return { module: { init: base.init, transition: base.transition }, steps: kept, deletedActions, notes };
}

// ── Misfire classes (docs/polysec-speech-acts.md §2) ────────────────────────
// A reject reason is '<misfire>:<detail>' where <misfire> is one of the four
// closed felicity classes. SAM's reject() takes a string, so the class rides
// as a reason prefix — no substrate change. The enum is CLOSED: a reject site
// that fits none of the four is a design finding, not a fifth class.
// Insincerity is deliberately NOT a class — it is undetectable at gate time
// (the gate rules on the declaration) and is audited after the fact.
export const MISFIRE_CLASSES = ['no-procedure', 'wrong-participant', 'bad-execution', 'wrong-state'];

/**
 * Parse a reject reason into { misfire, detail }. An unprefixed reason (legacy
 * or third-party machine) parses as { misfire: null, detail: reason } — never
 * a throw, so mixed corpora stay readable. A prefix OUTSIDE the closed enum is
 * treated as detail, not silently accepted as a new class.
 */
export function parseMisfire(reason) {
  if (typeof reason !== 'string' || reason.length === 0) return { misfire: null, detail: reason || null };
  const i = reason.indexOf(':');
  if (i > 0) {
    const head = reason.slice(0, i);
    if (MISFIRE_CLASSES.includes(head)) return { misfire: head, detail: reason.slice(i + 1) };
  }
  return { misfire: null, detail: reason };
}

/**
 * Was this refusal ATTRIBUTABLE TO THE FORBIDDEN REGION, or an ordinary
 * out-of-order call any system would refuse?
 *
 * The felicity class (`wrong-state`, …) says what KIND of misfire it was. It
 * does not say whether the policy earned the refusal, and those are different
 * questions: a benchmark that counts "already-read" and "would complete the
 * trifecta" as the same refusal reports a flattering false-positive rate.
 *
 * The convention is a second prefix inside the detail — `wrong-state:region:…`
 * — and this reads it back. It lives here rather than in each example because
 * it was written privately three times before this, and the copy that forgot to
 * return `code` silently reported ZERO region refusals across two benchmarks.
 *
 * Returns { decision, post, misfire, code, reason } where code is
 * 'region' | 'precondition' | 'malformed' | 'unknown-act' | null.
 */
export function classifyRefusal(m) {
  const detail = (m && m.detail) || '';
  if (!m || m.decision !== 'reject') {
    return { ...m, code: null, reason: detail || null };
  }
  if (detail.startsWith('region:')) return { ...m, code: 'region', reason: detail.slice('region:'.length) };
  if (m.misfire === 'no-procedure') return { ...m, code: 'unknown-act', reason: detail };
  if (m.misfire === 'bad-execution') return { ...m, code: 'malformed', reason: detail };
  return { ...m, code: 'precondition', reason: detail };
}

/**
 * A mediator over a SAM v2 spec — the broker kernel's mediate() in miniature
 * (docs/polysec-broker-spec.md §3.1), for demos, trace generators and tests.
 * mediate(state, action, data) returns
 *   { decision:'allow',  post }                                  on success
 *   { decision:'reject', post: state, misfire, detail, reason }  on a gate reject
 * and maps an action the spec does not export to a 'no-procedure' reject —
 * the default-deny branch: an utterance with no accepted procedure behind it
 * cannot succeed, and that failure is an observable outcome, not a crash.
 */
export function makeMediator(spec) {
  const base = makeSamAdapter(spec);
  const mediate = (state, action, data = {}) => {
    // Normalize the pre-state FIRST, so EVERY window — allow, reject, and
    // no-procedure alike — carries the same init-merged key set even from a
    // partial seed state.
    const pre = { ...base.init(), ...JSON.parse(JSON.stringify(state)) };
    // No accepted procedure — checked STRUCTURALLY before dispatch (the fact
    // is spec.actions itself, never the wording of a downstream throw).
    if (!spec.actions || typeof spec.actions[action] !== 'function') {
      const reason = `no-procedure:unknown-action '${action}'`;
      return { decision: 'reject', post: pre, reason, ...parseMisfire(reason) };
    }
    const dispatched = JSON.parse(JSON.stringify(pre));
    let post;
    try {
      post = base.transition(dispatched, action, data);
    } catch (e) {
      // The adapter's mutate-then-reject diagnosis is a SPEC DEFECT — loud.
      if (e && /mutated the observable model/.test(e.message || '')) throw e;
      // A genuine raise on this proposal (schema violation, acceptor throw)
      // is a malformed-data denial in the felicity taxonomy — journaled as a
      // classified reject, never a mid-corpus crash.
      const reason = `bad-execution:action-raised (${(e && e.message) || e})`;
      return { decision: 'reject', post: pre, reason, ...parseMisfire(reason) };
    }
    // Rejection detection uses TWO independent signals, either sufficient:
    //   • structural — the adapter returns the INPUT object itself on every
    //     rejected/gated path (v2 lastStep and v1 error-slot alike) and a
    //     fresh snapshot on success (identity is today's adapter behavior,
    //     not a documented contract — hence the second signal);
    //   • observable — the instance's own lastStep() classification.
    // A reject neither can explain stays a reject (fail-closed).
    let step = null;
    try {
      const acc = spec.instance({});
      if (typeof acc.lastStep === 'function') step = acc.lastStep();
    } catch { step = null; }
    const stepRejected = step && step.classification === 'rejected'
      && (step.intent === undefined || step.intent === action);
    if (post === dispatched || stepRejected) {
      const reason = stepRejected ? ((step.rejections && step.rejections[0] && step.rejections[0].reason) ?? null) : null;
      return { decision: 'reject', post: pre, reason, ...parseMisfire(reason) };
    }
    return { decision: 'allow', post };
  };
  return { init: base.init, mediate };
}

/**
 * Drive a spec through the mediator, one window per step — the ONE
 * journaled-window assembly loop the trace/journal generators share. Each
 * step is { action, data?, ...anything }; the optional `decorate(w, m, step)`
 * hook returns the final window (labels, session fields).
 */
export function driveMediated(spec, steps, decorate) {
  const { init, mediate } = makeMediator(spec);
  let state = init();
  const windows = [];
  for (const step of steps) {
    const { action, data = {} } = step;
    const m = mediate(state, action, data);
    const w = { pre: state, action, data, post: m.post, decision: m.decision };
    if (m.decision === 'reject') { w.misfire = m.misfire; w.reason = m.reason; }
    windows.push(decorate ? decorate(w, m, step) : w);
    state = m.post;
  }
  return windows;
}

/**
 * Census of the journaled rejects, grouped by misfire class. Windows without a
 * decision field are counted as allowed history (older journals) — reported in
 * `unclassified` only when they carry an explicit reject.
 */
export function misfireCensus(journal = []) {
  const byMisfire = Object.fromEntries(MISFIRE_CLASSES.map((c) => [c, 0]));
  let rejects = 0;
  let unclassified = 0;
  for (const w of journal) {
    if (!w || w.decision !== 'reject') continue;
    rejects++;
    // Prefer the window's own class, but a null/absent field falls back to
    // parsing the reason — presence of the key must never defeat the fallback.
    const misfire = w.misfire ?? parseMisfire(w.reason).misfire;
    // Own-key check: `in` would match inherited keys ('constructor', …) and
    // let a corrupt value silently pollute the census.
    if (misfire && Object.hasOwn(byMisfire, misfire)) byMisfire[misfire]++;
    else unclassified++;
  }
  return { rejects, byMisfire, unclassified };
}

/** One-line census rendering shared by every CLI that reports it. */
export function renderCensus(census) {
  const mis = Object.entries(census.byMisfire).filter(([, n]) => n > 0).map(([c, n]) => `${c}=${n}`).join(' ');
  return `${census.rejects}${mis ? ` (${mis})` : ''}${census.unclassified ? ` unclassified=${census.unclassified}` : ''}`;
}

// ── Tiered authority (docs/polysec-notary-spec.md §6) ───────────────────────
export const TIERS = ['deny', 'approve', 'allow'];

/**
 * The obligations a tool catalogue creates. An `approve` tier is NOT a softer
 * deny — it is the ordering constraint *approval ≺ effect*, which is UC-3 and
 * which the checker already handles. So each approve-tiered tool must name its
 * approval transition, its effect transition, and the forbidden region that
 * states the ordering; `harden` then discharges it exactly as it discharges
 * handshake ≺ app-data.
 *
 * Doctrine 11: tiers route; they never relax. Anything a tier touches is
 * OUTSIDE the forbidden region — a tier can never make the region reachable.
 */
export const REVERSIBILITY = ['reversible', 'compensable', 'irreversible'];

export function tierObligations(security) {
  const tools = (security && security.tools) || {};
  const regionNames = new Set((security.forbiddenRegions || []).map((r) => r.name));
  const obligations = [];
  for (const [tool, decl] of Object.entries(tools)) {
    const tier = decl && decl.tier;
    if (!TIERS.includes(tier)) {
      throw new Error(`tool '${tool}': unknown tier '${tier}' — tiers are ${TIERS.join(' | ')} (an unmapped tool is deny; silence is denial)`);
    }
    // Reversibility (SAIL spec §2.6 / SAIL 6.14). Declared, and CONSUMED —
    // a classification nothing consumes is decoration (doctrine 30).
    if (decl.reversibility !== undefined) {
      if (!REVERSIBILITY.includes(decl.reversibility)) {
        throw new Error(`tool '${tool}': unknown reversibility '${decl.reversibility}' — ${REVERSIBILITY.join(' | ')}`);
      }
      // F-F-4: an irreversible effect on the 'allow' tier is a LOAD-TIME
      // error. What cannot be undone is approved or denied, never waved past.
      if (decl.reversibility === 'irreversible' && tier === 'allow') {
        throw new Error(`tool '${tool}' is irreversible and tier 'allow' — an irreversible effect must be 'approve' or 'deny' (F-F-4): what cannot be undone is never waved past`);
      }
    }
    if (tier !== 'approve') continue;
    for (const k of ['approval', 'effect', 'ordering']) {
      if (!decl[k]) {
        throw new Error(`tool '${tool}' is tier 'approve' but names no '${k}' — an approve tier is an ORDERING constraint (approval ≺ effect) and must say which transitions and which region state it, or it is a configuration pretending to be a proof`);
      }
    }
    if (!regionNames.has(decl.ordering)) {
      throw new Error(`tool '${tool}' is tier 'approve' and names ordering region '${decl.ordering}', which is not declared in forbiddenRegions — refusing to report a tier whose ordering nothing checks`);
    }
    obligations.push({ tool, approval: decl.approval, effect: decl.effect, region: decl.ordering });
  }
  return obligations;
}

/**
 * Discharge the obligations against a completed from-init result: the ordering
 * region must have been checked AND found clean. Returns per-obligation
 * verdicts; `ok` is false if any approve tier is unproved.
 */
export function dischargeTiers(security, fromInit) {
  const obligations = tierObligations(security);
  const violatedRegions = new Set(
    (fromInit.violations || []).map((v) => String(v.invariant).replace(/^forbidden:/, ''))
  );
  const results = obligations.map((o) => ({
    ...o,
    proved: !violatedRegions.has(o.region),
    why: violatedRegions.has(o.region)
      ? `ordering region '${o.region}' is REACHABLE — the effect can happen without its approval, so this tier is not proved`
      : `approval ≺ effect established via region '${o.region}'`,
  }));
  return { ok: results.every((r) => r.proved), obligations: results };
}

// ── Caller havoc (SAIL spec §3.2 check (e) / P1-A) ─────────────────────────

export const CALLER_HAVOC = '__CALLER__';

/**
 * The caller-augmented machine: state gains a `caller` variable (initialised
 * to the declared init profile) and one CALLER_HAVOC step per declared
 * profile — maximal nondeterminism over WHO the session serves, the same
 * shape as the existing havoc with a different quantifier. The base machine
 * never sees the extra key: it is stripped before dispatch and re-attached
 * after, so machines that know nothing about principals run unmodified.
 *
 * Note the model this buys deliberately INCLUDES mid-session caller switches
 * (SAIL 5.18, session smuggling): a design is only clean if every profile is
 * safe at every point, not just at session start.
 */
export function augmentWithCaller(spec, security) {
  const p = security.principals;
  if (!p) throw new Error('augmentWithCaller: no principals declared');
  const base = makeSamAdapter(spec);
  if ('caller' in base.init()) {
    throw new Error(`augmentWithCaller: the machine already has a state key 'caller' — refusing to shadow it`);
  }
  const { steps: modeled } = domainFromManifest(spec);
  const callerSteps = Object.keys(p.profiles).map((name) => ({ action: CALLER_HAVOC, data: { var: 'caller', value: name } }));
  const module = {
    init: () => ({ ...base.init(), caller: p.init }),
    transition: (state, action, data) => {
      if (action === CALLER_HAVOC) return { ...state, caller: data.value };
      const { caller, ...rest } = state;
      return { ...base.transition(rest, action, data), caller };
    },
  };
  return { module, steps: [...modeled, ...callerSteps], callerSteps, modeledSteps: modeled };
}

/** Pull the caller profiles a counterexample path switched to (F-C-4). */
export function callerProfilesInPath(path = []) {
  const names = [];
  for (const step of path) {
    if (step && step.action === CALLER_HAVOC && step.data && step.data.value !== undefined) names.push(step.data.value);
  }
  return [...new Set(names)];
}

/** Pull the havoc-written variable names out of a counterexample path. */
export function havocVarsInPath(path = []) {
  const names = [];
  for (const step of path) {
    if (step && step.action === HAVOC && step.data && step.data.var) names.push(step.data.var);
  }
  return [...new Set(names)];
}

/** True when a counterexample path uses at least one havoc edge. */
export function pathUsesHavoc(path = []) {
  return path.some((s) => s && s.action === HAVOC);
}
