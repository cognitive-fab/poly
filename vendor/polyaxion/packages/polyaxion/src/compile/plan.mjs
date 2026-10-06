// Plan compiler: compiled policy (core/policy.mjs) → plan (plain JSON).
//
// The plan is the single intermediate form. `emit.mjs` renders it as the
// polysec policy triple; `core/step.mjs` interprets it at runtime and inside
// the generated module; the witness builder reads it to explain a rejection.
//
// Decisions it implements (spec 02/03, 2026-09-01):
//   - every var has a finite domain; numbers saturate when declared so;
//   - history quantifiers (in `when` or `require`) with closed predicates lift
//     to counters/flags; open ones are runtime-only (acknowledged by the author);
//   - gates are inferred (transitions that leave a guarded state, or that write
//     a var a declared region reads) and overridable with gate: true/false; a
//     gated transition needs an action-only selector so calls can be routed;
//   - regions come from invariants (negated) and declared machine regions;
//     guards and deny-severity rules are rejection obligations.
//
// Rejection reasons follow polysec's misfire grammar: '<misfire>:<obligation>[:<detail>]'.
import { synthesizeActions } from './samples.mjs';
import { conjuncts, roots } from '../core/step.mjs';
import { references } from '../core/expr.mjs';
import { canon } from '../core/canon.mjs';

const ident = (s) => String(s).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

export class CompileError extends Error {
  constructor(m, obligation = null) { super(m); this.name = 'CompileError'; this.obligation = obligation; }
}

/**
 * @param {object} compiledPolicy  result of compilePolicy()
 * @param {object} [opts]
 */
export function buildPlan(compiledPolicy, opts = {}) {
  const { doc, compiled, vars: varSpecs } = compiledPolicy;
  const findings = [...compiledPolicy.findings];
  const keys = [];
  const usedNames = new Set();
  const unique = (base) => {
    let k = ident(base); let n = 1;
    while (usedNames.has(k)) k = `${ident(base)}_${++n}`;
    usedNames.add(k); return k;
  };
  const addKey = (key, type, domain, initial) => { keys.push({ key, type, domain, initial }); return key; };

  const plan = {
    polyaxion: '2',
    policy: { id: doc.id, version: doc.version ?? null, scope: doc.scope, authoringDigest: compiledPolicy.hash },
    keys, vars: {}, varSpecs: {}, machines: [], rules: [], invariants: [], recalled: [],
    obligations: [], actions: [], gates: [], regions: [], rejections: [], endedKey: null, samples: [], coverage: [], findings,
  };

  const hasDischarge = compiled.some((o) => o.kind === 'machine' && o._machine.discharge);
  if (hasDischarge) plan.endedKey = addKey(unique('ended'), 'boolean', [false, true], false);

  for (const [name, spec] of Object.entries(varSpecs)) {
    const key = addKey(unique('v_' + name), spec.type, spec.domain, spec.initial);
    plan.vars[name] = key; plan.varSpecs[name] = { ...spec, key };
  }

  for (const o of compiled) {
    if (o.kind === 'native') continue; // served by its own kernel beside the composite (04 §2.1)
    plan.obligations.push({ id: o.id, kind: o.kind, text: o.text, severity: o.severity, hint: o.hint, tags: o.tags, coverage: o.coverage });
    if (o.kind === 'recalled') { plan.recalled.push({ id: o.id, text: o.text }); continue; }
    if (o.kind === 'rule') plan.rules.push(compileRule(o, unique, addKey, findings));
    else if (o.kind === 'invariant') plan.invariants.push({ id: o.id, src: o.invariant, ast: o._invariant.ast, refs: o._invariant.refs, coverage: o.coverage });
    else if (o.kind === 'machine') plan.machines.push(compileMachine(o, unique, addKey));
  }
  if (!keys.length) addKey(unique('live'), 'boolean', [true], true); // a rules-only policy still needs a model

  plan.actions = ['PROPOSE'];
  for (const m of plan.machines) for (const t of m.transitions) if (t.gateAction) { plan.actions.push(t.gateAction); plan.gates.push(t.gateAction); }
  plan.actions.push('PATCH', 'SETTLE', 'END');

  // regions: invariants (negated) and declared machine regions — JS over keys for polysec's compileRegion
  for (const inv of plan.invariants) if (inv.coverage === 'checked') plan.regions.push({ name: inv.id, kind: 'safety', predicate: `!(${toJs(inv.ast, plan, null)})`, obligation: inv.id, from: 'invariant' });
  for (const m of plan.machines) for (const r of m.regions) plan.regions.push({ name: r.name, kind: r.kind, predicate: toJs(r.ast, plan, m), obligation: m.id, from: 'machine' });
  // rejection obligations: guards, and deny-severity rules
  for (const m of plan.machines) for (const g of m.guards) {
    plan.rejections.push({ name: `${m.id}.guard${g.idx}.${g.reason}`, machine: m.id, guard: g.idx, states: g.in, reason: `wrong-state:${m.id}:${g.reason}` });
  }
  for (const r of plan.rules) if (r.severity === 'deny') plan.rejections.push({ name: r.id, rule: r.id, reason: `wrong-state:${r.id}` });
  for (const r of plan.rules) if (r.severity === 'escalate') plan.rejections.push({ name: r.id, rule: r.id, reason: `wrong-state:${r.id}:escalate` }); // a refusal for the proof; only a human lifts it at runtime

  plan.samples = collectSamples(compiled);
  plan.samplesBy = plan.samples.by; delete plan.samples.by;
  // examples refuse at declare time; exploration over the declared domain is the held-out side (02 §6) — say when the visible set is thinner than the expressions
  for (const o of compiled) {
    if (!o.examples || (o.kind !== 'rule' && o.kind !== 'machine')) continue;
    const referenced = new Set((o.kind === 'machine' ? synthesizeActions(o._machine) : synthesizeFromRule(o)).map((a) => a.kind).filter((k) => k !== 'run.end' && k !== 'tool.call'));
    const covered = new Set();
    for (const seq of [...o.examples.deny, ...o.examples.allow]) for (const s of seq) { const k = s.kind ?? s.action?.kind; if (k) covered.add(k); }
    const missing = [...referenced].filter((k) => !covered.has(k));
    if (missing.length) findings.push({ level: 'warn', obligation: o.id, message: `examples cover ${[...covered].join(', ') || 'no action kind'} but the expressions also reference ${missing.join(', ')} — examples are a refusal condition at declare time, not the measure of the policy (the harden report over the declared domain is); add a case per kind or read the report as the evidence` });
  }

  for (const o of plan.obligations) {
    let grade = o.coverage; const notes = [];
    if (o.kind === 'machine') {
      const m = plan.machines.find((x) => x.id === o.id);
      if (!m.regions.length) notes.push('no declared region: proof value is rejection coverage and reachability, not mediation');
      if (!m.gates.length) { notes.push('no-gates: mediation claim vacuous'); findings.push({ level: 'warn', obligation: o.id, message: 'no gate inferred or declared — enforced, but the mediation claim is vacuous (doctrine 24)' }); }
    }
    if (o.kind === 'rule') { const r = plan.rules.find((x) => x.id === o.id); if (r.open) grade = 'runtime-only'; if (r.severity === 'warn') notes.push('warn severity: never rejects, no rejection obligation'); }
    if (o.kind === 'invariant') { const i = plan.invariants.find((x) => x.id === o.id); if (i.coverage !== 'checked') { grade = i.coverage; notes.push('reads undeclared vars: enforced at runtime, not model-checked'); } }
    plan.coverage.push({ id: o.id, grade, notes });
  }
  return plan;
}

// ------------------------------------------------------------------ rules
/** A quantifier over history used inside arithmetic (a ratio, a sum): a saturating counter would change its meaning, so the rule stays open — evaluated over the live history, never lifted. */
function arithmeticOverHistory(ast) {
  const hasQuantifier = (n) => Array.isArray(n) && ((n[0] === 'call' && ['count', 'any', 'all', 'none', 'first', 'last'].includes(n[1]) && Array.isArray(n[2]) && n[2][0] === 'path' && n[2][1] === 'history') || n.slice(1).some(hasQuantifier));
  const walk = (n) => Array.isArray(n) && ((['+', '-', '*'].includes(n[0]) && n.slice(1).some(hasQuantifier)) || n.slice(1).some(walk));
  return walk(ast);
}

function compileRule(o, unique, addKey, findings) {
  const lifted = [];
  let open = false;
  if (arithmeticOverHistory(o._require.ast) || (o._when && arithmeticOverHistory(o._when.ast))) {
    findings.push({ level: 'warn', obligation: o.id, message: 'a history count inside arithmetic (a ratio or a sum) is evaluated over the live history, not lifted to a saturating counter, which would change its meaning past the cap; the rule is runtime-only' });
    return { id: o.id, severity: o.severity, when: o._when ? o._when.ast : null, whenSrc: o.when, require: o._require.ast, requireSrc: o.require, lifted: [], open: true, cap: o.cap, coverage: 'runtime-only' };
  }
  const lift = (ast, specs) => {
    const map = new Map();
    for (const h of specs) {
      if (h.open) { open = true; continue; }
      const key = unique(`h_${o.id}_${h.fn}`);
      if (h.fn === 'count') addKey(key, 'number', Array.from({ length: o.cap + 1 }, (_, i) => i), 0);
      else if (h.fn === 'all' || h.fn === 'none') addKey(key, 'boolean', [false, true], true);
      else addKey(key, 'boolean', [false, true], false);
      lifted.push({ key, fn: h.fn, param: h.param, pred: h.pred, cap: o.cap });
      map.set(h.node, ['get', ['path', 'lifted'], key]);
      checkCap(o, ast, h.node);
      for (const ref of references(h.pred)) if (/^h\.action\.(branch|host|path|content|message|headers|query|url|target)$/.test(ref.replace(h.param + '.', 'h.'))) {
        findings.push({ level: 'info', obligation: o.id, message: `lifted predicate reads ${ref}, which can be absent on some actions; an unknown match does not advance the counter — add ?? '' if that is not intended` });
        break;
      }
    }
    return replaceNodes(ast, map);
  };
  const requireAst = lift(o._require.ast, o._lifted.require);
  const whenAst = o._when ? lift(o._when.ast, o._lifted.when) : null;
  return { id: o.id, severity: o.severity, when: whenAst, whenSrc: o.when, require: requireAst, requireSrc: o.require, lifted, open, cap: o.cap, coverage: open ? 'runtime-only' : 'checked' };
}

/** Refuse a count bound the saturating counter cannot represent. */
function checkCap(o, ast, node) {
  const walk = (n) => {
    if (!Array.isArray(n)) return;
    if (['<', '<=', '>', '>='].includes(n[0]) && (n[1] === node || n[2] === node)) {
      const other = n[1] === node ? n[2] : n[1];
      if (other[0] === 'lit' && typeof other[1] === 'number') {
        const N = other[1];
        // normalize to "count OP N" with the counter on the left
        let op = n[0];
        if (n[2] === node) op = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' }[op];
        // the counter saturates at cap: `count <= N` / `count > N` need cap >= N + 1; `count < N` / `count >= N` need cap >= N
        const needed = op === '<=' || op === '>' ? N + 1 : N;
        if (needed > o.cap) throw new CompileError(`rule '${o.id}' compares a history count with ${N} (${op}) but its counter saturates at cap ${o.cap}; raise cap to at least ${needed}`, o.id);
      }
    }
    for (let i = 1; i < n.length; i++) walk(n[i]);
  };
  walk(ast);
}

/** Replace nodes by identity in one pass (rebuilding arrays would lose identities for later targets). */
function replaceNodes(ast, map) {
  if (map.has(ast)) return map.get(ast);
  if (!Array.isArray(ast)) return ast;
  return ast.map((x, i) => (i === 0 ? x : replaceNodes(x, map)));
}

// --------------------------------------------------------------- machines
function compileMachine(o, unique, addKey) {
  const cm = o._machine;
  const m = { id: o.id, key: addKey(unique(`m_${o.id}_state`), 'string', cm.states, cm.initial), states: cm.states, initial: cm.initial, vars: {}, transitions: [], guards: [], regions: [], discharge: cm.discharge, gates: [] };
  for (const [name, spec] of Object.entries(cm.vars)) {
    const key = addKey(unique(`m_${o.id}_${name}`), spec.type, spec.domain, spec.initial);
    m.vars[name] = { ...spec, key };
  }
  m.regions = cm.regions.map((r) => ({ name: r.name, kind: r.kind, src: r.predicate, ast: r._predicate.ast, refs: r._predicate.refs }));
  const guardedStates = new Set(cm.guards.flatMap((g) => g.in));
  const regionVars = new Set(m.regions.flatMap((r) => r.refs.filter((x) => x.startsWith('machine.vars.')).map((x) => x.split('.')[2])));
  m.guards = cm.guards.map((g) => ({ idx: g.idx, in: g.in, when: g._when.ast, whenSrc: g.when, holds: g._holds ? g._holds.ast : null, reason: g.reason, region: g.region }));
  m.transitions = cm.transitions.map((t) => {
    const leavesGuarded = t.from.some((s) => guardedStates.has(s)) && !guardedStates.has(t.to);
    const settlePhase = t.phase === 'settle';
    const writesRegionVar = !settlePhase && Object.keys(t._set).some((k) => regionVars.has(k));
    const inferred = leavesGuarded || writesRegionVar;
    const gated = t.gate === null ? inferred : t.gate;
    let route = null; let gateAction = null;
    if (gated) {
      const actionOnly = conjuncts(t._when.ast).filter((c) => { const r = roots(c); return r.size > 0 && [...r].every((x) => x === 'action'); });
      if (!actionOnly.length) throw new CompileError(`machine '${o.id}' transition #${t.idx} is a gate but its 'when' has no action-only conjunct to route calls by; add one (e.g. action.kind == '…') or set gate: false`, o.id);
      route = actionOnly.reduce((a, b) => ['&&', a, b]);
      gateAction = unique(`GATE__${o.id}__${t.idx}`);
      m.gates.push(gateAction);
    }
    return { idx: t.idx, phase: t.phase ?? 'gate', from: t.from, when: t._when.ast, whenSrc: t.when, to: t.to, set: Object.fromEntries(Object.entries(t._set).map(([k, v]) => [k, v.ast])), setSrc: t.set, gate: gated, inferred: t.gate === null && inferred, route, gateAction };
  });
  for (const t of cm.transitions) for (const k of Object.keys(t._set)) {
    const spec = cm.vars[k];
    if (spec.type === 'number' && !spec.saturate && /\+|-|\*/.test(t.set[k])) throw new CompileError(`machine '${o.id}' sets var '${k}' arithmetically without saturate: true; exploration could leave the domain`, o.id);
  }
  return m;
}

// ---------------------------------------------------------------- samples
const MAX_SAMPLES = 1200;
function collectSamples(compiled) {
  const out = []; const seen = new Set();
  const push = (a) => { if (!a || typeof a !== 'object' || typeof a.kind !== 'string') return; const k = canon(a); if (seen.has(k)) return; seen.add(k); out.push(a); };
  // per-obligation lists interleaved round-robin, so the cap starves no obligation (a policy of thirty obligations once lost a machine's recovery command past the cap and was refused as undischargeable)
  const lists = compiled.map((o) => {
    const l = [];
    if (o.examples) for (const seq of [...o.examples.deny, ...o.examples.allow]) for (const step of seq) { const { observed, ...s } = step.kind ? step : step.action ?? {}; if (s.kind) l.push(s); }
    if (o.kind === 'machine') l.push(...synthesizeActions(o._machine));
    if (o.kind === 'rule') l.push(...synthesizeFromRule(o));
    return l;
  });
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) push(l[i]);
  // per-obligation domains, kept for the per-machine dischargeability check (m2) which explores one machine at a time
  out.by = Object.fromEntries(compiled.map((o, k) => [o.id, lists[k]]));
  {
  for (const eff of ['read:web', 'read:private', 'read:store', 'write:store', 'write:repo', 'egress:public', 'egress:external', 'exec', 'admin', 'read:repo', 'write:workspace']) push({ kind: 'tool.call', effects: [eff] });
  push({ kind: 'tool.call', effects: ['read:web', 'read:private'] });
  push({ kind: 'tool.call', effects: ['read:web', 'egress:public'] });
  push({ kind: 'tool.call', effects: ['read:private', 'egress:external'] });
  push({ kind: 'tool.call' });
  }
  const sliced = out.slice(0, MAX_SAMPLES); sliced.by = out.by;
  return sliced;
}

function synthesizeFromRule(o) {
  const fake = { transitions: [{ _when: o._require, _set: {} }, ...(o._when ? [{ _when: o._when, _set: {} }] : [])], guards: [], states: [], vars: {} };
  return synthesizeActions(fake).filter((a) => a.kind !== 'run.end');
}

// ---------------------------------------------------------------- regions
/** PX AST (restricted) → JS expression over flat keys, for polysec's compileRegion. */
export function toJs(ast, plan, machine) {
  const lit = (v) => JSON.stringify(v);
  const path = (n) => {
    const p = [];
    let cur = n;
    while (cur[0] === 'get') { p.unshift(cur[2]); cur = cur[1]; }
    if (cur[0] !== 'path') throw new CompileError('region predicate: unsupported path');
    p.unshift(cur[1]);
    if (p[0] === 'state' && p.length === 2 && plan.vars[p[1]]) return plan.vars[p[1]];
    if (p[0] === 'machine' && p[1] === 'vars' && p.length === 3 && machine && machine.vars[p[2]]) return machine.vars[p[2]].key;
    if (p[0] === 'machine' && p[1] === 'state' && p.length === 2 && machine) return machine.key;
    if (p[0] === 'lifted' && p.length === 2) return p[1];
    throw new CompileError(`region predicate reads '${p.join('.')}', which is not a model key`);
  };
  const go = (n) => {
    switch (n[0]) {
      case 'lit': return lit(n[1]);
      case 'get': case 'path': return path(n);
      case '&&': return `(${go(n[1])} && ${go(n[2])})`;
      case '||': return `(${go(n[1])} || ${go(n[2])})`;
      case '!': return `(!${go(n[1])})`;
      case '==': return `(${go(n[1])} === ${go(n[2])})`;
      case '!=': return `(${go(n[1])} !== ${go(n[2])})`;
      case '<': case '<=': case '>': case '>=': return `(${go(n[1])} ${n[0]} ${go(n[2])})`;
      case '+': case '-': case '*': return `(${go(n[1])} ${n[0]} ${go(n[2])})`;
      case 'in': if (n[2][0] === 'list') return `[${n[2].slice(1).map(go).join(', ')}].includes(${go(n[1])})`; throw new CompileError('region predicate: `in` needs a literal list');
      case '??': return `(${go(n[1])} ?? ${go(n[2])})`;
      default: throw new CompileError(`region predicate: unsupported operator '${n[0]}' (regions are predicates over model keys)`);
    }
  };
  return go(ast);
}
