// The static checker (PT2, PT3, PT4, PS2): names, types, domains and the
// per-path rules of a handler. It runs on the AST every surface produces, so
// it lives in poly-core. It is compiler code: poly-ref never imports it.
//
// Output: diagnostics, plus per-machine facts the lowering reads (how each
// name resolved, the type of each expression). A program with any error is
// not lowered.
import type * as A from '../ast.js';
import { diag, type Diagnostic, type NodeAt } from '../diagnostics.js';
import { buildTypeEnv, cardinality, type TypeEnv, type UnionInfo } from '../types.js';

// ── semantic types ─────────────────────────────────────────────────────────

export type Ty =
  | { k: 'bool' }
  | { k: 'int'; lo: number; hi: number }
  | { k: 'string' }
  | { k: 'union'; name: string }
  | { k: 'map'; key: Ty; value: Ty; array: boolean }
  | { k: 'ref' }
  | { k: 'action' }
  | { k: 'error' };

const BOOL: Ty = { k: 'bool' };
const INT: Ty = { k: 'int', lo: -Infinity, hi: Infinity };
const ERR: Ty = { k: 'error' };

export function tyToString(t: Ty): string {
  switch (t.k) {
    case 'int': return Number.isFinite(t.lo) && Number.isFinite(t.hi) ? `${t.lo}..${t.hi}` : 'int';
    case 'union': return t.name;
    case 'map': return `map<${tyToString(t.key)}, ${tyToString(t.value)}>`;
    default: return t.k;
  }
}

function same(a: Ty, b: Ty): boolean {
  if (a.k === 'error' || b.k === 'error') return true;
  if (a.k !== b.k) return false;
  if (a.k === 'union') return a.name === (b as { name: string }).name;
  if (a.k === 'map') {
    const m = b as typeof a;
    return same(a.key, m.key) && same(a.value, m.value);
  }
  return true; // int ranges are one type; ranges bound values, not the type (PT3.5)
}

/** What a name in an expression turned out to be. The lowering reads this. */
export type Resolution =
  | { k: 'field'; name: string }
  | { k: 'param'; name: string }
  | { k: 'let'; name: string }
  | { k: 'bind'; name: string }
  | { k: 'ctor'; union: string; ctor: string }
  | { k: 'action'; name: string }
  | { k: 'actionVar' }
  | { k: 'none' }
  | { k: 'pre' }
  | { k: 'post' };

export interface MachineFacts {
  machine: A.Machine;
  resolutions: Map<string, Resolution>;
  types: Map<string, Ty>;
  fieldTypes: Map<string, Ty>;
  /** Actions with no handler: unhandled in every state (PS3.2). */
  unhandled: string[];
  /** S21: pattern names that are constructors of the payload type, by `<arm id>:<payload>`, with the constructor. */
  patternLiterals: Map<string, string>;
  /** The machine's effect declarations by name (PT6.1). */
  effects: Map<string, A.EffectDecl>;
  /** `Action.param` for every parameter whose check domain is strict, declared or by PT3.4a's flow rule. */
  strictParams: Set<string>;
}

export interface CheckResult {
  diagnostics: Diagnostic[];
  env: TypeEnv;
  machines: Map<string, MachineFacts>;
}

// ── scopes ────────────────────────────────────────────────────────────────

type Ctx = 'init' | 'handler' | 'guard' | 'terminal' | 'invariant' | 'step' | 'reject' | 'path';

interface Scope {
  ctx: Ctx;
  /** Local names: lets and pattern binders. */
  locals: Map<string, { ty: Ty; res: Resolution; mark?: { used: boolean } }>;
  /** Parameters in scope (handler: its action's; properties: established by `action == A`). */
  params: Map<string, Ty>;
  /** In a property, the action established by an `action == A` conjunct. */
  knownAction: string | null;
  /** Names read, for PL1401. */
  reads?: Set<string>;
}

export function checkModule(module: A.Module): CheckResult {
  return new Checker(module).run();
}

class Checker {
  private diags: Diagnostic[] = [];
  private env: TypeEnv;
  private machine: A.Machine | null = null;
  private facts: MachineFacts | null = null;
  private actions = new Map<string, A.Action>();

  constructor(private readonly module: A.Module) {
    this.env = buildTypeEnv(module);
  }

  private at(n: A.NodeBase): NodeAt {
    return { module: this.module.name, machine: this.machine?.name, node: n.id, line: n.span?.line, col: n.span?.col };
  }
  private err(code: string, n: A.NodeBase, msg: string): void {
    this.diags.push(diag(code, this.at(n), msg));
  }

  run(): CheckResult {
    const machines = new Map<string, MachineFacts>();
    this.declarations();
    for (const d of this.module.decls) {
      if (d.kind === 'Use') this.err('PL0901', d, '`use` (imports between modules) is not lowered in milestone M0');
      if (d.kind !== 'Machine') continue;
      if (machines.has(d.name)) { this.err('PL1002', d, `machine ${d.name} is declared twice`); continue; }
      machines.set(d.name, this.checkMachine(d));
    }
    return { diagnostics: this.diags, env: this.env, machines };
  }

  // ── declarations ────────────────────────────────────────────────────────
  private declarations(): void {
    const seen = new Set<string>();
    for (const d of this.module.decls) {
      if (d.kind !== 'TypeDecl' && d.kind !== 'EnumDecl') continue;
      if (seen.has(d.name)) this.err('PL1002', d, `type ${d.name} is declared twice`);
      seen.add(d.name);
      const names = d.kind === 'EnumDecl' ? d.members : d.ctors.map((c) => c.name);
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup) this.err('PL1002', d, `constructor ${dup} is declared twice in ${d.name}`);
      if (d.kind === 'TypeDecl') {
        // S9: constructors of one union share a payload name only with one type.
        const byName = new Map<string, string>();
        for (const c of d.ctors) {
          const fdup = c.fields.map((f) => f.name).find((n, i, a) => a.indexOf(n) !== i);
          if (fdup) this.err('PL1002', c, `payload field ${fdup} is declared twice in ${c.name}`);
          for (const f of c.fields) {
            const t = this.tyOf(f.type);
            const key = tyToString(t);
            const prev = byName.get(f.name);
            if (prev !== undefined && prev !== key) this.err('PL1601', f, `payload ${f.name} is ${prev} in one constructor of ${d.name} and ${key} in ${c.name}; a shared payload name needs one type`);
            byName.set(f.name, key);
            if (cardinality(f.type, this.env) === null) this.err('PL1101', f, `payload ${c.name}.${f.name} has no finite domain; give it a range or an enum type`);
          }
        }
      }
    }
  }

  /** The semantic type of a type expression, reporting unknown names and bad map keys. */
  private tyOf(t: A.TypeExpr): Ty {
    switch (t.kind) {
      case 'TBool': return BOOL;
      case 'TInt': return INT;
      case 'TString': return { k: 'string' };
      case 'TRange':
        if (t.lo > t.hi) { this.errOnce('PL1201', t, `empty range ${t.lo}..${t.hi}`); return ERR; }
        return { k: 'int', lo: t.lo, hi: t.hi };
      case 'TRef': return { k: 'ref' };
      case 'TName':
        if (!this.env.unions.has(t.name)) { this.errOnce('PL1001', t, `unknown type ${t.name}`); return ERR; }
        return { k: 'union', name: t.name };
      case 'TMap': {
        const value = this.tyOf(t.value);
        if (t.key.kind === 'TRange') {
          if (t.key.lo !== 0) this.errOnce('PL1602', t.key, `a map keyed by a range must start at 0, as it lowers to a JSON array (${t.key.lo}..${t.key.hi})`);
          return { k: 'map', key: { k: 'int', lo: t.key.lo, hi: t.key.hi }, value, array: true };
        }
        const key = this.tyOf(t.key);
        if (key.k === 'union' && !this.env.unions.get(key.name)!.isEnum) this.errOnce('PL1201', t.key, `map key ${key.name} must be an enum (constructors without payload)`);
        return { k: 'map', key, value, array: false };
      }
    }
  }

  // ── machines ────────────────────────────────────────────────────────────
  private checkMachine(m: A.Machine): MachineFacts {
    this.machine = m;
    const facts: MachineFacts = { machine: m, resolutions: new Map(), types: new Map(), fieldTypes: new Map(), unhandled: [], patternLiterals: new Map(), effects: new Map(), strictParams: new Set() };
    this.facts = facts;
    this.actions = new Map();

    if (m.version !== null) void 0; // `version N` is recorded; migrations were refused by the parser (PL0901)
    if (m.fields.length === 0) this.err('PL1201', m, `machine ${m.name} declares no state; the first field is its control field (PT4.4a)`);
    for (const f of m.fields) {
      if (facts.fieldTypes.has(f.name)) { this.err('PL1002', f, `field ${f.name} is declared twice`); continue; }
      const ty = this.tyOf(f.type);
      facts.fieldTypes.set(f.name, ty);
      if (f.flag) this.err('PL0901', f, `\`${f.flag}\` fields are not lowered in milestone M0`);
      this.checkDomain(f.name, f.type, ty, f.check, f);
      this.checkInit(f, ty);
    }

    for (const it of m.items) {
      if (it.kind !== 'Action') continue;
      if (this.actions.has(it.name)) { this.err('PL1002', it, `action ${it.name} is declared twice`); continue; }
      this.actions.set(it.name, it);
      const pnames = new Set<string>();
      for (const p of it.params) {
        if (pnames.has(p.name)) this.err('PL1002', p, `parameter ${p.name} is declared twice`);
        pnames.add(p.name);
        this.checkDomain(`${it.name}.${p.name}`, p.type, this.tyOf(p.type), p.check, p);
      }
    }

    // Effects are declared before the handlers that emit them are checked.
    for (const it of m.items) {
      if (it.kind !== 'EffectDecl') continue;
      if (facts.effects.has(it.name)) { this.err('PL1002', it, `effect ${it.name} is declared twice`); continue; }
      facts.effects.set(it.name, it);
    }
    const kinds = new Map<string, string>();
    for (const e of facts.effects.values()) {
      const k = effectKind(e);
      if (kinds.has(k)) this.err('PL1002', e, `effects ${kinds.get(k)} and ${e.name} both have kind "${k}"`);
      kinds.set(k, e.name);
    }
    const handlerOf = new Set(m.items.filter((i): i is A.Handler => i.kind === 'Handler').map((h) => h.action));

    const handled = new Set<string>();
    const propNames = new Set<string>();
    let terminal: A.Terminal | null = null;
    for (const it of m.items) {
      switch (it.kind) {
        case 'Action': break;
        case 'Handler': {
          const act = this.actions.get(it.action);
          if (!act) { this.err('PL1001', it, `handler for undeclared action ${it.action}`); break; }
          if (handled.has(it.action)) { this.err('PL1002', it, `action ${it.action} has two handlers (PT4.1)`); break; }
          handled.add(it.action);
          this.checkHandler(it, act);
          break;
        }
        case 'Guard':
          this.expectBool(it.cond, this.scope('guard'));
          break;
        case 'Terminal': {
          if (terminal) { this.err('PL1002', it, 'a machine has one terminal predicate'); break; }
          terminal = it;
          const scope = this.scope('terminal');
          scope.reads = new Set();
          this.expectBool(it.expr, scope);
          const control = m.fields[0]?.name;
          const others = [...scope.reads].filter((n) => n !== control);
          if (others.length) this.err('PL1401', it, `terminal reads ${others.join(', ')}; it may depend only on the control field ${control} (PT4.4a)`);
          break;
        }
        case 'Property': {
          if (propNames.has(it.name)) this.err('PL1002', it, `property ${it.name} is declared twice`);
          propNames.add(it.name);
          if (it.form === 'compose') { this.err('PL0901', it, 'compose invariants are checked from plan step 6 of milestone M1'); break; }
          if (it.form === 'path') { this.pathProperty(it, new Set(kinds.keys())); break; }
          this.expectBool(it.expr, this.scope(it.form === 'invariant' ? 'invariant' : it.form));
          break;
        }
        case 'Liveness':
          if (propNames.has(it.name)) this.err('PL1002', it, `property ${it.name} is declared twice`);
          propNames.add(it.name);
          // M1-2: a liveness property is checked as far as M1 can (its names and types) and then listed as
          // not run by the pipeline, which folds the verdict to INCONCLUSIVE at best. It no longer refuses the program.
          if (it.from) this.expectBool(it.from, this.scope('invariant'));
          this.expectBool(it.expr, this.scope('invariant'));
          for (const g of it.fair) {
            for (const m of g.members) if (!this.actions.has(m.action)) this.err('PL1001', g, `fairness names ${m.action}, which is not an action of ${this.machine!.name}`);
          }
          break;
        case 'EffectDecl':
          this.effectDecl(it, handlerOf);
          break;
      }
    }
    facts.unhandled = [...this.actions.keys()].filter((a) => !handled.has(a));
    this.strictFlow(m, facts);
    this.machine = null;
    return facts;
  }

  // ── effects (PT6.1, PT6.2, PT3.4a) ─────────────────────────────────────
  private effectDecl(e: A.EffectDecl, handlers: Set<string>): void {
    const pnames = new Set<string>();
    for (const p of e.params) {
      if (pnames.has(p.name)) this.err('PL1002', p, `parameter ${p.name} is declared twice`);
      pnames.add(p.name);
      const ty = this.tyOf(p.type);
      // A payload is plain JSON (PT6.1); maps and payload unions are lowered from plan step 10, as for action parameters.
      if (ty.k === 'map' || ty.k === 'ref' || (ty.k === 'union' && !this.env.unions.get(ty.name)!.isEnum)) this.err('PL0901', p, `an effect parameter of type ${tyToString(ty)} is lowered from plan step 10 of milestone M1`);
      if (p.check) this.err('PL1201', p.check, 'an effect parameter takes its value from the handler; it has no check domain');
    }
    const seen = new Set<string>();
    let labelled = false;
    for (const it of e.items) {
      const key = it.kind === 'EffOutcome' ? it.outcome : it.kind.slice(3).toLowerCase();
      if (seen.has(key)) this.err('PL1002', it, `effect ${e.name} states ${key} twice`);
      seen.add(key);
      switch (it.kind) {
        case 'EffLabels':
          labelled = true;
          for (const l of it.labels) if (!LABELS.has(l)) this.err('PL1001', it, `${l} is not a label of the closed vocabulary (PT6.2)`);
          break;
        case 'EffClass':
          if (!CLASSES.has(it.value)) this.err('PL1001', it, `${it.value} is not an effect class: none, reversible, compensable or irreversible`);
          break;
        case 'EffRetry':
          if (it.attempts < 1) this.err('PL1201', it, 'retry needs at least one attempt');
          for (const d of [it.base, it.timeout]) if (durationMs(d) === null) this.err('PL1201', it, `${d} is not a duration`);
          break;
        case 'EffOutcome':
          this.completion(it, handlers);
          break;
        default:
          break;
      }
    }
    if (!labelled) this.err('PL6301', e, `effect ${e.name} has no labels (PT6.2)`);
  }

  /** `ok -> A(p: v)`: a completion is an ordinary action (PS4.4) whose data the manifest carries as constants (PT6.1). */
  private completion(it: A.EffectItem & { kind: 'EffOutcome' }, handlers: Set<string>): void {
    const act = this.actions.get(it.action);
    if (!act) { this.err('PL1001', it, `${it.outcome} -> ${it.action}: no action ${it.action}`); return; }
    // S40 (provisional): polyrun refuses a manifest whose completion action is outside the lowered action surface (S35).
    if (!handlers.has(it.action)) this.err('PL1001', it, `completion action ${it.action} has no handler, so it is not in the lowered module and the runtime cannot deliver it (S40)`);
    const given = new Set<string>();
    for (const a of it.args) {
      if (a.name === null) { this.err('PL1201', a.value, `a completion names its arguments: ${it.action}(p: value)`); continue; }
      const p = act.params.find((x) => x.name === a.name);
      if (!p) { this.err('PL1001', a.value, `${it.action} has no parameter ${a.name}`); continue; }
      if (given.has(a.name)) this.err('PL1002', a.value, `${a.name} is given twice`);
      given.add(a.name);
      const pt = this.tyOf(p.type);
      const t = this.typeOf(a.value, this.scope('init'), pt);
      if (!same(t, pt)) { this.err('PL1201', a.value, `${it.action}.${a.name} is ${tyToString(pt)}, and the value is ${tyToString(t)}`); continue; }
      if (this.fold(a.value) === undefined) this.err('PL1201', a.value, 'a completion argument is a constant: it is written into the effects manifest (PT6.1)');
      else this.checkConst(a.value, pt, p.check, `${it.action}.${a.name}`);
    }
  }

  private emit(s: A.IntentStmt, scope: Scope): void {
    const e = this.facts!.effects.get(s.target);
    if (!e) {
      this.err('PL1001', s, `${s.target} is not a declared effect`);
      for (const a of s.args) this.typeOf(a.value, scope);
      return;
    }
    const positional = s.args.every((a) => a.name === null);
    if (!positional && !s.args.every((a) => a.name !== null)) {
      this.err('PL1201', s, 'the arguments of an emit are all positional or all named');
      for (const a of s.args) this.typeOf(a.value, scope);
      return;
    }
    if (positional && s.args.length !== e.params.length) {
      this.err('PL1201', s, `${s.target} takes ${e.params.length} argument${e.params.length === 1 ? '' : 's'} (${e.params.map((p) => p.name).join(', ')}), not ${s.args.length}`);
      for (const a of s.args) this.typeOf(a.value, scope);
      return;
    }
    const given = new Set<string>();
    s.args.forEach((a, i) => {
      const p = a.name === null ? e.params[i] : e.params.find((x) => x.name === a.name);
      if (!p) { this.err('PL1001', a.value, `${s.target} has no parameter ${a.name}`); this.typeOf(a.value, scope); return; }
      if (given.has(p.name)) this.err('PL1002', a.value, `${p.name} is given twice`);
      given.add(p.name);
      const pt = this.tyOf(p.type);
      const t = this.typeOf(a.value, scope, pt);
      if (!same(t, pt)) this.err('PL1201', a.value, `${s.target}.${p.name} is ${tyToString(pt)}, and the value is ${tyToString(t)}`);
    });
    const missing = e.params.filter((p) => !given.has(p.name)).map((p) => p.name);
    if (!positional && missing.length) this.err('PL1201', s, `emit ${s.target} is missing ${missing.join(', ')}`);
  }

  /**
   * PS5.4: the compiler accepts only path properties that are prefix-closed by construction. S37
   * (provisional): a conjunction of `count("k") <= n` and `count("k") < n`; `before` waits for its ruling.
   */
  private pathProperty(p: A.Property, kinds: Set<string>): void {
    const conjuncts: A.Expr[] = [];
    const split = (e: A.Expr): void => {
      if (e.kind === 'Binary' && e.op === '&&') { split(e.left); split(e.right); } else conjuncts.push(e);
    };
    split(p.expr);
    for (const c of conjuncts) {
      if (c.kind === 'Call' && c.callee === 'before') { this.err('PL0901', c, 'before(…) waits for the ruling on its meaning (S37)'); continue; }
      const bound = countBound(c);
      if (!bound) { this.err('PL1201', c, 'a path property is a conjunction of count("kind") <= n and count("kind") < n, so that it is prefix-closed (PS5.4, S37)'); continue; }
      if (!kinds.has(bound.kind)) this.err('PL1001', bound.at, `no effect of machine ${this.machine!.name} has kind "${bound.kind}"`);
    }
  }

  /**
   * PT3.4a: a parameter whose value can flow into the payload of an irreversible or compensable effect is
   * strict by default. The flow is read from each handler: a parameter flows when an argument of such an
   * emit reads it, directly or through a `let`. An explicit `disclosed` on an input that flows into an
   * irreversible payload is PL1301, a finding a person must accept (PT12.5).
   */
  private strictFlow(m: A.Machine, facts: MachineFacts): void {
    for (const it of m.items) {
      if (it.kind === 'Action') for (const p of it.params) if (p.check?.mode === 'strict') facts.strictParams.add(`${it.name}.${p.name}`);
    }
    for (const h of m.items) {
      if (h.kind !== 'Handler') continue;
      const act = this.actions.get(h.action);
      if (!act) continue;
      const guarded = new Set<string>();
      const irreversible = new Set<string>();
      const lets = new Map<string, Set<string>>();
      const visit = (body: A.Stmt[]): void => {
        for (const st of body) {
          if (st.kind === 'Let') lets.set(st.name, readsOf(st.expr, lets));
          if (st.kind === 'If') { visit(st.then); visit(st.else ?? []); }
          if (st.kind === 'Match') for (const a of st.arms) visit(a.body);
          if (st.kind !== 'Intent' || st.op !== 'emit') continue;
          const e = facts.effects.get(st.target);
          const cls = e ? effectClass(e) : 'none';
          if (cls !== 'irreversible' && cls !== 'compensable') continue;
          for (const a of st.args) {
            for (const n of readsOf(a.value, lets)) {
              guarded.add(n);
              if (cls === 'irreversible') irreversible.add(n);
            }
          }
        }
      };
      visit(h.body);
      for (const p of act.params) {
        if (!guarded.has(p.name) || !p.check) continue;
        if (p.check.mode === 'disclosed') {
          if (irreversible.has(p.name)) this.errOnce('PL1301', p.check, `${act.name}.${p.name} is disclosed, and it flows into an irreversible effect (PT3.4a)`);
        } else facts.strictParams.add(`${act.name}.${p.name}`);
      }
      for (const f of m.fields) {
        if (f.check?.mode === 'disclosed' && irreversible.has(f.name) && !act.params.some((p) => p.name === f.name)) this.errOnce('PL1301', f.check, `${f.name} is disclosed, and it flows into an irreversible effect (PT3.4a)`);
      }
    }
  }

  private checkDomain(what: string, t: A.TypeExpr, ty: Ty, check: A.CheckClause | null, at: A.NodeBase): void {
    if (check) {
      if (ty.k !== 'int' && ty.k !== 'string') { this.err('PL1201', check, `a check clause applies to int and string, not ${tyToString(ty)}`); return; }
      if (ty.k === 'int' && Number.isFinite(ty.lo)) { this.err('PL1201', check, `${what} has a range type; narrow the range instead of adding a check clause`); return; }
      if (check.domain.kind === 'DomainRange') {
        if (ty.k !== 'int') this.err('PL1201', check, `a range check domain needs an int, and ${what} is ${tyToString(ty)}`);
        if (check.domain.lo > check.domain.hi) this.err('PL1201', check, `empty check domain ${check.domain.lo}..${check.domain.hi}`);
      } else {
        if (check.domain.values.length === 0) this.err('PL1201', check, `empty check domain for ${what}`);
        const vals = check.domain.values.map((v) => (v.kind === 'Int' ? v.value : v.kind === 'String' ? v.value : undefined));
        for (const v of check.domain.values) {
          const ok = (ty.k === 'int' && v.kind === 'Int') || (ty.k === 'string' && v.kind === 'String');
          if (!ok) this.err('PL1201', v, `check domain value does not have type ${tyToString(ty)}`);
        }
        if (new Set(vals).size !== vals.length) this.err('PL1002', check, `check domain of ${what} lists a value twice`);
      }
      return;
    }
    if (ty.k === 'error') return;
    if (cardinality(t, this.env) === null) this.err('PL1101', at, `${what} has type ${tyToString(ty)}, which has no finite check domain; add \`check { … }\` or \`check a..b\` (PT3.2)`);
  }

  // ── initial values ─────────────────────────────────────────────────────
  private checkInit(f: A.Field, ty: Ty): void {
    const got = this.typeOf(f.init, this.scope('init'), ty);
    if (!same(got, ty)) { this.err('PL1201', f.init, `initial value of ${f.name} has type ${tyToString(got)}, not ${tyToString(ty)}`); return; }
    // Review finding 3: the initial state must be in the instance (PS4.2), so every initial value is
    // folded to a constant and checked against its declared type and check domain, part by part.
    this.checkConst(f.init, ty, f.check, f.name);
  }

  /** Folds a constant expression: a number, bool, string or constructor name; undefined when not constant. */
  private fold(e: A.Expr): number | boolean | string | undefined {
    switch (e.kind) {
      case 'Int': case 'Bool': case 'String': return e.value;
      case 'Name': return e.name;
      // S22: `Type.C` folds to the constructor's name, like the bare `C`.
      case 'Member': return e.object.kind === 'Name' && this.env.unions.has(e.object.name) ? e.prop : undefined;
      case 'Unary': {
        const v = this.fold(e.arg);
        if (e.op === '-' && typeof v === 'number') return -v;
        if (e.op === '!' && typeof v === 'boolean') return !v;
        return undefined;
      }
      case 'Binary': {
        const a = this.fold(e.left);
        const b = this.fold(e.right);
        if (typeof a !== 'number' || typeof b !== 'number') return undefined;
        switch (e.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return b === 0 ? undefined : Math.trunc(a / b);
          case '%': return b === 0 ? undefined : a % b;
          default: return undefined;
        }
      }
      default: return undefined;
    }
  }

  /** Reports the first part of a constant that leaves its declared type or check domain, at that part's line. */
  private checkConst(e: A.Expr, ty: Ty, check: A.CheckClause | null, what: string): void {
    if (e.kind === 'CtorExpr' && ty.k === 'union') {
      // S22: `Type.C { … }` names the constructor C.
      const c = this.env.unions.get(ty.name)!.ctors.find((x) => x.name === e.ctor.slice(e.ctor.indexOf('.') + 1));
      for (const f of e.fields) {
        const decl = c?.fields.find((x) => x.name === f.name);
        if (decl) this.checkConst(f.value, this.tyOf(decl.type), null, `${what}.${f.name}`);
      }
      return;
    }
    if (ty.k === 'map' && (e.kind === 'MapLit' || e.kind === 'ArrayLit')) {
      const items = e.kind === 'MapLit' ? e.entries.map((x) => x.value) : e.items;
      items.forEach((x, i) => this.checkConst(x, ty.value, null, `${what}[${i}]`));
      return;
    }
    const v = this.fold(e);
    if (v === undefined) return;
    if (ty.k === 'int' && typeof v === 'number' && (v < ty.lo || v > ty.hi)) {
      this.err('PL1201', e, `initial value ${v} of ${what} is outside its type ${tyToString(ty)}`);
      return;
    }
    if (check) {
      const d = check.domain;
      const inDomain = d.kind === 'DomainRange'
        ? typeof v === 'number' && v >= d.lo && v <= d.hi
        : d.values.some((x) => (x.kind === 'Name' ? x.name : x.value) === v);
      if (!inDomain) this.err('PL1201', e, `initial value ${JSON.stringify(v)} of ${what} is outside its check domain (PS4.2)`);
    }
  }

  // ── handlers ───────────────────────────────────────────────────────────
  private checkHandler(h: A.Handler, act: A.Action): void {
    const declared = act.params.map((p) => p.name);
    if (h.params && (h.params.length !== declared.length || h.params.some((p, i) => p !== declared[i]))) {
      this.err('PL1201', h, `on ${h.action}(${h.params.join(', ')}) must repeat the declared parameters (${declared.join(', ')}) in order (PT2.4a)`);
    }
    const scope = this.scope('handler');
    for (const p of act.params) scope.params.set(p.name, this.tyOf(p.type));
    this.stmts(h.body, scope);
    // Per-path rules (PT4.1, PS2.4, PT4.4).
    const ends = this.paths(h.body, [{ written: new Map(), done: false, emits: false }]);
    for (const e of ends) {
      if (!e.done && e.written.size === 0 && !e.emits) {
        this.err('PL2201', h, `on ${h.action} can complete with no write, no effect and no rejection (PT4.4)`);
        break;
      }
    }
  }

  private stmts(body: A.Stmt[], scope: Scope): void {
    const local: Scope = { ...scope, locals: new Map(scope.locals) };
    for (const s of body) this.stmt(s, local);
  }

  private stmt(s: A.Stmt, scope: Scope): void {
    const fields = this.facts!.fieldTypes;
    switch (s.kind) {
      case 'Require':
        this.expectBool(s.cond, scope);
        break;
      case 'Reject':
        break;
      case 'Let': {
        if (scope.locals.has(s.name) || scope.params.has(s.name) || fields.has(s.name)) this.err('PL1002', s, `${s.name} is already a name here`);
        const ty = this.typeOf(s.expr, scope);
        scope.locals.set(s.name, { ty, res: { k: 'let', name: s.name } });
        break;
      }
      case 'Assign': {
        const ft = fields.get(s.field);
        if (!ft) { this.err('PL1001', s, `${s.field} is not a declared field (PF1.1)`); this.typeOf(s.expr, scope); break; }
        const got = this.typeOf(s.expr, scope, ft);
        if (!same(got, ft)) this.err('PL1201', s.expr, `${s.field}' is ${tyToString(ft)}, and the value is ${tyToString(got)}`);
        break;
      }
      case 'MapUpdate': {
        const ft = fields.get(s.field);
        if (!ft) { this.err('PL1001', s, `${s.field} is not a declared field (PF1.1)`); break; }
        if (s.base !== s.field) this.err('PL1201', s, `a map update writes one entry of the same field: ${s.field}' = ${s.field} with [k] = v`);
        if (ft.k !== 'map') { this.err('PL1201', s, `${s.field} is not a map`); break; }
        const kt = this.typeOf(s.key, scope, ft.key);
        if (!same(kt, ft.key)) this.err('PL1201', s.key, `key has type ${tyToString(kt)}, the map's keys are ${tyToString(ft.key)}`);
        const vt = this.typeOf(s.value, scope, ft.value);
        if (!same(vt, ft.value)) this.err('PL1201', s.value, `value has type ${tyToString(vt)}, the map's values are ${tyToString(ft.value)}`);
        break;
      }
      case 'If':
        this.expectBool(s.cond, scope);
        this.stmts(s.then, scope);
        if (s.else) this.stmts(s.else, scope);
        break;
      case 'Match':
        this.match(s, scope);
        break;
      case 'Intent':
        if (s.op === 'emit') this.emit(s, scope);
        else this.err('PL0901', s, `\`${s.op}\` is lowered from plan step ${s.op === 'send' || (s.op === 'spawn' && s.modifier === 'detached') ? 8 : 6} of milestone M1`);
        break;
    }
  }

  private match(s: A.Match, scope: Scope): void {
    const st = this.typeOf(s.scrutinee, scope);
    if (st.k !== 'union') {
      if (st.k !== 'error') this.err('PL1201', s.scrutinee, `match needs a union value, not ${tyToString(st)}`);
      for (const arm of s.arms) this.stmts(arm.body, scope);
      return;
    }
    const u = this.env.unions.get(st.name)!;
    // The constraints each arm places on its constructor's payload, for coverage below.
    const constraints: ({ ctor: string; lits: Map<string, unknown> } | null)[] = [];
    for (const arm of s.arms) {
      const armScope: Scope = { ...scope, locals: new Map(scope.locals) };
      const marks: { name: string; mark: { used: boolean } }[] = [];
      let constraint: { ctor: string; lits: Map<string, unknown> } | null = null;
      if (arm.pattern.kind === 'PCtor') {
        const pat = arm.pattern;
        // S22: a qualified pattern must name the scrutinee's own type.
        const dot = pat.ctor.indexOf('.');
        const c = dot >= 0 && pat.ctor.slice(0, dot) !== u.name ? undefined : u.ctors.find((x) => x.name === pat.ctor.slice(dot + 1));
        if (!c) { this.err('PL1201', pat, `${pat.ctor} is not a constructor of ${u.name}`); constraints.push({ ctor: '', lits: new Map() }); continue; }
        constraint = { ctor: c.name, lits: new Map() };
        for (const pf of pat.fields) {
          const decl = c.fields.find((x) => x.name === pf.name);
          if (!decl) { this.err('PL1001', pat, `${c.name} has no payload ${pf.name}`); continue; }
          const ty = this.tyOf(decl.type);
          if (pf.bind === '_') continue; // S21: `_` ignores the payload
          if (pf.bind) {
            // S21: (1) a constructor of the payload's type is a literal pattern;
            // (2) a constructor of another type is a type error; (3) any other name binds.
            const named = ty.k === 'union' ? this.env.unions.get(ty.name)!.ctors.find((x) => x.name === pf.bind) : undefined;
            if (named && named.fields.length) {
              // A bare name stands for one value; a constructor with a payload has many, and patterns do not nest.
              this.err('PL1201', pat, `${pf.bind} carries a payload, so a bare ${pf.bind} cannot match ${c.name}.${pf.name}; bind it and test it with \`is\` (S21)`);
              continue;
            }
            if (named) {
              this.facts!.patternLiterals.set(`${arm.id}:${pf.name}`, pf.bind);
              constraint.lits.set(pf.name, pf.bind);
              continue;
            }
            if (this.env.ctorOwners.has(pf.bind)) {
              this.err('PL1201', pat, `${pf.bind} is a constructor of ${this.env.ctorOwners.get(pf.bind)!.join(', ')}, not of ${tyToString(ty)}, the type of ${c.name}.${pf.name}; it cannot be a binder (S21)`);
              continue;
            }
            if (armScope.locals.has(pf.bind) || scope.params.has(pf.bind) || this.facts!.fieldTypes.has(pf.bind)) this.err('PL1002', pat, `${pf.bind} is already a name here`);
            const mark = { used: false };
            marks.push({ name: pf.bind, mark });
            armScope.locals.set(pf.bind, { ty, res: { k: 'bind', name: pf.bind }, mark });
          } else if (pf.literal) {
            const lt = this.typeOf(pf.literal, armScope, ty);
            if (!same(lt, ty)) this.err('PL1201', pf.literal, `pattern literal for ${c.name}.${pf.name} is not a ${tyToString(ty)}`);
            constraint.lits.set(pf.name, pf.literal.kind === 'Name' ? pf.literal.name : pf.literal.value);
          }
        }
      }
      constraints.push(constraint);
      this.stmts(arm.body, armScope);
      // S21 (4): a binder its arm never reads is an error; `_` says so on purpose.
      for (const { name, mark } of marks) if (!mark.used) this.err('PL1504', arm.pattern, `${name} is bound and never read; write \`_\` to ignore the payload (a misspelled constructor binds too)`);
    }
    this.coverage(u, s, constraints);
  }

  /**
   * S21 (5) and PS2.2: every value of the union is covered by some arm (PL1501), and no arm is
   * covered by the arms before it (PL1503). Coverage is decided by enumerating the payload values
   * the arms' literals constrain, which are finite (PT3.2).
   */
  private coverage(u: UnionInfo, s: A.Match, constraints: ({ ctor: string; lits: Map<string, unknown> } | null)[]): void {
    const values: { ctor: string; rec: Map<string, unknown> }[] = [];
    const litFields = new Map<string, string[]>();
    for (const c of u.ctors) {
      const names = [...new Set(constraints.filter((k) => k && k.ctor === c.name).flatMap((k) => [...k!.lits.keys()]))];
      litFields.set(c.name, names);
      const domains = names.map((n) => this.values(c.fields.find((f) => f.name === n)!.type));
      if (domains.some((d) => d === null)) { values.push({ ctor: c.name, rec: new Map() }); continue; }
      let recs: Map<string, unknown>[] = [new Map()];
      names.forEach((n, i) => { recs = recs.flatMap((r) => domains[i]!.map((v) => new Map([...r, [n, v]]))); });
      for (const rec of recs) values.push({ ctor: c.name, rec });
    }
    const matches = (k: { ctor: string; lits: Map<string, unknown> } | null, v: { ctor: string; rec: Map<string, unknown> }) =>
      k === null || (k.ctor === v.ctor && [...k.lits].every(([n, lit]) => !v.rec.has(n) || v.rec.get(n) === lit));
    const covered = new Set<number>();
    s.arms.forEach((arm, i) => {
      const k = constraints[i];
      if (k && k.ctor === '') return; // an unknown constructor, already reported
      const mine = values.map((v, j) => (matches(k, v) ? j : -1)).filter((j) => j >= 0);
      if (mine.length && mine.every((j) => covered.has(j))) this.err('PL1503', arm, `this arm can never run: the arms before it cover every value it matches (S21)`);
      for (const j of mine) covered.add(j);
    });
    const missing = values.filter((_, j) => !covered.has(j)).map((v) => (v.rec.size ? `${v.ctor} { ${[...v.rec].map(([n, x]) => `${n}: ${String(x)}`).join(', ')} }` : v.ctor));
    if (missing.length) this.err('PL1501', s, `match on ${u.name} does not cover ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''}; add the arms or a \`_\` arm`);
  }

  private values(t: A.TypeExpr): unknown[] | null {
    if (t.kind === 'TBool') return [false, true];
    if (t.kind === 'TRange') return Array.from({ length: t.hi - t.lo + 1 }, (_, k) => t.lo + k);
    if (t.kind === 'TName') {
      const u = this.env.unions.get(t.name);
      return u && u.isEnum ? u.ctors.map((c) => c.name) : null;
    }
    return null;
  }

  // ── per-path analysis (PT4.1, PS2.4) ────────────────────────────────────
  private paths(body: A.Stmt[], starts: PathState[]): PathState[] {
    let cur = starts;
    for (const s of body) {
      const next: PathState[] = [];
      for (const p of cur) {
        if (p.done) { next.push(p); continue; }
        next.push(...this.pathStmt(s, p));
      }
      cur = next;
    }
    return cur;
  }

  private pathStmt(s: A.Stmt, p: PathState): PathState[] {
    switch (s.kind) {
      case 'Require':
      case 'Reject': {
        if (p.written.size) {
          const [f, w] = [...p.written][0];
          this.errOnce('PL2101', s, `${s.kind === 'Require' ? 'require' : 'reject'} after the write of ${f}' on the same path (written at line ${w.span?.line ?? '?'}); requires come before writes (PT4.1)`);
        }
        return s.kind === 'Reject' ? [{ ...p, done: true }] : [p];
      }
      case 'Assign':
      case 'MapUpdate': {
        const prev = p.written.get(s.field);
        if (prev) this.errOnce('PL2102', s, `${s.field}' is written twice on one path (first at line ${prev.span?.line ?? '?'}) (PS2.4)`);
        const written = new Map(p.written);
        written.set(s.field, s);
        return [{ ...p, written }];
      }
      case 'If':
        return [...this.paths(s.then, [p]), ...this.paths(s.else ?? [], [p])];
      case 'Match':
        return s.arms.flatMap((a) => this.paths(a.body, [p]));
      case 'Intent':
        return [{ ...p, emits: true }];
      default:
        return [p];
    }
  }

  private reported = new Set<string>();
  private errOnce(code: string, n: A.NodeBase, msg: string): void {
    const key = code + n.id;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.err(code, n, msg);
  }

  // ── expressions ─────────────────────────────────────────────────────────
  private scope(ctx: Ctx): Scope {
    return { ctx, locals: new Map(), params: new Map(), knownAction: null };
  }

  private expectBool(e: A.Expr, scope: Scope): void {
    const t = this.typeOf(e, scope, BOOL);
    if (t.k !== 'bool' && t.k !== 'error') this.err('PL1201', e, `expected a Bool condition, found ${tyToString(t)}`);
  }

  private record(e: A.Expr, t: Ty): Ty {
    this.facts?.types.set(e.id, t);
    return t;
  }

  private resolve(e: A.NodeBase, r: Resolution): void {
    this.facts?.resolutions.set(e.id, r);
  }

  /** The type of an expression. `expected` only disambiguates constructors shared by two unions. */
  typeOf(e: A.Expr, scope: Scope, expected?: Ty): Ty {
    return this.record(e, this.typeOfInner(e, scope, expected));
  }

  private ctorType(name: string, expected: Ty | undefined, at: A.NodeBase): { union: string; info: UnionInfo } | null {
    // S22: `Type.C` names its type; an unqualified name resolves against the expected type.
    const dot = name.indexOf('.');
    if (dot >= 0) {
      const union = name.slice(0, dot);
      const info = this.env.unions.get(union);
      if (!info || !info.ctors.some((c) => c.name === name.slice(dot + 1))) { this.err('PL1001', at, `${name}: ${info ? `${union} has no constructor ${name.slice(dot + 1)}` : `unknown type ${union}`}`); return null; }
      return { union, info };
    }
    const owners = this.env.ctorOwners.get(name) ?? [];
    let union: string | undefined;
    if (expected?.k === 'union' && owners.includes(expected.name)) union = expected.name;
    else if (owners.length === 1) union = owners[0];
    else if (owners.length > 1) { this.err('PL1005', at, `${name} is a constructor of ${owners.join(' and ')}; write ${owners.map((o) => `${o}.${name}`).join(' or ')} (S22)`); return null; }
    if (!union) return null;
    return { union, info: this.env.unions.get(union)! };
  }

  /** S22: an unqualified constructor name that more than one type declares, not hidden by a local, parameter or field. */
  private ambiguousCtor(e: A.Expr, scope: Scope): boolean {
    const name = e.kind === 'Name' ? e.name : e.kind === 'CtorExpr' && !e.ctor.includes('.') ? e.ctor : null;
    if (!name || scope.locals.has(name) || scope.params.has(name) || this.facts?.fieldTypes.has(name)) return false;
    return (this.env.ctorOwners.get(name)?.length ?? 0) > 1;
  }

  private typeOfInner(e: A.Expr, scope: Scope, expected?: Ty): Ty {
    const fields = this.facts?.fieldTypes ?? new Map<string, Ty>();
    switch (e.kind) {
      case 'Int': return { k: 'int', lo: e.value, hi: e.value };
      case 'Bool': return BOOL;
      case 'String': return { k: 'string' };
      case 'Primed':
        this.err('PL1202', e, `${e.name}' is write-only; expressions read the pre-state (PS2.3)`);
        return ERR;
      case 'Name': {
        const n = e.name;
        const local = scope.locals.get(n);
        if (local) { if (local.mark) local.mark.used = true; this.resolve(e, local.res); return local.ty; }
        if (scope.params.has(n)) { this.resolve(e, { k: 'param', name: n }); return scope.params.get(n)!; }
        if (fields.has(n) && scope.ctx !== 'init' && scope.ctx !== 'step') {
          this.resolve(e, { k: 'field', name: n });
          scope.reads?.add(n);
          return fields.get(n)!;
        }
        if (n === 'action' && (scope.ctx === 'step' || scope.ctx === 'reject' || scope.ctx === 'guard')) { this.resolve(e, { k: 'actionVar' }); return { k: 'action' }; }
        if (expected?.k === 'action' && this.actions.has(n)) { this.resolve(e, { k: 'action', name: n }); return { k: 'action' }; }
        if (n === 'none') { this.resolve(e, { k: 'none' }); return { k: 'ref' }; }
        const c = this.ctorType(n, expected, e);
        if (c) {
          const ci = c.info.ctors.find((x) => x.name === n)!;
          if (ci.fields.length) this.err('PL1201', e, `${n} carries a payload; write ${n} { … }`);
          this.resolve(e, { k: 'ctor', union: c.union, ctor: n });
          return { k: 'union', name: c.union };
        }
        // A constructor of several types was reported ambiguous (PL1005): it is not also an unknown name.
        if ((this.env.ctorOwners.get(n)?.length ?? 0) > 1) return ERR;
        if (this.actions.has(n) && (scope.ctx === 'step' || scope.ctx === 'reject' || scope.ctx === 'guard')) { this.resolve(e, { k: 'action', name: n }); return { k: 'action' }; }
        if (fields.has(n) && scope.ctx === 'step') { this.err('PL1201', e, `a step property reads pre.${n} or post.${n}, not ${n} (PT5)`); return ERR; }
        if ((scope.ctx === 'step' || scope.ctx === 'reject' || scope.ctx === 'guard') && this.isParamOfSomeAction(n)) {
          this.err('PL1201', e, `parameter ${n} is read where no \`action == A\` establishes an action that declares it (PT5, S15)`);
          return ERR;
        }
        this.err('PL1001', e, `unknown name ${n}`);
        return ERR;
      }
      case 'Member': {
        // S22: `Type.C`, a constructor without payload named with its type.
        if (e.object.kind === 'Name' && this.env.unions.has(e.object.name) && !scope.locals.has(e.object.name) && !scope.params.has(e.object.name) && !fields.has(e.object.name)) {
          const c = this.ctorType(`${e.object.name}.${e.prop}`, expected, e);
          if (!c) return ERR;
          if (c.info.ctors.find((x) => x.name === e.prop)!.fields.length) this.err('PL1201', e, `${e.object.name}.${e.prop} carries a payload; write ${e.object.name}.${e.prop} { … }`);
          this.resolve(e, { k: 'ctor', union: c.union, ctor: e.prop });
          return { k: 'union', name: c.union };
        }
        // S19: in a handler, pre.f names the pre-state field f even where a parameter f shadows it. in a handler, pre.f names the pre-state field f even where a parameter f shadows it.
        const handlerPre = scope.ctx === 'handler' && e.object.kind === 'Name' && e.object.name === 'pre' && !scope.locals.has('pre') && !scope.params.has('pre');
        if (handlerPre || (e.object.kind === 'Name' && (e.object.name === 'pre' || e.object.name === 'post') && (scope.ctx === 'step' || scope.ctx === 'reject'))) {
          const obj = e.object as A.NameRef;
          if (obj.name === 'post' && scope.ctx === 'reject') { this.err('PL1201', e, 'a reject property reads the state a step starts from: pre.f, not post.f (PT5)'); return ERR; }
          this.resolve(obj, obj.name === 'pre' ? { k: 'pre' } : { k: 'post' });
          const t = fields.get(e.prop);
          if (!t) { this.err('PL1001', e, `unknown field ${e.prop}`); return ERR; }
          return t;
        }
        this.err('PL1201', e, `field access .${e.prop} is only pre.f or post.f, in step and reject properties, and pre.f in handlers`);
        return ERR;
      }
      case 'Index': {
        const mt = this.typeOf(e.object, scope);
        if (mt.k !== 'map') { if (mt.k !== 'error') this.err('PL1201', e, `indexing needs a map, not ${tyToString(mt)}`); this.typeOf(e.index, scope); return ERR; }
        const kt = this.typeOf(e.index, scope, mt.key);
        if (!same(kt, mt.key)) this.err('PL1201', e.index, `key has type ${tyToString(kt)}, the map's keys are ${tyToString(mt.key)}`);
        return mt.value;
      }
      case 'Call': {
        if (e.callee === 'rejected' && scope.ctx === 'reject') {
          if (e.args.length !== 1 || e.args[0].kind !== 'String') { this.err('PL1201', e, 'rejected takes one reason string: rejected("reason")'); return ERR; }
          this.record(e.args[0], { k: 'string' });
          return BOOL;
        }
        if (e.callee === 'count' || e.callee === 'before') { this.err('PL1201', e, `${e.callee}(…) is read only in a path property (PS5.4)`); return ERR; }
        this.err('PL1001', e, `unknown function ${e.callee}; expressions call no functions (PT2.2)`);
        return ERR;
      }
      case 'Unary': {
        if (e.op === '!') { this.expectBool(e.arg, scope); return BOOL; }
        const t = this.typeOf(e.arg, scope);
        if (t.k !== 'int') { if (t.k !== 'error') this.err('PL1201', e, `unary - needs an int, not ${tyToString(t)}`); return ERR; }
        return { k: 'int', lo: -t.hi, hi: -t.lo };
      }
      case 'Binary': return this.binary(e, scope);
      case 'Is': {
        const t = this.typeOf(e.expr, scope);
        if (t.k !== 'union') { if (t.k !== 'error') this.err('PL1201', e, `\`is\` needs a union value, not ${tyToString(t)}`); return BOOL; }
        const u = this.env.unions.get(t.name)!;
        for (const c of e.ctors) if (!u.ctors.some((x) => x.name === c)) this.err('PL1201', e, `${c} is not a constructor of ${u.name}`);
        return BOOL;
      }
      case 'In': {
        const t = this.typeOf(e.expr, scope);
        for (const x of e.set) {
          const xt = this.typeOf(x, scope, t);
          if (!same(xt, t)) this.err('PL1201', x, `set member has type ${tyToString(xt)}, not ${tyToString(t)}`);
        }
        return BOOL;
      }
      case 'CtorExpr': {
        const c = this.ctorType(e.ctor, expected, e);
        if (!c) { this.err('PL1001', e, `unknown constructor ${e.ctor}`); return ERR; }
        const ci = c.info.ctors.find((x) => x.name === e.ctor.slice(e.ctor.indexOf('.') + 1))!;
        const given = e.fields.map((f) => f.name);
        for (const f of ci.fields) if (!given.includes(f.name)) this.err('PL1201', e, `${e.ctor} needs its payload ${f.name}`);
        for (const f of e.fields) {
          const decl = ci.fields.find((x) => x.name === f.name);
          if (!decl) { this.err('PL1001', e, `${e.ctor} has no payload ${f.name}`); continue; }
          const dt = this.tyOf(decl.type);
          const vt = this.typeOf(f.value, scope, dt);
          if (!same(vt, dt)) this.err('PL1201', f.value, `${e.ctor}.${f.name} is ${tyToString(dt)}, the value is ${tyToString(vt)}`);
        }
        if (given.some((n, i) => given.indexOf(n) !== i)) this.err('PL1002', e, `a payload is given twice in ${e.ctor} { … }`);
        return { k: 'union', name: c.union };
      }
      case 'MapLit': {
        if (expected?.k !== 'map') { this.err('PL1201', e, 'a map literal needs a map type from its context'); return ERR; }
        const keys = this.keyValues(expected.key);
        const seen: unknown[] = [];
        // One mistake, one diagnostic (M1-4): a key of the wrong type is reported once, and coverage is
        // judged only when every key given is a key of the map, so a wrong key does not also read as a missing one.
        let everyKeyValid = true;
        for (const en of e.entries) {
          const kt = this.typeOf(en.key, scope, expected.key);
          const kv = this.fold(en.key);
          if (kt.k === 'error') {
            // The key's own mistake is already reported (an unknown name, say); it is not reported again as a wrong key.
            everyKeyValid = false;
          } else if (!same(kt, expected.key)) {
            this.err('PL1201', en.key, `key has type ${tyToString(kt)}, the map's keys are ${tyToString(expected.key)}`);
            everyKeyValid = false;
          } else if (keys && kv !== undefined && !keys.includes(kv)) {
            // A key outside the map's key type is not a key of this map (ranges type alike, so check the value).
            this.err('PL1201', en.key, `${String(kv)} is not a key of ${tyToString(expected)}`);
            everyKeyValid = false;
          } else if (kv === undefined) {
            // PT2.2 asks for every key exactly once, which is decidable only for constant keys (pre.k is not one).
            this.err('PL1502', en.key, 'a map-literal key is not a constant, so the literal cannot be checked to list every key once (PT2.2)');
            everyKeyValid = false;
          }
          if (kv !== undefined) {
            if (seen.includes(kv)) this.err('PL1502', en.key, `key ${String(kv)} is listed twice`);
            seen.push(kv);
          }
          const vt = this.typeOf(en.value, scope, expected.value);
          if (!same(vt, expected.value)) this.err('PL1201', en.value, `value has type ${tyToString(vt)}, the map's values are ${tyToString(expected.value)}`);
        }
        if (keys && everyKeyValid) {
          const missing = keys.filter((k) => !seen.includes(k));
          if (missing.length) this.err('PL1502', e, `a map literal lists every key; missing ${missing.join(', ')} (PT2.2)`);
        }
        return expected;
      }
      case 'ArrayLit': {
        if (expected?.k !== 'map' || !expected.array) { this.err('PL1201', e, 'an array literal is the value of a map keyed by 0..n'); return ERR; }
        const key = expected.key as { lo: number; hi: number };
        const n = key.hi - key.lo + 1;
        if (e.items.length !== n) this.err('PL1502', e, `an array literal for keys ${key.lo}..${key.hi} lists ${n} values, not ${e.items.length}`);
        for (const x of e.items) {
          const vt = this.typeOf(x, scope, expected.value);
          if (!same(vt, expected.value)) this.err('PL1201', x, `value has type ${tyToString(vt)}, the map's values are ${tyToString(expected.value)}`);
        }
        return expected;
      }
    }
  }

  private isParamOfSomeAction(n: string): boolean {
    for (const a of this.actions.values()) if (a.params.some((p) => p.name === n)) return true;
    return false;
  }

  private keyValues(t: Ty): unknown[] | null {
    if (t.k === 'int') return Array.from({ length: t.hi - t.lo + 1 }, (_, k) => t.lo + k);
    if (t.k === 'union') return this.env.unions.get(t.name)!.ctors.map((c) => c.name);
    return null;
  }

  private binary(e: A.Binary, scope: Scope): Ty {
    switch (e.op) {
      case '&&':
      case '||':
      case 'implies': {
        this.expectBool(e.left, scope);
        // S15: `action == A` on the left establishes A's parameters on the right.
        const known = e.op !== '||' ? this.establishedAction(e.left) : null;
        const right: Scope = known ? { ...scope, knownAction: known, params: this.paramsOf(known, scope) } : scope;
        this.expectBool(e.right, right);
        return BOOL;
      }
      case '==':
      case '!=': {
        // S22: each side is typed first; an ambiguous constructor on either side takes the other side's type.
        let l: Ty;
        let r: Ty;
        if (this.ambiguousCtor(e.left, scope) && !this.ambiguousCtor(e.right, scope)) {
          r = this.typeOf(e.right, scope);
          l = this.typeOf(e.left, scope, r);
        } else {
          l = this.typeOf(e.left, scope);
          r = this.typeOf(e.right, scope, l);
        }
        if (!same(l, r)) this.err('PL1201', e, `cannot compare ${tyToString(l)} with ${tyToString(r)}`);
        return BOOL;
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const l = this.typeOf(e.left, scope);
        const r = this.typeOf(e.right, scope);
        if ((l.k !== 'int' && l.k !== 'error') || (r.k !== 'int' && r.k !== 'error')) this.err('PL1201', e, `${e.op} compares ints, not ${tyToString(l)} and ${tyToString(r)}`);
        return BOOL;
      }
      default: {
        const l = this.typeOf(e.left, scope);
        const r = this.typeOf(e.right, scope);
        if (l.k !== 'int' || r.k !== 'int') {
          if (l.k !== 'error' && r.k !== 'error') this.err('PL1201', e, `${e.op} needs ints, not ${tyToString(l)} and ${tyToString(r)}`);
          return ERR;
        }
        return this.arith(e, l, r);
      }
    }
  }

  private arith(e: A.Binary, l: { lo: number; hi: number }, r: { lo: number; hi: number }): Ty {
    const range = (xs: number[]): Ty => {
      const ok = xs.filter((x) => !Number.isNaN(x));
      return { k: 'int', lo: Math.min(...ok), hi: Math.max(...ok) };
    };
    switch (e.op) {
      case '+': return { k: 'int', lo: l.lo + r.lo, hi: l.hi + r.hi };
      case '-': return { k: 'int', lo: l.lo - r.hi, hi: l.hi - r.lo };
      case '*': return range([l.lo * r.lo, l.lo * r.hi, l.hi * r.lo, l.hi * r.hi]);
      case '/':
      case '%': {
        // S12: a divisor whose static range contains 0 is refused, so division is total.
        if (r.lo <= 0 && r.hi >= 0) { this.err('PL1204', e.right, `the divisor may be 0 (its range is ${tyToString({ k: 'int', ...r })}); division must be total (PT2.2)`); return ERR; }
        if (e.op === '%') { const m = Math.max(Math.abs(r.lo), Math.abs(r.hi)) - 1; return { k: 'int', lo: l.lo < 0 ? -m : 0, hi: l.hi > 0 ? m : 0 }; }
        const q = [l.lo / r.lo, l.lo / r.hi, l.hi / r.lo, l.hi / r.hi].map(Math.trunc);
        return range(q);
      }
      default: return INT;
    }
  }

  private establishedAction(e: A.Expr): string | null {
    // `action == A` or `A == action` (S19: parameters are visible where the action is known).
    if (e.kind === 'Binary' && e.op === '==' && e.left.kind === 'Name' && e.left.name === 'action' && e.right.kind === 'Name' && this.actions.has(e.right.name)) return e.right.name;
    if (e.kind === 'Binary' && e.op === '==' && e.right.kind === 'Name' && e.right.name === 'action' && e.left.kind === 'Name' && this.actions.has(e.left.name)) return e.left.name;
    if (e.kind === 'Binary' && e.op === '&&') return this.establishedAction(e.left) ?? this.establishedAction(e.right);
    return null;
  }

  private paramsOf(action: string, scope: Scope): Map<string, Ty> {
    const params = new Map(scope.params);
    for (const p of this.actions.get(action)?.params ?? []) params.set(p.name, this.tyOf(p.type));
    return params;
  }
}

// PT6.2: the closed Polyaxion vocabulary.
const LABELS = new Set(['read:repo', 'read:private', 'read:store', 'read:web', 'write:store', 'write:repo', 'write:workspace', 'egress:public', 'egress:external', 'exec', 'admin']);
const CLASSES = new Set(['none', 'reversible', 'compensable', 'irreversible']);

/** S41 (provisional): an effect with no `kind` has its name as its kind. */
export function effectKind(e: A.EffectDecl): string {
  for (const it of e.items) if (it.kind === 'EffKind') return it.value;
  return e.name;
}

/** An effect with no `class` is class `none` (PT2, `Class`). */
export function effectClass(e: A.EffectDecl): string {
  for (const it of e.items) if (it.kind === 'EffClass') return it.value;
  return 'none';
}

/** A duration literal in milliseconds: 200ms, 5s, 2m, 1h. */
export function durationMs(text: string): number | null {
  const m = /^(\d+)(ms|s|m|h)$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 'ms' | 's' | 'm' | 'h'];
}

/** `count("k") <= n` or `count("k") < n`, either way round: the kind and the largest count allowed. */
export function countBound(e: A.Expr): { kind: string; max: number; at: A.NodeBase } | null {
  if (e.kind !== 'Binary') return null;
  const isCount = (x: A.Expr): x is A.Call => x.kind === 'Call' && x.callee === 'count' && x.args.length === 1 && x.args[0].kind === 'String';
  const lit = (x: A.Expr) => (x.kind === 'Int' && x.value >= 0 ? x.value : null);
  let call: A.Call;
  let n: number | null;
  let op: string;
  if (isCount(e.left)) { call = e.left; n = lit(e.right); op = e.op; }
  else if (isCount(e.right)) { call = e.right; n = lit(e.left); op = ({ '>=': '<=', '>': '<' } as Record<string, string>)[e.op] ?? ''; }
  else return null;
  if (n === null || (op !== '<=' && op !== '<')) return null;
  const max = op === '<=' ? n : n - 1;
  if (max < 0) return null;
  const arg = call.args[0] as A.StringLit;
  return { kind: arg.value, max, at: arg };
}

/** The names an expression reads, with each `let` name replaced by the names it reads. */
function readsOf(e: A.Expr, lets: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  const walk = (x: unknown): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const n = x as { kind?: string; name?: string };
    if (n.kind === 'Name' && n.name) {
      const via = lets.get(n.name);
      if (via) for (const v of via) out.add(v);
      else out.add(n.name);
    }
    for (const [k, v] of Object.entries(x)) if (k !== 'span') walk(v);
  };
  walk(e);
  return out;
}

interface PathState {
  written: Map<string, A.NodeBase>;
  done: boolean;
  /** An intent was appended to E on this path (PS2.1). */
  emits: boolean;
}
