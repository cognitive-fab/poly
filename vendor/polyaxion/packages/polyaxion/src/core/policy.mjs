// Policy documents (authoring format v2): validation, compilation, hashing.
//
// A policy is what an author writes (`polyaxion.policy.json`). `compilePolicy`
// validates it, compiles every PX expression once, and yields the compiled
// obligations the plan compiler (compile/plan.mjs) turns into polysec's
// policy triple. The authoring digest is sha256 over the canonical normalized
// document (examples excluded: tests, not semantics).
//
// Format "1" documents are accepted and upgraded: no `vars`, scalar machine
// vars get a default finite domain, `end` becomes `discharge`.
import { compile as compileExpr, ExprError } from './expr.mjs';
import { digest, clone } from './canon.mjs';
import { scopeSelectorValid } from './scope.mjs';

export const KINDS = ['rule', 'machine', 'invariant', 'recalled', 'native'];
export const STATE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
export const SEVERITIES = ['deny', 'warn', 'escalate'];
export const COVERAGES = ['checked', 'runtime-only'];
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const DEFAULT_CAP = 8;
/** The coverage grade in the words the model reads in the recall block; the auditor gets the same words (spec 03 §7). */
export const GRADE_WORDS = { checked: 'model-checked', 'runtime-only': 'runtime-only', recalled: 'recalled (not enforced)' };
export function gradeWords(grade) { return GRADE_WORDS[grade] ?? String(grade ?? 'unknown'); }
/** A policy's enforcement grade: the worst grade among its enforced obligations. */
export function enforcementOf(coverage) {
  const enforced = (Array.isArray(coverage) ? coverage : []).filter((c) => c.grade !== 'recalled');
  if (!enforced.length) return null;
  return gradeWords(enforced.some((c) => c.grade !== 'checked') ? 'runtime-only' : 'checked');
}
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class PolicyError extends Error {
  constructor(message, path) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'PolicyError';
    this.path = path;
  }
}

function expr(src, path) {
  try { return compileExpr(src); } catch (e) {
    if (e instanceof ExprError) throw new PolicyError(`bad expression: ${e.message}`, path);
    throw e;
  }
}

/** Validate + compile a policy document. Returns { doc, compiled, hash, findings, format }. */
export function compilePolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PolicyError('policy must be an object');
  const format = String(input.polyaxion);
  if (format !== '1' && format !== '2') throw new PolicyError("policy.polyaxion must be '2' (or '1', upgraded on read)");
  const doc = input;
  if (typeof doc.id !== 'string' || !ID_RE.test(doc.id)) throw new PolicyError('policy.id must match ' + ID_RE, 'id');
  const scope = doc.scope ?? '**';
  if (!scopeSelectorValid(scope)) throw new PolicyError(`invalid scope selector '${scope}'`, 'scope');
  if (!Array.isArray(doc.obligations) || doc.obligations.length === 0) throw new PolicyError('policy.obligations must be a non-empty array', 'obligations');
  const budget = compileBudget(doc.budget);

  const findings = [];
  lintHiddenContext(doc, findings);
  const vars = compileVars(doc.vars ?? {}, 'vars');
  const seen = new Set();
  const compiled = doc.obligations.map((o, i) => {
    const path = `obligations[${i}]`;
    const c = compileObligation(o, path, scope, findings, vars, format);
    if (seen.has(c.id)) throw new PolicyError(`duplicate obligation id '${c.id}'`, path);
    seen.add(c.id);
    return c;
  });
  if (compiled.some((c) => c.kind === 'native') && compiled.length > 1) throw new PolicyError('a policy holding a native obligation holds only that obligation (its triple is the whole machine)', 'obligations');
  const normalized = {
    polyaxion: '2',
    id: doc.id,
    version: doc.version ?? null,
    description: doc.description ?? null,
    scope,
    budget,
    vars: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { type: v.type, domain: v.domain, initial: v.initial }])),
    obligations: compiled.map(stripCompiled),
  };
  const hash = digest(normalized);
  return { doc: normalized, compiled, vars, hash, findings, format };
}

// Hidden-context lint (OWASP LLM Top 10 2026, LLM08): the recall block re-enters
// the model's context, so a policy is disclosed by construction and must carry
// no secret. Patterns are deliberately loose: a false positive costs a warning,
// a false negative costs a credential.
const CREDENTIAL_RE = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
];
function lintHiddenContext(doc, findings) {
  const scan = (obligation, field, value) => {
    if (typeof value !== 'string') return;
    if (CREDENTIAL_RE.some((re) => re.test(value))) findings.push({ level: 'warn', obligation, message: `${field} looks like it carries a credential — a policy is disclosed by construction (the recall block re-enters the context; OWASP LLM08): keep secrets in the systems the model does not reach and name them, never quote them` });
  };
  for (const o of Array.isArray(doc.obligations) ? doc.obligations : []) {
    if (!o || typeof o !== 'object') continue;
    for (const f of ['text', 'hint', 'when', 'require', 'invariant']) scan(o.id, f, o[f]);
    const m = o.machine;
    if (m && typeof m === 'object') {
      for (const [i, t] of (Array.isArray(m.transitions) ? m.transitions : []).entries()) { scan(o.id, `machine.transitions[${i}].when`, t?.when); for (const [k, e] of Object.entries(t?.set ?? {})) scan(o.id, `machine.transitions[${i}].set.${k}`, e); }
      for (const [i, g] of (Array.isArray(m.guards) ? m.guards : []).entries()) { scan(o.id, `machine.guards[${i}].when`, g?.when); scan(o.id, `machine.guards[${i}].holds`, g?.holds); }
    }
  }
  scan(null, 'description', doc.description);
}

/** Optional `budget: { steps }`: the per-call evaluation-step bound the author accepts (availability spec BL-2); admission refuses a policy whose computed worst case exceeds it. */
function compileBudget(b) {
  if (b === undefined || b === null) return null;
  if (typeof b !== 'object' || Array.isArray(b)) throw new PolicyError('budget must be an object { steps }', 'budget');
  if (!Number.isInteger(b.steps) || b.steps < 1) throw new PolicyError('budget.steps must be a positive integer', 'budget.steps');
  return { steps: b.steps };
}

function stripCompiled(c) {
  const { _when, _require, _invariant, _machine, _lifted, examples, ...rest } = c;
  return rest;
}

// ------------------------------------------------------------------- vars
function domainOf(v, path, initial) {
  const t = v.type ?? (Array.isArray(initial) ? 'list' : typeof initial === 'number' ? 'number' : typeof initial === 'boolean' ? 'boolean' : 'string');
  if (!['number', 'boolean', 'string', 'list'].includes(t)) throw new PolicyError(`type must be number, boolean, string or list`, path);
  let domain = v.domain;
  if (domain === undefined) {
    if (t === 'boolean') domain = [false, true];
    else if (t === 'number') domain = Number.isInteger(initial) && initial >= 0 ? Array.from({ length: Math.max(DEFAULT_CAP, initial) + 1 }, (_, i) => i) : [initial];
    else domain = [initial];
  }
  if (!Array.isArray(domain) || domain.length === 0 || domain.length > 64) throw new PolicyError('domain must be a non-empty list (max 64 values)', path);
  const same = (d) => (t === 'list' ? Array.isArray(d) : typeof d === t);
  for (const d of domain) if (!same(d)) throw new PolicyError(`domain value ${JSON.stringify(d)} is not of type ${t}`, path);
  const eq = (a, b) => (t === 'list' ? JSON.stringify(a) === JSON.stringify(b) : a === b);
  if (!domain.some((d) => eq(d, initial))) throw new PolicyError(`initial ${JSON.stringify(initial)} is not in the domain`, path);
  return { type: t, domain: clone(domain), initial: clone(initial), saturate: !!v.saturate };
}

function compileVars(raw, path) {
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new PolicyError('vars must be an object', path);
  const out = {};
  for (const [name, v] of Object.entries(raw)) {
    if (!VAR_RE.test(name)) throw new PolicyError(`bad var name '${name}'`, path);
    const spec = v && typeof v === 'object' && !Array.isArray(v) ? v : { initial: v };
    if (spec.initial === undefined || spec.initial === null) throw new PolicyError(`var '${name}' needs an initial value`, `${path}.${name}`);
    out[name] = domainOf(spec, `${path}.${name}`, spec.initial);
  }
  return out;
}

// ------------------------------------------------------------ obligations
function normalizeExamples(ex, path) {
  if (ex === undefined || ex === null) return null;
  if (typeof ex !== 'object' || Array.isArray(ex)) throw new PolicyError('examples must be {deny: [...], allow: [...]}', path + '.examples');
  const norm = (list, k) => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new PolicyError(`examples.${k} must be a list`, path + '.examples');
    return list.map((seq) => (Array.isArray(seq) ? seq : [seq]));
  };
  return { deny: norm(ex.deny, 'deny'), allow: norm(ex.allow, 'allow') };
}

function compileObligation(o, path, defaultScope, findings, vars, format = '2') {
  if (!o || typeof o !== 'object') throw new PolicyError('obligation must be an object', path);
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) throw new PolicyError('obligation.id must match ' + ID_RE, path + '.id');
  if (!KINDS.includes(o.kind)) throw new PolicyError(`kind must be one of ${KINDS.join(', ')}`, path + '.kind');
  if (typeof o.text !== 'string' || !o.text.trim()) throw new PolicyError('text (the human-readable obligation) is required', path + '.text');
  const severity = o.severity ?? 'deny';
  if (!SEVERITIES.includes(severity)) throw new PolicyError(`severity must be one of ${SEVERITIES.join(', ')}`, path + '.severity');
  if (severity === 'escalate' && o.kind !== 'rule') throw new PolicyError("severity 'escalate' is a severity of rules only: a guard's region is proved unreachable and a human cannot be approved into it — model approval on a machine as a transition on an approval action (spec 02 §2.6)", path + '.severity');
  const scope = o.scope ?? defaultScope;
  if (!scopeSelectorValid(scope)) throw new PolicyError(`invalid scope selector '${scope}'`, path + '.scope');

  const base = {
    id: o.id, kind: o.kind, text: o.text.trim(), severity, scope,
    tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
    source: o.source ?? null,
    hint: typeof o.hint === 'string' ? o.hint : null,
    examples: normalizeExamples(o.examples, path),
  };

  switch (o.kind) {
    case 'recalled':
      for (const k of ['when', 'require', 'machine', 'invariant']) if (k in o) throw new PolicyError(`a 'recalled' obligation has no '${k}'`, path);
      return { ...base, coverage: 'recalled' };
    case 'native': {
      // a hand-written polysec triple, embedded verbatim (spec 02 §2.5): enforced by its own machine, proved by harden over it
      const n = o.native;
      if (!n || typeof n !== 'object' || Array.isArray(n)) throw new PolicyError("native needs 'native': { module, contract, security }", path + '.native');
      if (typeof n.module !== 'string' || !n.module.trim()) throw new PolicyError('native.module must be the SAM v2 module source', path + '.native.module');
      if (!n.contract || typeof n.contract !== 'object' || Array.isArray(n.contract)) throw new PolicyError('native.contract must be the contract object', path + '.native.contract');
      if (!n.security || typeof n.security !== 'object' || !Array.isArray(n.security.forbiddenRegions) || !n.security.tools || typeof n.security.tools !== 'object') throw new PolicyError('native.security must carry forbiddenRegions and a tools map', path + '.native.security');
      for (const k of ['when', 'require', 'machine', 'invariant', 'examples', 'coverage']) if (k in o) throw new PolicyError(`a 'native' obligation has no '${k}'`, path);
      return { ...base, examples: null, coverage: 'checked', native: { module: n.module, contract: n.contract, security: n.security } };
    }
    case 'rule': {
      if (typeof o.require !== 'string') throw new PolicyError("rule needs 'require' (expression that must hold)", path + '.require');
      const req = expr(o.require, path + '.require');
      const when = o.when === undefined || o.when === null ? null : expr(o.when, path + '.when');
      if (when === null && !req.refs.some((r) => /^(action|history|patch|state|run)\b/.test(r))) {
        findings.push({ level: 'warn', obligation: o.id, message: "rule 'require' references neither action, history, patch nor state — it is constant" });
      }
      const history = { require: classifyHistory(req.ast, path + '.require'), when: when ? classifyHistory(when.ast, path + '.when') : [] };
      const ratio = (ast) => { const q = (n) => Array.isArray(n) && ((n[0] === 'call' && ['count', 'any', 'all', 'none', 'first', 'last'].includes(n[1]) && Array.isArray(n[2]) && n[2][0] === 'path' && n[2][1] === 'history') || n.slice(1).some(q)); const w = (n) => Array.isArray(n) && ((['+', '-', '*'].includes(n[0]) && n.slice(1).some(q)) || n.slice(1).some(w)); return w(ast); };
      const open = [...history.require, ...history.when].some((h) => h.open) && !(ratio(req.ast) || (when && ratio(when.ast)));
      if (o.coverage !== undefined && !COVERAGES.includes(o.coverage)) throw new PolicyError(`coverage must be one of ${COVERAGES.join(', ')}`, path + '.coverage');
      if (open && o.coverage !== 'runtime-only') {
        throw new PolicyError(`rule quantifies over history with a predicate that reads the current action (or uses first/last): it cannot be model-checked. Declare "coverage": "runtime-only" to acknowledge that examples are its only pre-serve check`, path + '.require');
      }
      if (!open && o.coverage === 'runtime-only') findings.push({ level: 'warn', obligation: o.id, message: "coverage 'runtime-only' declared but the rule is closed — it will be model-checked anyway" });
      const cap = o.cap ?? DEFAULT_CAP;
      if (!Number.isInteger(cap) || cap < 1 || cap > 64) throw new PolicyError('cap must be an integer 1..64', path + '.cap');
      for (const r of req.refs) if (r.startsWith('state.') && !(r.split('.')[1] in vars)) findings.push({ level: 'warn', obligation: o.id, message: `reads undeclared var '${r}' (always unknown)` });
      return { ...base, when: o.when ?? null, require: o.require, cap, coverage: open ? 'runtime-only' : 'checked', _when: when, _require: req, _lifted: history };
    }
    case 'invariant': {
      if (typeof o.invariant !== 'string') throw new PolicyError("invariant needs 'invariant' (expression over state that must hold after every merge)", path + '.invariant');
      const inv = expr(o.invariant, path + '.invariant');
      const undeclared = inv.refs.filter((r) => r.startsWith('state.') && !(r.split('.')[1] in vars));
      if (undeclared.length) findings.push({ level: 'warn', obligation: o.id, message: `invariant reads undeclared var(s) ${undeclared.join(', ')} — enforced at runtime only; declare them in policy.vars with a finite domain to model-check` });
      return { ...base, invariant: o.invariant, coverage: undeclared.length ? 'runtime-only' : 'checked', _invariant: inv };
    }
    case 'machine': {
      const m = compileMachine(o.machine, path + '.machine', findings, o.id);
      return { ...base, machine: m.doc, coverage: 'checked', _machine: m.compiled };
    }
    default: throw new PolicyError('unreachable', path);
  }
}

/** Find history quantifiers in an AST; classify each as closed (liftable) or open. */
export function classifyHistory(ast, path) {
  const out = [];
  const walk = (n, inLambda) => {
    if (!Array.isArray(n)) return;
    if (n[0] === 'call' && n[2] && n[2][0] === 'path' && n[2][1] === 'history') {
      const fn = n[1];
      if (!n[3] || n[3][0] !== 'fn') throw new PolicyError(`${fn}(history, …) needs a lambda`, path);
      const lam = n[3];
      const refs = new Set();
      const collect = (x) => { if (!Array.isArray(x)) return; if (x[0] === 'path') refs.add(x[1]); for (let i = 1; i < x.length; i++) collect(x[i]); };
      collect(lam[2]);
      const openRefs = [...refs].filter((r) => r !== lam[1]);
      const open = openRefs.length > 0 || fn === 'first' || fn === 'last';
      out.push({ fn, param: lam[1], pred: lam[2], open, openRefs, node: n });
      return;
    }
    if (n[0] === 'path' && n[1] === 'history' && !inLambda) throw new PolicyError('history may only be used inside count/any/all/none/first/last(history, h => …)', path);
    for (let i = 1; i < n.length; i++) walk(n[i], inLambda || n[0] === 'fn');
  };
  walk(ast, false);
  return out;
}

function compileMachine(m, path, findings, oid) {
  if (!m || typeof m !== 'object') throw new PolicyError('machine must be an object', path);
  if (!Array.isArray(m.states) || m.states.length === 0 || !m.states.every((s) => typeof s === 'string' && STATE_RE.test(s))) throw new PolicyError('machine.states must be a non-empty list of names (' + STATE_RE + ')', path + '.states');
  const states = new Set(m.states);
  if (states.size !== m.states.length) throw new PolicyError('machine.states has duplicates', path + '.states');
  if (typeof m.initial !== 'string' || !states.has(m.initial)) throw new PolicyError('machine.initial must be one of machine.states', path + '.initial');
  const vars = compileVars(m.vars ?? {}, path + '.vars');
  const stateList = (v, p, allowStar) => {
    if (v === undefined || v === '*') { if (allowStar) return [...states]; throw new PolicyError('missing state list', p); }
    const arr = Array.isArray(v) ? v : [v];
    for (const s of arr) if (!states.has(s)) throw new PolicyError(`unknown state '${s}'`, p);
    return arr;
  };
  const transitions = (m.transitions ?? []).map((t, i) => {
    const p = `${path}.transitions[${i}]`;
    if (!t || typeof t !== 'object') throw new PolicyError('transition must be an object', p);
    if (typeof t.when !== 'string') throw new PolicyError("transition needs 'when'", p + '.when');
    if (typeof t.to !== 'string' || !states.has(t.to)) throw new PolicyError("transition 'to' must be a declared state", p + '.to');
    const set = t.set ?? {};
    const setC = {};
    for (const [k, src] of Object.entries(set)) {
      if (!(k in vars)) throw new PolicyError(`set of undeclared var '${k}'`, p + '.set');
      if (typeof src !== 'string') throw new PolicyError(`set.${k} must be an expression string`, p + '.set');
      setC[k] = expr(src, `${p}.set.${k}`);
    }
    if (t.gate !== undefined && t.gate !== null && typeof t.gate !== 'boolean') throw new PolicyError('gate must be true or false', p + '.gate');
    const phase = t.phase ?? 'gate';
    if (phase !== 'gate' && phase !== 'settle') throw new PolicyError("phase must be 'gate' (default) or 'settle' (fires after the tool ran, may read observed.ok)", p + '.phase');
    if (phase === 'settle' && t.gate === true) throw new PolicyError('a settle-phase transition cannot be a gate: it fires after the effect, it authorizes nothing', p + '.gate');
    const whenC = expr(t.when, p + '.when');
    if (phase !== 'settle' && whenC.refs.some((r) => r === 'observed' || r.startsWith('observed.'))) throw new PolicyError("only a transition with \"phase\": \"settle\" may read `observed` (a gate decides before the effect and cannot see its result)", p + '.when');
    return { idx: i, from: stateList(t.from, p + '.from', true), when: t.when, to: t.to, set, gate: t.gate ?? null, phase, note: t.note ?? null, _when: whenC, _set: setC };
  });
  const guards = (m.guards ?? []).map((g, i) => {
    const p = `${path}.guards[${i}]`;
    if (!g || typeof g !== 'object') throw new PolicyError('guard must be an object', p);
    if (typeof g.when !== 'string') throw new PolicyError("guard needs 'when' (expression that, when true, denies the action)", p + '.when');
    if (typeof g.reason !== 'string' || !g.reason.trim()) throw new PolicyError("guard needs 'reason'", p + '.reason');
    if (g.region !== undefined && g.region !== false && (typeof g.region !== 'string' || !ID_RE.test(g.region))) throw new PolicyError('region must be a name (' + ID_RE + ') or false', p + '.region');
    const holds = g.holds === undefined || g.holds === null ? null : g.holds;
    return { idx: i, in: stateList(g.in, p + '.in', true), when: g.when, holds, reason: g.reason.trim(), region: g.region === undefined ? `${oid}.${g.reason.trim()}` : g.region, _when: expr(g.when, p + '.when'), _holds: holds === null ? null : expr(holds, p + '.holds') };
  });
  if (transitions.length === 0 && guards.length === 0) throw new PolicyError('machine has neither transitions nor guards', path);
  const dischargeRaw = m.discharge ?? m.end;
  const discharge = dischargeRaw === undefined ? null : stateList(dischargeRaw, path + '.discharge', false);
  const regions = (m.regions ?? []).map((r, i) => {
    const p = `${path}.regions[${i}]`;
    if (!r || typeof r.name !== 'string' || typeof r.predicate !== 'string') throw new PolicyError('region needs name and predicate', p);
    return { name: r.name, kind: r.kind ?? 'safety', predicate: r.predicate, _predicate: expr(r.predicate, p + '.predicate') };
  });

  // structural reachability (ignoring conditions)
  const reach = new Set([m.initial]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of transitions) if (t.from.some((s) => reach.has(s)) && !reach.has(t.to)) { reach.add(t.to); grew = true; }
  }
  for (const s of m.states) if (!reach.has(s)) findings.push({ level: 'warn', obligation: oid, message: `machine state '${s}' is unreachable from '${m.initial}' by any transition` });
  if (discharge) for (const s of discharge) if (!reach.has(s)) findings.push({ level: 'error', obligation: oid, message: `discharge state '${s}' is unreachable — every run would be refused at run.end` });

  const doc = {
    states: m.states, initial: m.initial,
    vars: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { type: v.type, domain: v.domain, initial: v.initial, saturate: v.saturate }])),
    transitions: transitions.map(({ _when, _set, idx, ...t }) => t),
    guards: guards.map(({ _when, _holds, idx, ...g }) => g),
    regions: regions.map(({ _predicate, ...r }) => r),
    discharge,
  };
  return { doc, compiled: { states: m.states, initial: m.initial, vars, transitions, guards, regions, discharge, end: discharge } };
}

/** Initial machine slot (v0.1 runtime; kept until the kernel rewire lands). */
export function initialMachineState(compiledMachine) {
  return { state: compiledMachine.initial, vars: Object.fromEntries(Object.entries(compiledMachine.vars).map(([k, v]) => [k, v.initial])), since: 0, trail: [] };
}
