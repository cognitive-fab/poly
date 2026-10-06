// Witnesses over kernel decisions.
//
// The kernel decides; this module explains. A rejection reason names its
// misfire class and obligation ('wrong-state:<obligation>[:detail]'); the
// witness re-reads the named obligation from the composite plan, resolves the
// bindings the failing expression read, lists the prior steps a history
// quantifier matched, and renders the machine's state. Deterministic, off the
// decision path, adds nothing the kernel did not already know (doctrine 21).
import { evaluate, resolvePath, ExprError } from '../core/expr.mjs';
import { views } from '../core/step.mjs';
import { renderWitness } from '../core/witness.mjs';

/** '<misfire>:<obligation>[:<detail>]' where an obligation id may itself contain ':' — match against the known ids, longest first. */
export function parseReason(reason, ids = []) {
  const s = String(reason ?? '');
  const i = s.indexOf(':');
  if (i < 0) return { misfire: null, obligation: null, detail: s };
  const misfire = s.slice(0, i); const rest = s.slice(i + 1);
  const sorted = [...ids].sort((a, b) => b.length - a.length);
  const ob = sorted.find((id) => rest === id || rest.startsWith(id + ':'));
  if (ob) return { misfire, obligation: ob, detail: rest.length > ob.length ? rest.slice(ob.length + 1) : null };
  const m = /^([^:]+)(?::(.*))?$/.exec(rest);
  return { misfire, obligation: m ? m[1] : rest, detail: m && m[2] !== undefined ? m[2] : null };
}

const refsOf = (ast) => {
  const out = new Set(); const bound = new Set();
  const walk = (n) => { if (!Array.isArray(n)) return; if (n[0] === 'fn') bound.add(n[1]); if (n[0] === 'get' || n[0] === 'path') { const p = dotted(n); if (p && !bound.has(p.split('.')[0])) out.add(p); } for (let i = 1; i < n.length; i++) walk(n[i]); };
  walk(ast);
  const arr = [...out];
  return arr.filter((p) => !arr.some((q) => q !== p && q.startsWith(p + '.'))).sort();
};
function dotted(n) { if (n[0] === 'path') return n[1]; if (n[0] === 'get') { const b = dotted(n[1]); return b ? `${b}.${n[2]}` : null; } return null; }
const short = (v) => { if (v !== null && typeof v === 'object') { const s = JSON.stringify(v); return s.length > 160 ? s.slice(0, 159) + '…' : v; } return v; };

/**
 * @param {object} plan       composite plan
 * @param {object} decision   kernel Decision (ok:false)
 * @param {object} ctx        { model (pre), action (the canonical action that was refused, if known), history, run }
 */
export function buildWitness(plan, decision, ctx) {
  const { misfire, obligation, detail } = parseReason(decision.reason, plan.obligations.map((o) => o.id));
  const ob = plan.obligations.find((o) => o.id === obligation);
  const base = { obligation: ob?.short ?? obligation ?? 'polyaxion', id: obligation ?? null, policy: ob?.policy ?? null, kind: ob?.kind ?? 'kernel', severity: detail === 'escalate' ? 'escalate' : 'deny', text: ob?.text ?? kernelText(decision), hint: ob?.hint ?? null, misfire, detail, reason: reasonKind(misfire, detail), expression: null, bindings: {}, sequence: [], machine: null, class: decision.class ?? null };
  if (!ob) return base;
  const v = views(plan, ctx.model);
  const env = { action: ctx.action ?? null, state: v.state, patch: null, history: ctx.history ?? [], run: ctx.run ?? { id: '', scope: '', step: 0 }, lifted: v.lifted, proposal: { meta: null } };
  if (ob.kind === 'rule') {
    const r = plan.rules.find((x) => x.id === ob.id);
    base.expression = r.requireSrc;
    base.bindings = bindings(refsOf(r.require), env, plan);
    base.sequence = historySequence(r, env);
  } else if (ob.kind === 'machine') {
    const m = plan.machines.find((x) => x.id === ob.id);
    const mv = { state: ctx.model[m.key], vars: Object.fromEntries(Object.entries(m.vars).map(([k, s]) => [k, ctx.model[s.key]])) };
    base.machine = { state: mv.state, vars: mv.vars, discharge: m.discharge, path: ctx.trail ?? [] };
    const reason = detail ? detail.split(':')[0] : null;
    const g = m.guards.find((x) => x.reason === reason);
    if (g) { base.expression = g.holds ? `${g.whenSrc}  holds: ${plan.machines.find((x) => x.id === ob.id).guards.find((x) => x.idx === g.idx).holdsSrc ?? '…'}` : g.whenSrc; base.bindings = bindings(refsOf(g.when).concat(g.holds ? refsOf(g.holds) : []), { ...env, machine: mv }, plan); }
    if (detail === 'undischarged') base.reason = 'end-state-required';
    base.sequence = ctx.action ? [{ step: 'proposed', action: trim(ctx.action), note: reason ?? undefined }] : [];
  } else if (ob.kind === 'invariant') {
    const inv = plan.invariants.find((x) => x.id === ob.id);
    base.expression = inv.src;
    base.bindings = bindings(refsOf(inv.ast), { ...env, state: ctx.post ?? v.state }, plan);
  }
  return base;
}

function reasonKind(misfire, detail) {
  if (misfire === 'wrong-state') return detail === 'indeterminate' || (detail && detail.endsWith(':indeterminate')) ? 'indeterminate' : detail === 'undischarged' ? 'end-state-required' : detail === 'escalate' ? 'escalate' : detail ? 'guard' : 'require-failed';
  if (misfire === 'bad-execution') return 'evaluation-error';
  if (misfire === 'no-procedure') return 'unknown-tool';
  return misfire ?? 'denied';
}
function kernelText(d) {
  if (String(d.reason).startsWith('no-procedure:polyaxion:no-policy-in-scope')) return 'No policy covers this scope, so nothing is allowed here (default-deny, doctrine 3). Declare a policy whose scope matches, or list the scope under open_scopes in .polyaxion/config.json to run it ungoverned on purpose.';
  if (String(d.reason).startsWith('wrong-participant:polyaxion:approval-unmatched')) return 'The proposal claims a human approval for a reference this session never escalated; refusing. An approval lifts a recorded escalation and nothing else (02 §2.6).';
  if (String(d.reason).startsWith('unavailable:policy')) return 'The configured policy files are missing or were refused at admission, so this scope has nothing servable; refusing rather than serving nothing. Fix the policy (polyaxion lint) or remove it from .polyaxion/config.json.';
  if (d.class === 'unavailable') return 'The gate could not decide (a decision-path input was unavailable); refusing rather than guessing.';
  if (String(d.reason).startsWith('unknown-tool')) return 'This tool is not in the declared tool surface; excess voids the proof.';
  return `Refused by the kernel: ${d.reason}`;
}
function bindings(refs, env, plan) {
  const out = {};
  for (const ref of refs) {
    const root = ref.split('.')[0];
    if (root === 'history' || root === 'proposal') continue;
    let val;
    if (root === 'lifted') { const key = ref.split('.')[1]; const r = plan.rules.find((x) => x.lifted.some((l) => l.key === key)); const l = r && r.lifted.find((x) => x.key === key); val = env.lifted[key]; out[l ? `${l.fn}(history, …)` : ref] = val; continue; }
    try { val = resolvePath(env, ref); } catch { val = null; }
    out[ref] = short(val);
  }
  return out;
}
function historySequence(rule, env) {
  const seq = [];
  // lifted counters carry their predicate; an open (runtime-only) rule keeps the quantifier in the AST, so read it from there
  const preds = rule.lifted.length ? rule.lifted.map((l) => ({ param: l.param, pred: l.pred })) : quantifierPreds(rule.require).concat(rule.when ? quantifierPreds(rule.when) : []);
  for (const l of preds) {
    for (const h of env.history) {
      try { if (evaluate(l.pred, { ...env, [l.param]: h }, { budget: 20_000 }) === true) seq.push({ step: h.step, action: trim(h.action), note: 'matched' }); } catch (e) { if (!(e instanceof ExprError)) throw e; }
      if (seq.length >= 12) break;
    }
  }
  if (env.action) seq.push({ step: 'proposed', action: trim(env.action) });
  return seq;
}
/** The lambdas of quantifiers over `history` in an AST: [{ param, pred }]. */
function quantifierPreds(ast) {
  const out = [];
  const walk = (n) => {
    if (!Array.isArray(n)) return;
    if (n[0] === 'call' && ['count', 'any', 'all', 'none', 'first', 'last'].includes(n[1]) && Array.isArray(n[2]) && n[2][0] === 'path' && n[2][1] === 'history' && Array.isArray(n[3]) && n[3][0] === 'fn') out.push({ param: n[3][1], pred: n[3][2] });
    for (let i = 1; i < n.length; i++) walk(n[i]);
  };
  walk(ast);
  return out;
}
function trim(a) { if (!a) return a; const { raw, ...rest } = a; for (const k of Object.keys(rest)) if (typeof rest[k] === 'string' && rest[k].length > 200) rest[k] = rest[k].slice(0, 199) + '…'; return rest; }

/** Warn-severity rules never reject; evaluate them after an allow so the model still hears them. */
export function warnings(plan, model, action, history, run) {
  const out = [];
  const v = views(plan, model);
  const env = { action, state: v.state, patch: null, history, run, lifted: v.lifted, proposal: { meta: null } };
  for (const r of plan.rules) {
    if (r.severity !== 'warn') continue;
    try {
      if (r.when && evaluate(r.when, env) === false) continue;
      if (evaluate(r.require, env) === true) continue;
    } catch (e) { if (!(e instanceof ExprError)) throw e; }
    const ob = plan.obligations.find((o) => o.id === r.id);
    out.push({ obligation: ob?.short ?? r.id, id: r.id, policy: ob?.policy ?? null, kind: 'rule', severity: 'warn', text: ob?.text ?? r.id, hint: ob?.hint ?? null, reason: 'require-failed', expression: r.requireSrc, bindings: bindings(refsOf(r.require), env, plan), sequence: [{ step: 'proposed', action: trim(action) }], machine: null });
  }
  return out;
}

export { renderWitness };
