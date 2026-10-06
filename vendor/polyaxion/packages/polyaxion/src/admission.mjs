// Admission: compile a policy to its triple, run polysec's harden and
// polygraph's check over it, run the author's examples through the compiled
// machine, and say whether the policy may be served.
//
//   servable  ⇔  compiled without refusal
//              ∧ every example behaves as declared (each obligation alone)
//              ∧ harden reports fullyMediated  (policies with regions/gates)
//              ∧ no rejection obligation is violated within the bound (all)
//
// The verdict digest is the digest of the harden/check report; it is what
// receipts bind (doctrine 13). A policy with no passing verdict has
// verdictDigest null and is never served, whatever `force` stores.
//
// Engines (polygraph via polysec-lib) are needed here and only here at declare
// time; without them admission reports `engines: false` and refuses to call
// the policy servable (doctrine 24: absent evidence is unobserved, never clean).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTriple, compileToTriple, CompileError } from './compile/index.mjs';
import { PolicyError, compilePolicy } from './core/policy.mjs';
import { writeNativeTriple, nativeTripleDigest } from './runtime/native.mjs';
import { normalizeAction } from './core/action.mjs';
import { routeAction } from './core/step.mjs';
import { digest } from './core/canon.mjs';
import { computeBound } from './compile/bound.mjs';
import { checkDischarge } from './compile/discharge.mjs';
import { core } from './runtime/deps.mjs';

const MAX_STATES = 5000;

let enginesPromise = null;
/** Load polysec's engine seam once; null when the polygraph sibling is absent. */
export function engines() {
  if (!enginesPromise) {
    enginesPromise = (async () => {
      try {
        const lib = await core('lib');
        const hard = await core('harden');
        return { ...lib, harden: hard.harden, fromInitCheck: hard.fromInitCheck, dir: lib.POLYGRAPH_DIR, source: lib.POLYGRAPH_SOURCE ?? null };
      } catch (e) {
        return { unavailable: String(e && e.message) };
      }
    })();
  }
  return enginesPromise;
}

/**
 * @param {object} doc      authoring document
 * @param {object} opts     { outDir?: string, maxStates?: number, keepTemp?: boolean, historyWindow?: number }
 * @returns admission report
 */
export async function admitPolicy(doc, opts = {}) {
  const report = { id: doc?.id ?? null, servable: false, refused: null, engines: null, compile: null, examples: null, harden: null, check: null, coverage: null, findings: [], tripleDigest: null, verdictDigest: null, dir: null, bound: null };
  // 0. a native policy (02 §2.5) has no PX to compile: harden over its own triple
  let compiledDoc;
  try { compiledDoc = compilePolicy(doc); } catch (e) {
    if (e instanceof PolicyError) { report.refused = { stage: 'compile', message: e.message }; report.compile = { ok: false, message: e.message }; return report; }
    throw e;
  }
  if (compiledDoc.compiled.some((o) => o.kind === 'native')) return admitNative(compiledDoc, report, opts);
  // 1. compile
  let w;
  try {
    const outDir = opts.outDir ?? mkdtempSync(join(tmpdir(), 'px-admit-'));
    w = writeTriple(doc, outDir);
    report.dir = w.dir; report.tripleDigest = w.tripleDigest; report.coverage = w.plan.coverage; report.findings.push(...w.findings);
    report.compile = { ok: true, gates: w.plan.gates, regions: w.plan.regions.map((r) => r.name), rejections: w.plan.rejections.length, samples: w.plan.samples.length };
    // the computed worst case (BL-2): derived here, published beside the measured percentiles
    report.bound = computeBound(w.plan, { historyWindow: opts.historyWindow, budget: w.compiled.doc.budget?.steps ?? null });
    if (report.bound.exceeded) report.findings.push({ level: 'error', obligation: report.bound.worst?.obligation ?? null, message: `budget: the computed worst case is ${report.bound.perCall} evaluation steps per call, over the declared budget of ${report.bound.budget}; '${report.bound.worst?.obligation}' costs the most (${report.bound.worst?.steps} per action)` });
  } catch (e) {
    if (e instanceof PolicyError || e instanceof CompileError) { report.refused = { stage: 'compile', message: e.message }; report.compile = { ok: false, message: e.message }; return report; }
    throw e;
  }
  const E = await engines();
  if (E.unavailable) {
    report.engines = false;
    report.findings.push({ level: 'error', obligation: null, message: `polygraph engines unavailable (${E.unavailable}); admission cannot establish a verdict — set POLYGRAPH_DIR or clone ../polygraph` });
    return report;
  }
  report.engines = E.dir;

  // 2. examples and rejection obligations, each obligation alone, through its own compiled machine
  report.examples = await runExamples(doc, E, opts);
  if (report.examples.failures.length) report.findings.push(...report.examples.failures.map((f) => ({ level: 'error', obligation: f.obligation, message: f.message })));
  report.check = report.examples.check;
  // mandate m2: every reachable Σ can still be lawfully discharged
  report.discharge = checkDischarge(w.plan, { maxStates: opts.maxStates ?? MAX_STATES });
  if (report.discharge.applicable && !report.discharge.ok) {
    const t = report.discharge.trapped[0];
    if (t) report.findings.push({ level: 'error', obligation: t.machines[0]?.id ?? null, message: `not lawfully dischargeable (m2): from state ${JSON.stringify(t.state)} no allowed action leads to a discharge state of ${t.machines.map((m) => `'${m.id}' (in '${m.state}', discharge ${m.discharge.join('/')})`).join(', ')}; reached by ${t.path.length ? t.path.map((p) => JSON.stringify(p.action)).join(' → ') : 'init'}` });
    else report.findings.push({ level: 'error', obligation: null, message: `discharge check hit the ${opts.maxStates ?? MAX_STATES}-state bound; dischargeability not established (doctrine 24)` });
  }
  if (report.check.violations.length) report.findings.push(...report.check.violations.map((v) => ({ level: 'error', obligation: v.obligation, message: `check: ${v.invariant} violated (${v.kind}): ${v.detail}` })));
  if (report.check.capHit) report.findings.push({ level: 'warn', obligation: null, message: `check: exploration hit the ${opts.maxStates ?? MAX_STATES}-state bound for ${report.check.bounded.join(', ')}; rejection obligations verified only within it` });

  // 3. proof — the coverage grade travels into the verdict so the receipt binds it (03 §7)
  const coverage = coverageOf(w.plan);
  const spec = E.loadSpec(w.files.module);
  const contract = w.triple.contractObject;
  const security = E.loadSecurity(w.files.security);
  const hasRegions = w.plan.regions.length > 0;
  try {
    if (hasRegions && w.plan.gates.length === 0) {
      const fi = E.fromInitCheck({ spec, contract, security });
      report.harden = { fullyMediated: fi.ok, basis: { fromInitClean: fi.ok }, vacuous: [{ conjunct: 'gateDeletion', basis: 'noBypass', why: 'no gates inferred or declared — mediation not claimed, from-init only' }], fromInit: { ok: fi.ok, statesExplored: fi.statesExplored, violations: fi.violations.map((v) => ({ invariant: v.invariant, path: (v.path || []).map((s) => ({ action: s.action, data: s.data })) })) }, gateDeletion: null, havoc: null, coverage };
      report.verdictDigest = fi.ok ? digest({ fromInit: report.harden.fromInit, tripleDigest: w.tripleDigest, coverage }) : null;
      if (!fi.ok) report.findings.push({ level: 'error', obligation: null, message: 'from-init: a declared region is reachable' });
    } else if (hasRegions) {
      const rep = E.harden({ spec, contract, security, label: doc.id, coverage });
      report.harden = summarizeHarden(rep);
      report.verdictDigest = rep.verdict.fullyMediated ? digest(rep) : null;
      if (!rep.verdict.fullyMediated) report.findings.push({ level: 'error', obligation: null, message: `harden: not fully mediated (${Object.entries(rep.verdict.basis).filter(([, v]) => !v).map(([k]) => k).join(', ')})` });
      for (const v of rep.verdict.vacuous ?? []) report.findings.push({ level: 'info', obligation: null, message: `harden: ${v.conjunct} vacuous — ${v.why}` });
    }
    if (!hasRegions && report.check.violations.length === 0) report.verdictDigest = digest({ check: report.check, tripleDigest: w.tripleDigest, coverage });
  } catch (e) {
    report.findings.push({ level: 'error', obligation: null, message: `proof engine error: ${e && e.message}` });
  }

  const errors = report.findings.some((f) => f.level === 'error');
  report.servable = !report.refused && !errors && report.examples.failures.length === 0 && report.verdictDigest !== null && (report.harden ? report.harden.fullyMediated : true) && !!report.check && report.check.violations.length === 0;
  if (!opts.outDir && !opts.keepTemp) { try { rmSync(w.dir, { recursive: true, force: true }); } catch { /* temp */ } report.dir = null; }
  return report;
}

/** The policy's coverage grade: the worst grade among its enforced obligations, and each obligation's own. */
export function coverageOf(plan) {
  const enforced = (plan.coverage ?? []).filter((c) => c.grade !== 'recalled');
  return { grade: enforced.some((c) => c.grade !== 'checked') ? 'runtime-only' : 'checked', obligations: Object.fromEntries((plan.coverage ?? []).map((c) => [c.id, c.grade])) };
}

/** Admission of a native policy: the embedded triple is what harden proves and what the kernel serves. */
async function admitNative(compiledDoc, report, opts) {
  const ob = compiledDoc.compiled.find((o) => o.kind === 'native');
  const native = ob.native;
  const dir = opts.outDir ?? mkdtempSync(join(tmpdir(), 'px-admit-native-'));
  const files = writeNativeTriple(dir, native);
  report.dir = dir; report.tripleDigest = nativeTripleDigest(native, compiledDoc.hash);
  report.coverage = [{ id: ob.id, grade: 'checked', notes: ['native triple: proved by harden over its own machine; no PX form'] }];
  report.compile = { ok: true, native: true, gates: native.security.gates ?? [], regions: (native.security.forbiddenRegions ?? []).map((r) => r.name), tools: Object.keys(native.security.tools ?? {}).length, rejections: 0, samples: 0 };
  report.bound = null;
  const E = await engines();
  if (E.unavailable) {
    report.engines = false;
    report.findings.push({ level: 'error', obligation: null, message: `polygraph engines unavailable (${E.unavailable}); admission cannot establish a verdict — set POLYGRAPH_DIR or clone ../polygraph` });
    return report;
  }
  report.engines = E.dir;
  report.examples = { checked: 0, failures: [], check: null };
  report.check = { ok: true, statesExplored: 0, capHit: false, bounded: [], violations: [], perObligation: {}, note: 'native: harden over the triple is the check' };
  try {
    const spec = E.loadSpec(files.module);
    const security = E.loadSecurity(files.security);
    const contract = native.contract;
    const hasRegions = (security.forbiddenRegions ?? []).length > 0;
    const hasGates = (security.gates ?? []).length > 0;
    if (hasRegions && !hasGates) {
      const fi = E.fromInitCheck({ spec, contract, security });
      report.harden = { fullyMediated: fi.ok, basis: { fromInitClean: fi.ok }, vacuous: [{ conjunct: 'gateDeletion', basis: 'noBypass', why: 'no gates declared — mediation not claimed, from-init only' }], fromInit: { ok: fi.ok, statesExplored: fi.statesExplored, violations: fi.violations.map((v) => ({ invariant: v.invariant, path: (v.path || []).map((s) => ({ action: s.action, data: s.data })) })) }, gateDeletion: null, havoc: null, coverage: { grade: 'checked', obligations: { [ob.id]: 'checked' } } };
      report.verdictDigest = fi.ok ? digest({ fromInit: report.harden.fromInit, tripleDigest: report.tripleDigest }) : null;
      if (!fi.ok) report.findings.push({ level: 'error', obligation: ob.id, message: 'from-init: a declared region is reachable' });
    } else if (hasRegions) {
      const rep = E.harden({ spec, contract, security, label: compiledDoc.doc.id, coverage: { grade: 'checked', obligations: { [ob.id]: 'checked' } } });
      report.harden = summarizeHarden(rep);
      report.verdictDigest = rep.verdict.fullyMediated ? digest(rep) : null;
      if (!rep.verdict.fullyMediated) report.findings.push({ level: 'error', obligation: ob.id, message: `harden: not fully mediated (${Object.entries(rep.verdict.basis).filter(([, v]) => !v).map(([k]) => k).join(', ')})` });
      for (const v of rep.verdict.vacuous ?? []) report.findings.push({ level: 'info', obligation: ob.id, message: `harden: ${v.conjunct} vacuous — ${v.why}` });
    } else {
      report.findings.push({ level: 'error', obligation: ob.id, message: 'native.security declares no forbiddenRegions — nothing to prove' });
    }
  } catch (e) {
    report.findings.push({ level: 'error', obligation: ob.id, message: `proof engine error: ${e && e.message}` });
  }
  const errors = report.findings.some((f) => f.level === 'error');
  report.servable = !errors && report.verdictDigest !== null && !!report.harden && report.harden.fullyMediated;
  report.native = { triple: { module: native.module, contract: JSON.stringify(native.contract), security: JSON.stringify(native.security) } };
  if (!opts.outDir && !opts.keepTemp) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } report.dir = null; }
  return report;
}

function summarizeHarden(rep) {
  return {
    fullyMediated: !!rep.verdict.fullyMediated,
    basis: rep.verdict.basis,
    vacuous: rep.verdict.vacuous ?? [],
    fromInit: { ok: rep.fromInit.ok, statesExplored: rep.fromInit.statesExplored, violations: rep.fromInit.violations.map((v) => ({ invariant: v.invariant, path: (v.path || []).map((s) => ({ action: s.action, data: s.data })) })) },
    gateDeletion: rep.gateDeletion ? { ok: rep.gateDeletion.ok, deletedGates: rep.gateDeletion.deletedGates, bypasses: (rep.gateDeletion.bypasses || []).map((b) => ({ region: b.region, via: b.via })) } : null,
    havoc: rep.havoc ? { ran: rep.havoc.ran, counterexamples: (rep.havoc.counterexamples || []).length } : null,
    coverage: rep.verdict.coverage ?? null,
  };
}

/** Run every obligation's examples with only that obligation active, through the compiled machine. */
async function runExamples(doc, E, opts) {
  const failures = []; let checked = 0;
  const check = { ok: true, statesExplored: 0, capHit: false, bounded: [], violations: [], perObligation: {} };
  const tmp = mkdtempSync(join(tmpdir(), 'px-ex-'));
  try {
    for (const o of doc.obligations) {
      if (o.kind === 'recalled') continue;
      const single = writeTriple({ ...doc, id: `${doc.id}/ex/${o.id}`.replace(/[^A-Za-z0-9._:/-]/g, '-'), obligations: [o] }, join(tmp, o.id.replace(/[^A-Za-z0-9._-]/g, '_')));
      const spec = E.loadSpec(single.files.module);
      // rejection obligations of this obligation alone, bounded
      try {
        const inv = await import(`file://${single.files.invariants.replace(/\\/g, '/')}`);
        const r = E.check({ specModule: spec, contract: single.triple.contractObject, invariants: { rejectionInvariants: inv.rejectionInvariants, stateInvariants: inv.stateInvariants }, maxStates: opts.maxStates ?? MAX_STATES });
        check.statesExplored += r.statesExplored; if (r.capHit) { check.capHit = true; check.bounded.push(o.id); }
        check.perObligation[o.id] = { statesExplored: r.statesExplored, capHit: !!r.capHit, violations: r.violations.length };
        for (const v of r.violations) { check.ok = false; check.violations.push({ obligation: o.id, invariant: v.invariant, kind: v.kind, detail: v.detail, path: (v.path || []).map((s) => ({ action: s.action, data: s.data })) }); }
      } catch (e) { check.ok = false; check.violations.push({ obligation: o.id, invariant: 'check', kind: 'error', detail: String(e && e.message), path: [] }); }
      if (!o.examples) continue;
      const { mediate } = E.makeMediator(spec);
      const plan = single.plan;
      const run = (seq) => {
        spec.init(); let state = spec.getState(); let last = null; const history = [];
        for (const step of seq) {
          // an example step may carry `observed` (02 §6): the action is gated, then settled with that result, so settle-phase transitions are exercised
          const { observed, ...bare } = step.kind ? step : step.action ? { ...step.action, observed: step.observed } : {};
          const a = step.kind || step.action ? normalizeAction(bare) : null;
          const act = !a ? 'PATCH' : a.kind === 'run.end' ? 'END' : routeAction(plan, a);
          const data = a ? { action: a, history } : { patch: step.patch };
          const m = mediate(state, act, data);
          last = m; state = m.post;
          if (m.decision === 'reject') return m;
          if (a) history.push({ step: history.length + 1, action: a, verdict: 'allow', violated: [] });
          if (a && observed && typeof observed === 'object') { const s2 = mediate(state, 'SETTLE', { action: a, observed, history }); last = s2; state = s2.post; if (s2.decision === 'reject') return s2; }
        }
        return last;
      };
      const ex = single.compiled.compiled[0].examples;
      for (const [i, seq] of ex.deny.entries()) {
        checked++;
        const m = run(seq);
        if (!(m && m.decision === 'reject' && String(m.reason).split(':')[1] === o.id)) failures.push({ obligation: o.id, example: `deny[${i}]`, message: `examples.deny[${i}] was not refused by this obligation (${m ? m.decision + (m.reason ? ' ' + m.reason : '') : 'no step'})` });
      }
      for (const [i, seq] of ex.allow.entries()) {
        checked++;
        const m = run(seq);
        if (m && m.decision === 'reject') failures.push({ obligation: o.id, example: `allow[${i}]`, message: `examples.allow[${i}] was refused: ${m.reason}` });
      }
    }
  } finally {
    if (!opts.keepTemp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } }
  }
  return { checked, failures, check };
}

export { compileToTriple };
