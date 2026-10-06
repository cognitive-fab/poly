// The plan interpreter — one definition of what a compiled policy does to a
// flat model on one action.
//
// A compiled policy ("plan", see compile/plan.mjs) is plain JSON: model keys,
// rules with compiled ASTs, machines, invariants, lifted history counters.
// This module evaluates one SAM action against a flat model and returns either
// a rejection reason ('<obligation>:<misfire>[:detail]') or the writes to
// apply. It is required by the generated `next.cjs` (so what harden explores
// is what the kernel runs) and by the witness builder (so a denial's
// explanation comes from the same evaluation). Pure: no I/O, no clock.
import { evaluate, ExprError, truth } from './expr.mjs';
import { clone } from './canon.mjs';

/** RFC 7386 merge-patch: objects merge recursively, null deletes, everything else replaces. */
export function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch);
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (typeof v === 'object' && !Array.isArray(v)) out[k] = mergePatch(out[k], v);
    else out[k] = clone(v);
  }
  return out;
}


export const PROPOSE = 'PROPOSE';
export const PATCH = 'PATCH';
export const SETTLE = 'SETTLE';
export const END = 'END';

const inDomain = (spec, v) => spec.domain.some((d) => (spec.type === 'list' ? JSON.stringify(d) === JSON.stringify(v) : d === v));
const saturate = (spec, v) => {
  if (inDomain(spec, v)) return v;
  if (spec.saturate && spec.type === 'number' && typeof v === 'number') {
    const sorted = [...spec.domain].sort((a, b) => a - b);
    if (v > sorted[sorted.length - 1]) return sorted[sorted.length - 1];
    if (v < sorted[0]) return sorted[0];
    return sorted.reduce((best, d) => (Math.abs(d - v) < Math.abs(best - v) ? d : best), sorted[0]);
  }
  return undefined;
};

function safe(ast, env) {
  try { return { value: evaluate(ast, env), error: null }; } catch (e) {
    if (e instanceof ExprError) return { value: null, error: e.message };
    throw e;
  }
}

/** Views over the flat model that PX expressions read. */
export function views(plan, model) {
  const state = {};
  for (const [name, key] of Object.entries(plan.vars)) state[name] = model[key];
  const lifted = {};
  for (const r of plan.rules) for (const l of r.lifted) lifted[l.key] = model[l.key];
  return { state, lifted };
}

function machineView(m, model) {
  const vars = {};
  for (const [name, v] of Object.entries(m.vars)) vars[name] = model[v.key];
  return { state: model[m.key], vars, since: 0 };
}

/**
 * @param {object} plan     compiled policy (JSON)
 * @param {object} model    flat model (the SAM state)
 * @param {string} action   PROPOSE | GATE__… | PATCH | SETTLE | END
 * @param {object} data     { action?, patch?, observed?, history?, run? }
 * @returns {{ reject: string|null, next: object, obligation?: string, detail?: object }}
 */
export function stepPlan(plan, model, action, data = {}) {
  const next = {};
  const history = Array.isArray(data.history) ? data.history : [];
  const run = data.run ?? { id: '', scope: '', step: 0 };
  const approved = data.approved && typeof data.approved === 'object' ? data.approved : null;
  const observed = data.observed && typeof data.observed === 'object' ? data.observed : null; // what the result showed (settle phase only); unknown at gate time // a human lifted an escalation for this proposal (02 §2.6): journaled data, never a way in
  const v = views(plan, model);

  if (action === PATCH) return applyPatch(plan, model, data.patch ?? {}, v, run, history);

  if (action === END) {
    const a = { kind: 'run.end', target: 'end' };
    const r = evalRules(plan, model, a, v, run, history, approved);
    if (r) return r;
    for (const m of plan.machines) {
      if (!m.discharge) continue;
      if (!m.discharge.includes(model[m.key])) return { reject: `wrong-state:${m.id}:undischarged`, next: {}, obligation: m.id, detail: { state: model[m.key], discharge: m.discharge } };
    }
    if (plan.endedKey) next[plan.endedKey] = true;
    return { reject: null, next };
  }

  const canonical = data.action;
  if (!canonical || typeof canonical !== 'object' || typeof canonical.kind !== 'string') return { reject: 'bad-execution:polyaxion:malformed-action', next: {} };

  if (action === SETTLE) {
    // observed effects add taint through the same guards: an observed effect
    // that would complete a region is a skipped post-label (an observable
    // no-op the kernel journals), never a way into the region
    const a = { ...canonical, effects: data.observed?.effects ?? canonical.effects ?? null, observed: true };
    for (const m of plan.machines) {
      const g = evalGuards(plan, m, model, a, v, run, history);
      if (g) return { ...g, reject: 'settle-skipped:' + g.reject };
    }
    for (const m of plan.machines) runTransitions(plan, m, model, a, v, run, history, next, 'settle', observed);
    return { reject: null, next };
  }

  if (action !== PROPOSE && !action.startsWith('GATE__')) return { reject: `no-procedure:polyaxion:${action}`, next: {} };

  // rules
  const r = evalRules(plan, model, canonical, v, run, history, approved);
  if (r) return r;
  // machines: guards then transitions
  for (const m of plan.machines) {
    const g = evalGuards(plan, m, model, canonical, v, run, history);
    if (g) return g;
  }
  for (const m of plan.machines) runTransitions(plan, m, model, canonical, v, run, history, next, action);
  // lifted history counters advance on every accepted proposal
  for (const rule of plan.rules) {
    for (const l of rule.lifted) {
      const hv = { step: run.step, action: canonical, verdict: 'allow', violated: [] };
      const env = { action: canonical, state: v.state, patch: null, history, run, lifted: v.lifted, [l.param]: hv };
      const res = safe(l.pred, env);
      const matched = truth(res.value) === true; // unknown counts as not matched (03 §4)
      const cur = model[l.key];
      if (l.fn === 'count') next[l.key] = matched ? Math.min(cur + 1, l.cap) : cur;
      else if (l.fn === 'any') next[l.key] = cur || matched;
      else if (l.fn === 'none') next[l.key] = cur && !matched;
      else if (l.fn === 'all') next[l.key] = cur && matched;
    }
  }
  return { reject: null, next };
}

function ruleEnv(plan, model, a, v, run, history) {
  return { action: a, state: v.state, patch: null, history, run, lifted: v.lifted, proposal: { meta: null } };
}

function evalRules(plan, model, a, v, run, history, approved = null) {
  for (const rule of plan.rules) {
    const env = ruleEnv(plan, model, a, v, run, history);
    if (rule.when) {
      const w = safe(rule.when, env);
      if (w.value === false) continue; // unknown applies (fail closed)
    }
    const req = safe(rule.require, env);
    if (req.value === true) continue;
    if (rule.severity === 'warn') continue; // warnings are surfaced by the witness builder, never a reject
    if (rule.severity === 'escalate' && approved) continue; // lifted by a human: escalations only, never a deny or a guard
    if (req.error) return { reject: `bad-execution:${rule.id}:${short(req.error)}`, next: {}, obligation: rule.id, detail: { error: req.error } };
    if (req.value === null) return { reject: `wrong-state:${rule.id}:indeterminate`, next: {}, obligation: rule.id, detail: { indeterminate: true } };
    if (rule.severity === 'escalate') return { reject: `wrong-state:${rule.id}:escalate`, next: {}, obligation: rule.id, detail: { escalate: true } };
    return { reject: `wrong-state:${rule.id}`, next: {}, obligation: rule.id, detail: {} };
  }
  return null;
}

function evalGuards(plan, m, model, a, v, run, history) {
  const mv = machineView(m, model);
  const env = { action: a, state: v.state, patch: null, history, run, lifted: v.lifted, machine: mv, proposal: { meta: null } };
  for (const g of m.guards) {
    if (!g.in.includes(mv.state)) continue;
    const w = safe(g.when, env);
    if (w.value === false) continue;
    if (g.holds) {
      const h = safe(g.holds, env);
      if (h.value === false) continue;
    }
    if (w.error) return { reject: `bad-execution:${m.id}:${short(w.error)}`, next: {}, obligation: m.id, detail: { guard: g.idx, error: w.error } };
    const detail = w.value === null ? ':indeterminate' : '';
    return { reject: `wrong-state:${m.id}:${g.reason}${detail}`, next: {}, obligation: m.id, detail: { guard: g.idx, reason: g.reason, state: mv.state } };
  }
  return null;
}

/**
 * mode: 'PROPOSE' runs only ungated transitions (a gated one has its own
 * action, so a call routed to PROPOSE cannot take a gated effect);
 * 'GATE__…' and 'settle' run every transition whose condition holds (an
 * action carrying several effects takes them all; settle has already passed
 * the guards).
 */
function runTransitions(plan, m, model, a, v, run, history, next, mode = 'PROPOSE', observed = null) {
  const mv = machineView(m, model);
  const env = { action: a, state: v.state, patch: null, history, run, lifted: v.lifted, machine: mv, proposal: { meta: null }, observed };
  for (const t of m.transitions) {
    if (t.gateAction && mode === 'PROPOSE') continue;
    if (t.phase === 'settle' && mode !== 'settle') continue; // fires only after the effect, with `observed` in scope
    if (!t.from.includes(mv.state)) continue;
    const w = safe(t.when, env);
    if (w.value !== true) continue;
    next[m.key] = t.to;
    for (const [name, ast] of Object.entries(t.set)) {
      const spec = m.vars[name];
      const r = safe(ast, env);
      const val = saturate(spec, r.value);
      // an out-of-domain write is clamped when saturating, else refused at compile time; at runtime keep the old value
      next[spec.key] = val === undefined ? model[spec.key] : val;
    }
  }
}

function applyPatch(plan, model, patch, v, run, history) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { reject: 'bad-execution:polyaxion:malformed-patch', next: {} };
  const merged = mergePatch(v.state, patch);
  const next = {};
  for (const [name, key] of Object.entries(plan.vars)) {
    const spec = plan.varSpecs[name];
    const val = merged[name] === undefined ? spec.initial : merged[name];
    if (!inDomain(spec, val)) return { reject: `bad-execution:polyaxion:malformed-patch:${name}`, next: {}, detail: { var: name, value: val } };
    next[key] = val;
  }
  for (const k of Object.keys(patch)) if (!(k in plan.vars)) return { reject: `bad-execution:polyaxion:malformed-patch:${k}`, next: {}, detail: { var: k, undeclared: true } };
  const post = {}; for (const [name, key] of Object.entries(plan.vars)) post[name] = next[key];
  for (const inv of plan.invariants) {
    const r = safe(inv.ast, { state: post, pre: v.state, patch, action: null, run, history, lifted: v.lifted });
    if (r.value === true) continue;
    if (r.error) return { reject: `bad-execution:${inv.id}:${short(r.error)}`, next: {}, obligation: inv.id, detail: { error: r.error } };
    return { reject: `wrong-state:${inv.id}${r.value === null ? ':indeterminate' : ''}`, next: {}, obligation: inv.id, detail: { post } };
  }
  return { reject: null, next };
}

const short = (s) => String(s).replace(/[^A-Za-z0-9 _.,:'()-]/g, '').slice(0, 80);

/**
 * Route a canonical action to its SAM action name: the first gated transition
 * whose action-only selector matches, else PROPOSE. Used by the labeler and by
 * the compiler when partitioning the exploration domain.
 */
export function routeAction(plan, canonical) {
  for (const m of plan.machines) {
    for (const t of m.transitions) {
      if (!t.gateAction) continue;
      const r = safe(t.route, { action: canonical });
      if (r.value === true) return t.gateAction;
    }
  }
  return PROPOSE;
}

/** Split an AST into conjuncts (top-level &&). */
export function conjuncts(ast) {
  if (Array.isArray(ast) && ast[0] === '&&') return [...conjuncts(ast[1]), ...conjuncts(ast[2])];
  return [ast];
}

/** Roots referenced by an AST (excluding lambda params). */
export function roots(ast) {
  const out = new Set();
  const bound = new Set();
  const walk = (n) => { if (!Array.isArray(n)) return; if (n[0] === 'fn') bound.add(n[1]); if (n[0] === 'path') out.add(n[1]); for (let i = 1; i < n.length; i++) walk(n[i]); };
  walk(ast);
  for (const b of bound) out.delete(b);
  return out;
}
