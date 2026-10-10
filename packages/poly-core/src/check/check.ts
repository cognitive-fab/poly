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
import { digest } from '../digest.js';
import { RESERVED_MODULE, RUNTIME_MODEL_DIGESTS } from '../reserved.js';
import { profileProblem, underBase, type ProviderEntry, type ProviderProfile } from '../credentials.js';
import { priceTableProblem, reservationOf, type PriceTable } from '../money.js';
import { mapProblem, routePathOk, routedDecisions, type CalibrationFile, type RoutingFiles } from '../routing.js';

// ── semantic types ─────────────────────────────────────────────────────────

export type Ty =
  | { k: 'bool' }
  | { k: 'int'; lo: number; hi: number }
  | { k: 'string' }
  | { k: 'union'; name: string }
  /** A record type (S25): nominal, every field present. */
  | { k: 'record'; name: string }
  | { k: 'map'; key: Ty; value: Ty; array: boolean }
  /** `Ref<M>` (PS1.6): an address of an instance of machine M of this module; `none` has machine null. */
  | { k: 'ref'; machine: string | null }
  | { k: 'action' }
  /** `Conf` (PD1.3): a confidence, and the type of a decimal literal (S76). */
  | { k: 'conf' }
  /** `Principal` (PD5.1.2b): an opaque identity, or `none`. */
  | { k: 'principal' }
  /** `Content` (PS1.4a, S180): an opaque reference to a body by its digest, or `none`. */
  | { k: 'content' }
  /** `Key` (PS1.4c, S451): an opaque name of a source's items by one of its keys, or `none`. */
  | { k: 'key' }
  /** `Items` (PS1.4b, S303): an opaque reference to retrieved items, of which a module reads only the count. */
  | { k: 'items' }
  | { k: 'error' };

const BOOL: Ty = { k: 'bool' };
const INT: Ty = { k: 'int', lo: -Infinity, hi: Infinity };
const ERR: Ty = { k: 'error' };
/** The reasons the runtime gives (PS3.2, S101, S127), which a module may not use (PL1207). */
export const RESERVED_REASONS: readonly string[] = ['terminal', 'outside-check-domain', 'poisoned', 'archived', 'claims-unverified', 'content-missing', 'unknown-thread', 'thread-not-started', 'creation-unavailable', 'uncited', 'route-exhausted'];

export function tyToString(t: Ty): string {
  switch (t.k) {
    case 'int': return Number.isFinite(t.lo) && Number.isFinite(t.hi) ? `${t.lo}..${t.hi}` : 'int';
    case 'union': return t.name;
    case 'record': return t.name;
    case 'map': return `map<${tyToString(t.key)}, ${tyToString(t.value)}>`;
    case 'ref': return t.machine === null ? 'none' : `Ref<${t.machine}>`;
    case 'content': return 'Content';
    case 'key': return 'Key';
    case 'items': return 'Items';
    default: return t.k;
  }
}

/** Review C-F5, PS1.4a: a Content where another type is expected, or the reverse, is PL1209; any other mismatch PL1201. */
function opaqueCode(a: Ty, b: Ty): 'PL1209' | 'PL1201' {
  // PS1.4b: an Items is opaque as a Content is; PS1.4c: and so is a Key.
  const opaque = (t: Ty) => t.k === 'content' || t.k === 'items' || t.k === 'key';
  return opaque(a) !== opaque(b) && a.k !== 'error' && b.k !== 'error' ? 'PL1209' : 'PL1201';
}

function same(a: Ty, b: Ty): boolean {
  if (a.k === 'error' || b.k === 'error') return true;
  // PD1.3b: a Conf where it does not belong is PL1205, reported once by confUses, not also a type mismatch.
  if (a.k === 'conf' || b.k === 'conf') return true;
  // PD5.1.2b: `none` is also the absent principal.
  if ((a.k === 'principal' && b.k === 'ref' && b.machine === null) || (b.k === 'principal' && a.k === 'ref' && a.machine === null)) return true;
  // PS1.4a: and the absent body.
  if ((a.k === 'content' && b.k === 'ref' && b.machine === null) || (b.k === 'content' && a.k === 'ref' && a.machine === null)) return true;
  // PS1.4c: and the absent key.
  if ((a.k === 'key' && b.k === 'ref' && b.machine === null) || (b.k === 'key' && a.k === 'ref' && a.machine === null)) return true;
  if (a.k !== b.k) return false;
  if (a.k === 'union' || a.k === 'record') return a.name === (b as { name: string }).name;
  // `none` is an address of every machine (PS1.6).
  if (a.k === 'ref') { const m = (b as { machine: string | null }).machine; return a.machine === null || m === null || a.machine === m; }
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
  /** `self`, the sending instance's address: only a whole argument of a send in M1 (S58). */
  | { k: 'self' }
  /** `k` after `spawn detached M as k`: the child's address, `<parent>/<k>` from the step's commit (S60, S78). */
  | { k: 'child'; key: string; machine: string }
  | { k: 'pre' }
  | { k: 'post' }
  /** In a compose invariant: parent.f, and children.k.f of the child k (PT7). */
  | { k: 'jointParent'; field: string }
  /** `r.f`, a field of a record value (S25). */
  | { k: 'recordField'; field: string }
  | { k: 'jointChild'; key: string; field: string }
  /** `children.f[i].x`: field x of a member of the family f (S49). */
  | { k: 'jointFamily'; family: string; field: string };

/** An attached child of a machine, by its key (PT6.4): its machine and its wiring, as the spawn states them. */
export interface ChildSpec {
  key: string;
  machine: string;
  create: string | null;
  onComplete: string | null;
  onParentTerminal: string | null;
}

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
  /** PT6.3: the timer keys the machine arms; a key is declared by its use in an `after`. */
  timerKeys: Set<string>;
  /** PT6.4: the attached children the machine spawns, by key; a key is declared by its use in a `spawn`. */
  children: Map<string, ChildSpec>;
  /** S51: for each completion action, the child keys whose completion names it: its `childKey` domain. */
  childKeyDomains: Map<string, string[]>;
  /** S49: child families by name, with the indices their keys take (`f` with 1..2 has the keys f1 and f2). */
  families: Map<string, { lo: number; hi: number }>;
  /** S60: the detached children the machine spawns, key to machine name, in the order of their first spawn. */
  detached: Map<string, string>;
  /** PD1: the machine's decisions by name. */
  decisions: Map<string, A.Decision>;
  /** S176: the type environment of the machine's own module, for `is` on an instance of a used module's machine. */
  env?: TypeEnv;
}

export interface CheckResult {
  diagnostics: Diagnostic[];
  env: TypeEnv;
  machines: Map<string, MachineFacts>;
}

// ── scopes ────────────────────────────────────────────────────────────────

type Ctx = 'init' | 'handler' | 'guard' | 'terminal' | 'invariant' | 'step' | 'reject' | 'path' | 'compose' | 'config';

/** The instances of a configuration, by name, as its properties read them (PS13.6, S32). */
interface ConfigScope {
  /** S176: `machine` is the instance's machine as the view spells it (`M`, or `m.M` of a used module). */
  instances: Map<string, { machine: A.Machine; name: string; facts: MachineFacts; count: number | null; spawned?: boolean }>;
  /** Inside `init(e)`: no second `init` (PS13.6). */
  inInit?: boolean;
}

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
  /** In a compose invariant, the child keys a `k spawned` conjunct establishes (S48), and `f[i]` for a family member (S49). */
  spawned?: Set<string>;
  /** Inside an aggregate over a family, `[*]` stands for each spawned member (S49). */
  star?: boolean;
  /** The expression is a whole argument of a send, where `self` is legal (S58). */
  selfOk?: boolean;
  /** In a configuration property: its instances (PS13.6). */
  config?: ConfigScope;
}

/**
 * S176: the modules of the program a module is checked in. `program` holds every module `use` may name; `view` is the
 * module whose names the result is spelled in (the checked module itself, unless a configuration of another module is
 * reading this one's machines), so a machine of another module is always `m.M` and one of the view's is `M` (PS1.0).
 */
export interface CheckOptions {
  program?: A.Module[];
  view?: string;
  /** PT10e: the provider profiles the module's credentials name, found by poly-check under std/credentials/providers. */
  providers?: Readonly<Record<string, ProviderEntry>>;
  /** PS18.3, PT10r: the price tables and calibration maps the module's routes name, found by poly-check beside the source. */
  routing?: Readonly<RoutingFiles>;
}

export function checkModule(module: A.Module, opts: CheckOptions = {}): CheckResult {
  return new Checker(module, opts).run();
}

/** S176: the module a `use` path names: the whole path when it is a module, else the path without its machine. */
export function usedModuleOf(path: string[], program: A.Module[]): { module: string; machine: string | null } {
  const whole = path.join('.');
  if (program.some((m) => m.name === whole)) return { module: whole, machine: null };
  return { module: path.slice(0, -1).join('.'), machine: path.length > 1 ? path[path.length - 1] : null };
}

class Checker {
  private diags: Diagnostic[] = [];
  /** The action of the handler whose paths are being read, for a loop's bound (S49). */
  private handlerAction: A.Action | undefined;
  /** S25: records that refer to themselves, reported once at their declaration. */
  private recursive = new Set<string>();
  private env: TypeEnv;
  private machine: A.Machine | null = null;
  private facts: MachineFacts | null = null;
  private actions = new Map<string, A.Action>();

  /** S176: the program's modules by name, the module names are spelled from, and the modules this one uses. */
  private readonly program: Map<string, A.Module>;
  private readonly view: string;
  /** S176 (B-F6 ruling): each used module, with the machines its uses admit, or null where `use m` admits them all. */
  private readonly used = new Map<string, Set<string> | null>();
  /** S176: the facts of used modules' machines, by qualified name, computed once when a configuration reads them. */
  private readonly foreignFacts = new Map<string, MachineFacts | null>();
  /** S190: the records and unions with payloads of used modules, as m.T, which stay PL0901. */
  private readonly foreignOther = new Set<string>();

  constructor(private readonly module: A.Module, private readonly opts: CheckOptions = {}) {
    this.env = buildTypeEnv(module);
    this.program = new Map((opts.program ?? []).map((m) => [m.name, m]));
    this.view = opts.view ?? module.name;
    for (const d of module.decls) {
      if (d.kind !== 'Use') continue;
      const u = usedModuleOf(d.path, opts.program ?? []);
      const had = this.used.get(u.module);
      if (u.machine === null || had === null) this.used.set(u.module, null);
      else this.used.set(u.module, new Set([...(had ?? []), u.machine]));
    }
    // S190: the payload-free enums of each used module join this module's types as m.E, which no bare name reaches
    // except through an expected type; its records and unions with payloads are known only to be refused (PL0901).
    for (const mod of this.used.keys()) {
      for (const d of this.program.get(mod)?.decls ?? []) {
        const q = `${mod}.${(d as { name?: string }).name}`;
        if (d.kind === 'EnumDecl') this.env.unions.set(q, { name: q, ctors: d.members.map((m) => ({ name: m, fields: [] })), isEnum: true });
        else if (d.kind === 'TypeDecl' && d.ctors.every((c) => c.fields.length === 0)) this.env.unions.set(q, { name: q, ctors: d.ctors.map((c) => ({ name: c.name, fields: [] })), isEnum: true });
        else if (d.kind === 'TypeDecl' || d.kind === 'RecordDecl') this.foreignOther.add(q);
      }
    }
  }

  /** PS1.0: a machine's name as the view spells it: `M` in the view's own module, `m.M` in any other. */
  private canon(mod: string, name: string): string { return mod === this.view ? name : `${mod}.${name}`; }

  /** The module and machine a name spelled from the view denotes. */
  private decode(name: string): { mod: string; machine: string } {
    const i = name.lastIndexOf('.');
    return i < 0 ? { mod: this.view, machine: name } : { mod: name.slice(0, i), machine: name.slice(i + 1) };
  }

  /** S176: whether this module may name machine `name` of module `mod`: its own, or one its uses admit. */
  private admits(mod: string, name: string): boolean {
    if (mod === this.module.name) return true;
    if (!this.used.has(mod)) return false;
    const s = this.used.get(mod);
    return s === null || s!.has(name);
  }

  private moduleNamed(mod: string): A.Module | undefined { return mod === this.module.name ? this.module : this.program.get(mod); }

  /** The declaration of a machine named as the view spells it, in this module or a used one. */
  private machineDecl(name: string | null): A.Machine | undefined {
    if (name === null) return undefined;
    const { mod, machine } = this.decode(name);
    return this.moduleNamed(mod)?.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === machine);
  }

  /**
   * S176: a machine named in source: `M` of this module, or `m.M` of a module this one uses (qualified names only, no
   * alias). Reports an unknown machine or a module not used, and returns its qualified name and declaration.
   */
  private machineRef(parts: string[], at: A.NodeBase, what: string, once = false): { name: string; decl: A.Machine; mod: string } | null {
    const report = (code: string, msg: string) => (once ? this.errOnce(code, at, msg) : this.err(code, at, msg));
    const mod = parts.length > 1 ? parts.slice(0, -1).join('.') : this.module.name;
    const name = parts[parts.length - 1];
    if (mod !== this.module.name && !this.used.has(mod)) { report('PL1001', `${what}: module ${mod} is not used here; write \`use ${mod}\` to name its machines (S176)`); return null; }
    // S176, as ruled (review B-F6): `use m.M` admits m.M and nothing else of m; m's own machines still name each other.
    if (!this.admits(mod, name)) { report('PL1001', `${what}: ${mod}.${name} is not used here; this module uses ${[...(this.used.get(mod) ?? [])].map((x) => `${mod}.${x}`).join(' and ')} only; write \`use ${mod}.${name}\` (S176)`); return null; }
    const decl = this.moduleNamed(mod)?.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === name);
    if (!decl) { report('PL1001', `${what}: no machine ${name} in module ${mod}`); return null; }
    return { name: this.canon(mod, name), decl, mod };
  }

  /**
   * S176: the type of a parameter of a used module's action, as a message across modules may carry it: only types that
   * need no module (booleans, ranges, int, strings, Principal, addresses). Null for a type the receiver's module
   * declares; the caller reports it.
   */
  private foreignTy(t: A.TypeExpr, mod: string): Ty | null {
    switch (t.kind) {
      case 'TBool': return BOOL;
      case 'TInt': return INT;
      case 'TString': return { k: 'string' };
      case 'TRange': return { k: 'int', lo: t.lo, hi: t.hi };
      case 'TRef': {
        const m = t.machine.length > 1 ? t.machine.slice(0, -1).join('.') : mod;
        return { k: 'ref', machine: this.canon(m, t.machine[t.machine.length - 1]) };
      }
      case 'TName': {
        const owner = this.moduleNamed(mod);
        const declared = owner?.decls.some((d) => (d.kind === 'TypeDecl' || d.kind === 'EnumDecl' || d.kind === 'RecordDecl') && d.name === t.name);
        if (t.name === 'Content' && !declared) return { k: 'content' };
        if (t.name === 'Key' && !declared) return { k: 'key' };
        if (t.name === 'Principal' && !declared) return { k: 'principal' };
        // S190: an enum of the receiver's module (or one it names m.E), spelled from here, when this module knows it.
        const q = t.name.includes('.') ? (t.name.slice(0, t.name.lastIndexOf('.')) === this.view ? t.name.slice(t.name.lastIndexOf('.') + 1) : t.name) : this.canon(mod, t.name);
        return this.env.unions.get(q)?.isEnum ? { k: 'union', name: q } : null;
      }
      default: return null;
    }
  }

  /** S176: the facts of a used module's machine, spelled from this view, for a configuration that instantiates it. */
  private factsOf(name: string, local: Map<string, MachineFacts>): MachineFacts | undefined {
    const { mod, machine } = this.decode(name);
    if (mod === this.module.name) return local.get(machine);
    if (!this.foreignFacts.has(name)) {
      const m = this.program.get(mod);
      const r = m ? new Checker(m, { program: [...this.program.values()], view: this.view }).run() : null;
      for (const [k, f] of r?.machines ?? []) this.foreignFacts.set(this.canon(mod, k), f);
      if (!this.foreignFacts.has(name)) this.foreignFacts.set(name, null);
    }
    return this.foreignFacts.get(name) ?? undefined;
  }

  /** S176: `use m` or `use m.M` names a module of the program other than this one, and the machine it names exists. */
  private useDecl(d: A.UseDecl): void {
    const u = usedModuleOf(d.path, [...this.program.values()]);
    if (u.module === this.module.name || d.path.join('.') === this.module.name) { this.err('PL1201', d, `module ${this.module.name} uses itself; \`use\` names another module (S176)`); return; }
    const m = this.program.get(u.module);
    if (!m) { this.err('PL1001', d, `use ${d.path.join('.')}: no module ${u.module} in the program (S176)`); return; }
    // S190: use m.E names an enum, as use m.M names a machine; a record or a union with payloads is PL0901.
    const item = u.machine === null ? undefined : m.decls.find((x) => (x.kind === 'Machine' || x.kind === 'EnumDecl' || x.kind === 'TypeDecl' || x.kind === 'RecordDecl') && x.name === u.machine);
    if (u.machine !== null && !item) this.err('PL1001', d, `use ${d.path.join('.')}: no machine or enum ${u.machine} in module ${u.module}`);
    else if (item && (item.kind === 'RecordDecl' || (item.kind === 'TypeDecl' && item.ctors.some((c) => c.fields.length)))) this.err('PL0901', d, `use ${d.path.join('.')}: a record or a union with payloads does not cross modules; only payload-free enums do (S190)`);
  }

  private at(n: A.NodeBase): NodeAt {
    return { module: this.module.name, machine: this.machine?.name, node: n.id, line: n.span?.line, col: n.span?.col };
  }
  private err(code: string, n: A.NodeBase, msg: string, extra: Partial<Diagnostic> = {}): void {
    this.diags.push(diag(code, this.at(n), msg, extra));
  }

  run(): CheckResult {
    const machines = new Map<string, MachineFacts>();
    this.declarations();
    // S143: runtime.* and runtime<m>.* are the runtime's own machine ids; only PT9.7's model takes them.
    const reserved = RESERVED_MODULE.test(this.module.name) && !RUNTIME_MODEL_DIGESTS.has(digest(this.module));
    for (const d of this.module.decls) {
      if (reserved && d.kind === 'Machine') this.err('PL1208', d, `machine ${this.module.name}.${d.name}: the module name ${this.module.name} is reserved for the runtime's own OutboxIntent model (PT9.7), and only that model takes it; rename the module (S143)`);
      if (d.kind === 'Use') this.useDecl(d);
      if (d.kind !== 'Machine') continue;
      if (machines.has(d.name)) { this.err('PL1002', d, `machine ${d.name} is declared twice`); continue; }
      machines.set(d.name, this.checkMachine(d));
    }
    // PD1.3b: a record or a union payload cannot hold a Conf (review A4).
    for (const d of this.module.decls) {
      const fields = d.kind === 'RecordDecl' ? d.fields : d.kind === 'TypeDecl' ? d.ctors.flatMap((c) => c.fields) : [];
      for (const f of fields) if (hasConf(f.type)) this.err('PL1205', f, `${(d as { name: string }).name}.${f.name} holds a Conf, and a Conf is only a completion parameter bound from a reply (PD1.3b)`);
    }
    this.sharedCompletions(machines);
    this.credentials();
    this.memory();
    this.routing();
    const configs = new Set<string>();
    for (const d of this.module.decls) {
      if (d.kind !== 'Configuration') continue;
      if (configs.has(d.name)) { this.err('PL1002', d, `configuration ${d.name} is declared twice`); continue; }
      configs.add(d.name);
      this.checkConfiguration(d, machines);
    }
    // PT10, S166: workflows, each over a machine of this module.
    const workflows = new Set<string>();
    for (const d of this.module.decls) {
      if (d.kind !== 'Workflow') continue;
      if (workflows.has(d.name)) { this.err('PL1002', d, `workflow ${d.name} is declared twice`); continue; }
      workflows.add(d.name);
      this.checkWorkflow(d, machines);
    }
    // Review A-F4: polyflow refuses its whole library when two workflows map one effect kind to different tools.
    const mapped = new Map<string, { w: string; spec: string }>();
    for (const d of this.module.decls) {
      if (d.kind !== 'Workflow') continue;
      for (const t of d.tools) {
        const spec = JSON.stringify([t.tool, t.target, t.why]);
        const first = mapped.get(t.effect);
        if (!first) { mapped.set(t.effect, { w: d.name, spec }); continue; }
        if (first.w !== d.name && first.spec !== spec) this.err('PL6803', t, `workflow ${d.name}: "${t.effect}" is mapped to another tool, target or reason than in workflow ${first.w}, and polyflow refuses a library that maps one kind two ways (S166)`);
      }
    }
    // S41: polyrun keys handlers by kind, so effects that share a kind must declare the same payload,
    // completions and class. Identical declarations may share it. Across modules, poly-check compares
    // the signatures of a project's files.
    const byKind = new Map<string, A.EffectDecl>();
    for (const facts of machines.values()) {
      for (const e of facts.effects.values()) {
        const k = effectKind(e);
        const first = byKind.get(k);
        if (!first) { byKind.set(k, e); continue; }
        if (effectSignature(first) !== effectSignature(e)) this.err('PL1002', e, `effect ${e.name} has kind "${k}", which ${first.name} declares with a different payload, completions or class (S41)`);
      }
    }
    // PS17.2, PT10j (S41 with S451, ruled 2026-10-09): each machine runs its own retrieval of a source, so two machines
    // may differ; within one machine a kind has one manifest entry, so two retrievals (or remembers) of one source that
    // differ in source, owner, key, limit or envelope (or provenance and subject) are refused at the second.
    const body = (e: A.EffectDecl): string | null => {
      const it = e.items.find((i) => i.kind === 'EffRetrieve' || i.kind === 'EffRemember');
      if (!it) return null;
      const { id: _id, span: _span, ...rest } = it as A.EffectItem & { span?: unknown };
      return JSON.stringify(Object.keys(rest).sort().map((x) => [x, (rest as Record<string, unknown>)[x]]));
    };
    for (const facts of machines.values()) {
      const seen = new Map<string, A.EffectDecl>();
      for (const e of facts.effects.values()) {
        if (body(e) === null) continue;
        const k = effectKind(e);
        const first = seen.get(k);
        if (!first) { seen.set(k, e); continue; }
        if (body(first) !== body(e)) this.err('PL1002', e, `effect ${e.name} reads or writes the source as ${first.name} does, with kind "${k}", and differs from it; a machine holds one retrieval or remember per source and kind (PS17.2, S41 with S451)`);
      }
    }
    return { diagnostics: this.diags, env: this.env, machines };
  }

  // ── memory (PS1.4b, PS17, M10) ───────────────────────────────────────────
  /** The declared audience classes, in order, or null when the module declares none. */
  private audienceClasses(): string[] | null {
    return this.module.decls.find((d): d is A.AudienceDecl => d.kind === 'Audience')?.classes ?? null;
  }

  /** PL6833: a class the audience declaration does not declare. */
  private audienceClass(c: string, at: A.NodeBase, what: string): void {
    const classes = this.audienceClasses();
    if (!classes) this.err('PL6833', at, `${what} names the class ${c}, and the module declares no audience (PS1.4b)`);
    else if (!classes.includes(c)) this.err('PL6833', at, `${what} names the class ${c}, which audience does not declare: ${classes.join(' < ')} (PS1.4b)`);
  }

  /** PS1.4b: the largest limit among the module's retrievals, the top of an Items count. */
  private itemsLimit(): number {
    let n = 0;
    for (const d of this.module.decls) if (d.kind === 'Machine') for (const it of d.items) if (it.kind === 'EffectDecl') for (const x of it.items) if (x.kind === 'EffRetrieve') n = Math.max(n, x.limit);
    return n;
  }

  private memory(): void {
    const audiences = this.module.decls.filter((d): d is A.AudienceDecl => d.kind === 'Audience');
    for (const a of audiences.slice(1)) this.err('PL1002', a, 'a program declares one audience (PS1.4b)');
    for (const a of audiences.slice(0, 1)) {
      const dup = a.classes.find((c, i) => a.classes.indexOf(c) !== i);
      if (dup) this.err('PL1002', a, `audience class ${dup} is declared twice`);
      if (this.module.decls.some((d) => (d.kind === 'EnumDecl' || d.kind === 'TypeDecl' || d.kind === 'RecordDecl') && d.name === 'Audience')) this.err('PL1002', a, 'audience declares the type Audience, which the module also declares');
    }
    const names = new Set<string>();
    for (const d of this.module.decls) {
      if (d.kind === 'Channel' && d.audience) this.audienceClass(d.audience, d, `channel ${d.name}`);
      if (d.kind !== 'Source') continue;
      if (names.has(d.name)) { this.err('PL1002', d, `source ${d.name} is declared twice`); continue; }
      names.add(d.name);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.name)) this.err('PL1201', d, `${JSON.stringify(d.name)} is not a source name: a source is named by an identifier (PS17.0)`);
      if (!SOURCE_KINDS.has(d.sourceKind)) this.err('PL1001', d, `${d.sourceKind} is not a kind of source: records, documents or memory (PS17.0)`);
      this.audienceClass(d.audience, d, `source ${d.name}`);
      // PS17.0: a memory source is the runtime's own store; any other is read through an adapter poly-io makes.
      if (d.sourceKind === 'memory' && d.adapter !== null) this.err('PL6834', d, `source ${d.name} is the project's memory, which the runtime keeps in its own store, so it names no adapter (PS17.5)`);
      if (d.sourceKind !== 'memory' && d.adapter === null) this.err('PL6834', d, `source ${d.name} names no adapter: one of ${[...SOURCE_ADAPTERS].join(', ')} (PS17.0)`);
      if (d.adapter !== null && d.sourceKind !== 'memory' && !SOURCE_ADAPTERS.has(d.adapter)) this.err('PL6834', d, `source ${d.name} names the adapter "${d.adapter}", which poly-io does not make: one of ${[...SOURCE_ADAPTERS].join(', ')} (PS17.0)`);
      if (d.freshness !== null && durationMs(d.freshness) === null) this.err('PL1201', d, `${d.freshness} is not a duration`);
      // PS17.0, S459: envelope k names one of the source's keys; the parser and the embedded reader hold it to once.
      if (d.envelope !== undefined && !(d.keys ?? []).includes(d.envelope)) this.err('PL1001', d, `source ${d.name} gives envelopes by ${d.envelope}, which is not one of its keys${d.keys?.length ? `: ${d.keys.join(', ')}` : ''} (PS17.0)`);
      // PS17.0, S460: credential c names a credential of the module with no holder, whose one grant the adapter reaches its
      // provider under; the memory source is the runtime's own store and reaches no provider. Written once by the parser.
      // S461: an owned source may name one with holder Principal (the credential check holds a holder to Principal), and
      // then each owner of its items has a grant of its own; a source that is not owned has no owner to key one by.
      if (d.credential !== undefined) {
        const c = this.module.decls.find((x): x is A.Credential => x.kind === 'Credential' && x.name === d.credential);
        if (d.sourceKind === 'memory') this.err('PL1201', d, `source ${d.name} is the project's memory, which the runtime keeps in its own store, so it names no credential (PS17.0)`);
        else if (!c) this.err('PL1001', d, `source ${d.name} names the credential ${d.credential}, and the module declares no credential ${d.credential} (PS17.0)`);
        else if (c.holder !== null && !d.owned) this.err('PL1201', d, `source ${d.name} names credential ${c.name}, which has a holder, and the source is not owned; a holder's grant is kept per owner, so only an owned source names one (PS17.0, S460, S461)`);
      }
    }
  }

  /** PS17.2, PS17.5: a retrieval's or a remember's source, and their parameters. */
  private memoryEffect(e: A.EffectDecl, r: A.EffRetrieve | null, m: A.EffRemember | null): void {
    const src = (name: string, at: A.NodeBase) => {
      const s = this.module.decls.find((d): d is A.SourceDecl => d.kind === 'Source' && d.name === name);
      if (!s) this.err('PL1001', at, `effect ${e.name} names the source ${name}, and the module declares no source ${name} (PS17.0)`);
      return s ?? null;
    };
    const principal = (name: string, at: A.NodeBase, role: string) => {
      const p = e.params.find((x) => x.name === name);
      if (!p) this.err('PL1001', at, `effect ${e.name} has no parameter ${name} to be ${role}`);
      else if (this.tyOf(p.type).k !== 'principal') this.err('PL1201', at, `${role} ${name} is ${tyToString(this.tyOf(p.type))}; it is a Principal parameter of the effect (PS17.2)`);
    };
    if (r && m) this.err('PL1201', m, `effect ${e.name} both retrieves and remembers; each is an effect of its own (PS17.2, PS17.5)`);
    // One meaning per effect: a retrieval's and a remember's kind and labels are fixed (PS17.2), and they name nothing else.
    for (const it of e.items) if ((r || m) && (it.kind === 'EffKind' || it.kind === 'EffLabels' || it.kind === 'EffTargets' || it.kind === 'EffUses' || it.kind === 'EffTo' || it.kind === 'EffAudience' || it.kind === 'EffEnvelope')) this.err('PL1201', it, `effect ${e.name} ${r ? 'retrieves' : 'remembers'}, so its kind and labels are the runtime's and it names no target, credential or recipient (PS17.2)`);
    if (r) {
      const s = src(r.source, r);
      // S459: an envelope retrieval gives one envelope and names no limit (0 in the tree); any other names at least one.
      if (r.envelope && r.limit !== 0) this.err('PL1201', r, 'an envelope retrieval names no limit: it gives the envelope of a reply to the newest item (PS17.2, PT10j)');
      if (!r.envelope && r.limit < 1) this.err('PL1201', r, 'a retrieval is limited to at least one item');
      // PS17.2, S459: an envelope retrieval's source declares envelope k, and its key predicate names that k.
      if (r.envelope && s) {
        if (s.envelope === undefined) this.err('PL1201', r, `effect ${e.name} retrieves an envelope from source ${s.name}, which declares no envelope (PS17.0, PS17.2)`);
        else if (!r.key || r.key.name !== s.envelope) this.err('PL1201', r, `effect ${e.name} retrieves an envelope from source ${s.name}, whose envelope is by its key ${s.envelope}; the retrieval names ${s.envelope} == x (PS17.2)`);
      }
      if (r.owner !== null) {
        principal(r.owner, r, 'the owner');
        if (s && !s.owned) this.err('PL6835', r, `effect ${e.name} retrieves where owner == ${r.owner} from source ${s.name}, which is not owned (PS17.2)`);
      }
      // PS17.0 (S461): a source whose credential names a holder reaches its provider under one owner's grant per request,
      // so each retrieval from it, an envelope retrieval included, names that owner.
      if (r.owner === null && s && s.credential !== undefined && this.module.decls.some((x) => x.kind === 'Credential' && x.name === s.credential && x.holder !== null)) this.err('PL1201', r, `effect ${e.name} retrieves from source ${s.name}, whose credential ${s.credential} names a holder, and names no owner: write where owner == p, so the request runs under p's grant only (PS17.0, S461)`);
      // PS17.2, S451: a key predicate names a key its source declares (PL1001) and a Key parameter (PL1201).
      if (r.key) {
        const k = r.key;
        if (s && !(s.keys ?? []).includes(k.name)) this.err('PL1001', r, `effect ${e.name} retrieves where ${k.name} == ${k.param}, and source ${s.name} declares no key ${k.name} (PS17.0, PS17.2)`);
        const p = e.params.find((x) => x.name === k.param);
        if (!p) this.err('PL1001', r, `effect ${e.name} has no parameter ${k.param} to be the key`);
        else if (this.tyOf(p.type).k !== 'key') this.err('PL1201', r, `the key ${k.param} is ${tyToString(this.tyOf(p.type))}; it is a Key parameter of the effect (PS17.2)`);
      }
    }
    if (m) {
      const s = src(m.source, m);
      if (s && s.sourceKind !== 'memory') this.err('PL1201', m, `effect ${e.name} remembers into source ${s.name}, which is not a memory source (PS17.5)`);
      principal(m.about, m, 'the subject');
      // PS17.5, S320: only a person's signed record makes an item verified (poly memory-verify).
      if (m.provenance === 'verified') this.err('PL6837', m, `effect ${e.name} remembers as verified; only a person's signed record makes an item verified (poly memory-verify, PS17.5)`);
      if (!e.params.some((p) => this.tyOf(p.type).k === 'content')) this.err('PL1201', m, `effect ${e.name} remembers, and its payload holds no Content to remember (PS17.5)`);
    }
  }

  // ── credentials (PT10e, S203) ──────────────────────────────────────────
  /** A provider's profile when it is well formed, else null (a missing or malformed one is reported by credentials()). */
  private profile(provider: string): ProviderProfile | null {
    const entry = this.opts.providers?.[provider];
    return entry && !profileProblem(entry.profile, provider) ? (entry.profile as ProviderProfile) : null;
  }

  // ── routes and budgets (PS18, PT10r, M11) ──────────────────────────────
  /** A price table when it is well formed for its provider, else null (a missing or malformed one is reported by routing()). */
  private priceTable(path: string, provider: string): PriceTable | null {
    const e = this.opts.routing?.prices[path];
    return e && !priceTableProblem(e.table, provider) ? (e.table as PriceTable) : null;
  }

  private routing(): void {
    const routes = this.module.decls.filter((d): d is A.Route => d.kind === 'Route');
    const budgets = this.module.decls.filter((d): d is A.Budget => d.kind === 'Budget');
    const names = new Set<string>();
    // Review A1 (M11): each name of a route, a tier and a budget is an identifier: a route's and a budget's name a
    // module and files of the build, so no name may reach outside it.
    const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const d of [...routes, ...budgets, ...routes.flatMap((r) => r.tiers)]) if (!IDENT.test(d.name)) this.err('PL1201', d, `${d.kind === 'Route' ? 'a route' : d.kind === 'Budget' ? 'a budget' : 'a tier'}'s name is an identifier, and ${JSON.stringify(d.name)} is not one (PT10r)`);
    for (const d of [...routes, ...budgets]) {
      if (names.has(d.name)) this.err('PL1002', d, `${d.kind === 'Route' ? 'route' : 'budget'} ${d.name} is declared twice, or shares its name with a route or a budget`);
      names.add(d.name);
    }
    for (const b of budgets) {
      if (!b.caps.length) this.err('PL1201', b, `budget ${b.name} declares no cap`);
      const per = new Set<string>();
      for (const c of b.caps) {
        if (!/^[a-z]{3}$/.test(c.currency)) this.err('PL1201', c, `${c.currency} is not a currency: a lower-case three-letter code, usd for example (PS18.3)`);
        if (c.amount <= 0) this.err('PL1201', c, `a cap of budget ${b.name} is zero, so nothing could ever be reserved under it`);
        const key = c.run ? 'run' : `${c.period ?? ''}:${c.scope}`;
        if (per.has(key)) this.err('PL1002', c, `budget ${b.name} has two caps per ${c.run ? 'run' : [c.period, c.scope ? 'scope' : null].filter(Boolean).join(' per ')}; one cap per address (PS18.4)`);
        per.add(key);
      }
    }
    const named = routedDecisions(this.module);
    for (const r of routes) {
      const decisions = named.get(r.name) ?? [];
      // PD1.6a: a tier's map is fitted for one decision, so a route serves one decision.
      if (decisions.length > 1) this.err('PL1201', r, `route ${r.name} is named by ${decisions.length} decisions (${decisions.map((x) => `${x.machine.name}.${x.decision.name}`).join(', ')}); a route serves one decision, since its maps are fitted for that decision (PS18.2)`);
      if (!r.tiers.length) this.err('PL1201', r, `route ${r.name} has no tier`);
      const tierNames = new Set<string>();
      const currencies = new Set<string>();
      const reservations: { tier: A.RouteTier; r: number }[] = [];
      for (const t of r.tiers) {
        if (tierNames.has(t.name)) this.err('PL1002', t, `route ${r.name} has two tiers ${t.name}`);
        tierNames.add(t.name);
        if (t.calibration !== null && !routePathOk(t.calibration)) this.err('PL1201', t, `tier ${t.name}: the calibration map "${t.calibration}" is not a relative path to a .json file under the source's directory, with no . or .. segment (PS18.3)`);
        const priced = this.pricedCall(t, `tier ${t.name}`, t.provider, t.prices, t.maxInputTokens, t.maxTokens);
        if (priced) {
          currencies.add(priced.currency);
          reservations.push({ tier: t, r: priced.r });
        }
        if (t.calibration !== null && routePathOk(t.calibration)) {
          const m = this.opts.routing?.maps[t.calibration];
          if (!m) this.err('PL1001', t, `tier ${t.name}: no calibration map at ${t.calibration} beside the source (PS18.1)`);
          else {
            const problem = mapProblem(m.map);
            if (problem) this.err('PL1201', t, `tier ${t.name}: the calibration map ${t.calibration} ${problem} (PD1.6)`);
            else {
              const map = m.map as CalibrationFile;
              for (const x of decisions) if (map.decision !== x.decision.name) this.err('PL1201', t, `tier ${t.name}: the calibration map ${t.calibration} was fitted for decision ${map.decision}, and route ${r.name} serves ${x.decision.name} (PD1.6a)`);
              // PT24.5, PD3.2, S355: the tier's model is its price table's, and its map must be fitted for that model;
              // a model changed without a refitted map would leave the route's thresholds with no meaning.
              const table = this.priceTable(t.prices, t.provider);
              if (table && map.fittedFor !== table.model) this.err('PL6842', t, `tier ${t.name} calls model ${table.model} (its price table ${t.prices}), and its calibration map ${t.calibration} was fitted for ${map.fittedFor}: refit the map for ${table.model} with poly journal fit (PT24.5, PD3.2)`);
            }
          }
        }
      }
      if (currencies.size > 1) this.err('PL6844', r, `route ${r.name} prices its tiers in ${[...currencies].sort().join(' and ')}; a route's tiers are priced in one currency (PS18.3)`);
      const kinds = new Set<string>();
      for (const e of r.escalate) {
        if (kinds.has(e.on)) this.err('PL1002', r, `route ${r.name} names ${e.on} twice in its escalation`);
        kinds.add(e.on);
        if (e.on !== 'failed' && !(e.below > 0 && e.below <= 1000)) this.err('PL1201', r, `route ${r.name}: ${e.on} < c needs 0 < c <= 1 (PD1.3a)`);
      }
      // PT24.1b: conf and margin are calibrated values, read through each tier's map.
      const reads = r.escalate.filter((e) => e.on !== 'failed').map((e) => e.on);
      for (const t of r.tiers) if (reads.length && t.calibration === null) this.err('PL6841', t, `route ${r.name} escalates on ${reads.join(' and ')}, and tier ${t.name} has no calibration map to read them through (PT24.1b)`);
      if (r.budget !== null) {
        const b = budgets.find((x) => x.name === r.budget);
        if (!b) this.err('PL1001', r, `route ${r.name} names budget ${r.budget}, which the module does not declare`);
        else {
          for (const c of b.caps) {
            for (const cur of currencies) if (cur !== c.currency) this.err('PL6844', c, `budget ${b.name} caps ${c.currency}, and route ${r.name} prices its tiers in ${cur} (PS18.3)`);
            for (const x of reservations) if (currencies.has(c.currency) && x.r > c.amount) this.err('PL6845', x.tier, `tier ${x.tier.name} of route ${r.name} reserves ${x.r} micro-units, above budget ${b.name}'s cap of ${c.amount}, so it could never be called (PS18.4)`);
          }
        }
      }
    }
    // PS18.4a, PT10r, S454: an unrouted decision that names a provider may name its price table, both token limits and
    // a budget, in one clause after its provider; the table is checked as a tier's, and the budget's caps against it.
    for (const m of this.module.decls) {
      if (m.kind !== 'Machine') continue;
      for (const d of m.items) {
        if (d.kind !== 'Decision') continue;
        const it = d.items.find((x): x is Extract<A.DecisionItem, { kind: 'DecBudget' }> => x.kind === 'DecBudget');
        if (!it) continue;
        const provider = d.items.find((x): x is Extract<A.DecisionItem, { kind: 'DecProvider' }> => x.kind === 'DecProvider');
        if (d.items.some((x) => x.kind === 'DecRoute')) { this.err('PL1201', it, `decision ${d.name} names its route, so the route names its budget and the decision names none (PS18.4a)`); continue; }
        if (!provider) { this.err('PL1201', it, `decision ${d.name} names a budget and no provider; a budget is named by a decision that names its provider (PS18.4a)`); continue; }
        if (d.items.indexOf(it) < d.items.indexOf(provider)) this.err('PL1201', it, `decision ${d.name} names its prices, limits and budget after its provider (PT10r)`);
        const b = it.budget === null ? undefined : budgets.find((x) => x.name === it.budget);
        if (it.budget !== null && !b) this.err('PL1001', it, `decision ${d.name} names budget ${it.budget}, which the module does not declare`);
        if (it.prices === null || it.maxInputTokens === null || it.maxTokens === null || it.budget === null) {
          this.err('PL1201', it, `decision ${d.name} names its budget with its price table and both token limits, as one clause: prices "f" max input tokens I max tokens N budget b (PS18.4a)`);
          continue;
        }
        const priced = this.pricedCall(it, `decision ${d.name}`, provider.value, it.prices, it.maxInputTokens, it.maxTokens);
        if (!b || !priced) continue;
        for (const c of b.caps) {
          if (c.currency !== priced.currency) this.err('PL6844', c, `budget ${b.name} caps ${c.currency}, and decision ${d.name} is priced in ${priced.currency} (PS18.3)`);
          else if (priced.r > c.amount) this.err('PL6845', it, `decision ${d.name} reserves ${priced.r} micro-units, above budget ${b.name}'s cap of ${c.amount}, so it could never be called (PS18.4)`);
        }
      }
    }
  }

  /**
   * PS18.3, S360: a priced call's provider, limits and price table, a tier's or a budgeted decision's (PS18.4a), each
   * fault reported against `who`; its currency and reservation when its table is well formed, else null.
   */
  private pricedCall(at: A.NodeBase, who: string, provider: string, prices: string, maxInputTokens: number, maxTokens: number): { currency: string; r: number } | null {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) this.err('PL1201', at, `${who}: the provider "${provider}" is not a plain name (lower-case letters, digits and -)`);
    if (maxTokens < 1) this.err('PL1201', at, `${who}: its token limit is at least 1 (PS18.3)`);
    // Review A5 (M11): every amount is a safe integer of micro-units, so no reservation is rounded.
    if (!Number.isSafeInteger(maxTokens)) this.err('PL1201', at, `${who}: its token limit ${maxTokens} is beyond the integers an amount holds exactly (PS18.3)`);
    // S360: the input limit is a whole number of tokens, at the table's input price.
    if (!(Number.isSafeInteger(maxInputTokens) && maxInputTokens >= 0)) this.err('PL1201', at, `${who}: its input token limit ${maxInputTokens} is not a whole number of tokens (S360)`);
    if (!routePathOk(prices)) this.err('PL1201', at, `${who}: the price table "${prices}" is not a relative path to a .json file under the source's directory, with no . or .. segment (PS18.3)`);
    const entry = routePathOk(prices) ? this.opts.routing?.prices[prices] : undefined;
    if (routePathOk(prices) && !entry) this.err('PL1001', at, `${who}: no price table at ${prices} beside the source (PS18.3)`);
    else if (entry) {
      const problem = priceTableProblem(entry.table, provider);
      if (problem) this.err(problem.code, at, `${who}: the price table ${prices} ${problem.message} (PS18.3, S350)`);
    }
    const table = this.priceTable(prices, provider);
    // S360: the input limit is priced by the table's class input, which the table therefore names.
    if (table && !Object.hasOwn(table.perMillionTokens, 'input')) this.err('PL1201', at, `${who}: the price table ${prices} has no class input, at which the input token limit is reserved (S360)`);
    if (!table || !Number.isSafeInteger(maxTokens) || !Number.isSafeInteger(maxInputTokens) || maxInputTokens < 0) return null;
    const r = reservationOf(maxInputTokens, maxTokens, table);
    if (!Number.isSafeInteger(r)) this.err('PL1201', at, `${who}: its reservation is beyond the integers an amount holds exactly (PS18.3)`);
    return { currency: table.currency, r };
  }

  private credentials(): void {
    const names = new Set<string>();
    for (const d of this.module.decls) {
      if (d.kind !== 'Credential') continue;
      // Review A2 (M9): the embedded form takes any string, and the name becomes a file of the build and a module.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.name)) { this.err('PL1201', d, `${JSON.stringify(d.name)} is not a credential name: a credential's name is an identifier (PT10e)`); continue; }
      if (names.has(d.name)) { this.err('PL1002', d, `credential ${d.name} is declared twice`); continue; }
      names.add(d.name);
      if (d.credKind !== 'oauth2') this.err('PL1001', d, `${d.credKind} is not a kind of credential; oauth2 is the one kind (PT10e)`);
      const entry = this.opts.providers?.[d.provider];
      const problem = entry ? profileProblem(entry.profile, d.provider) : null;
      if (!entry) this.err('PL1001', d, `credential ${d.name}: provider "${d.provider}" has no profile under std/credentials/providers (PT10e)`);
      else if (problem) this.err('PL1201', d, `credential ${d.name}: the profile of provider "${d.provider}" (${entry.file}) ${problem} (PT10e)`);
      const profile = this.profile(d.provider);
      if (!d.scopes.length) this.err('PL1201', d, `credential ${d.name} declares no scope`);
      const seen = new Set<string>();
      for (const s of d.scopes) {
        if (seen.has(s)) this.err('PL1002', d, `credential ${d.name} declares the scope ${s} twice`);
        seen.add(s);
        if (profile && !profile.scopes.includes(s)) this.err('PL1001', d, `${s} is not a scope provider "${d.provider}" defines: ${profile.scopes.join(', ')} (PT10e)`);
      }
      if (profile && !profile.grants.includes(d.grant)) this.err('PL1201', d, `provider "${d.provider}" does not support the ${d.grant} grant; its profile names ${profile.grants.join(', ')} (PT10e)`);
      if (profile && d.pkce && !profile.pkce) this.err('PL1201', d, `provider "${d.provider}" does not support PKCE, by its profile (PT10e)`);
      // A person's grant is held by someone, a Principal; the service's own credential is held by no one (PT10e).
      if (d.grant === 'client_credentials' && d.holder !== null) this.err('PL1201', d, `credential ${d.name} is the service's own (client_credentials) and has no holder (PT10e)`);
      else if (d.holder !== null && (d.holder !== 'Principal' || this.env.unions.has('Principal') || this.env.records.has('Principal'))) this.err('PL1201', d, `the holder of credential ${d.name} is ${d.holder}; a holder is a Principal (PT10e)`);
    }
  }

  /** PT10e: `uses c { s, … } for p` against the credential c of this module and its provider's base addresses. */
  private usesCredential(e: A.EffectDecl, u: A.EffUses, targets: A.EffTargets[]): void {
    const c = this.module.decls.find((d): d is A.Credential => d.kind === 'Credential' && d.name === u.credential);
    if (!c) { this.err('PL1001', u, `effect ${e.name} uses ${u.credential}, and the module declares no credential ${u.credential} (PT10e)`); return; }
    if (!u.scopes.length) this.err('PL1201', u, `effect ${e.name} uses ${c.name} with no scope`);
    const seen = new Set<string>();
    for (const s of u.scopes) {
      if (seen.has(s)) this.err('PL1002', u, `effect ${e.name} names the scope ${s} twice`);
      seen.add(s);
      // A credential with no scope is reported once, at its declaration.
      if (c.scopes.length && !c.scopes.includes(s)) this.err('PL6821', u, `effect ${e.name} uses the scope ${s}, which credential ${c.name} does not declare: ${c.scopes.join(', ')} (PT10e)`);
    }
    // S457: a person's credential that names no holder has one grant, and an effect that uses it names no for.
    if (c.grant === 'authorization_code' && c.holder === null) {
      if (u.holder !== null) this.err('PL1201', u, `credential ${c.name} is granted by a person and names no holder, so effect ${e.name} names no holder for it: the first signed grant request fixes the holder (PT10e, S457)`);
    } else if (c.grant === 'authorization_code') {
      if (u.holder === null) this.err('PL6822', u, `effect ${e.name} uses ${c.name}, a person's grant, and names no holder: write for p, p a Principal parameter of the effect (PT10e)`);
      else {
        const p = e.params.find((x) => x.name === u.holder);
        if (!p) this.err('PL1001', u, `effect ${e.name} has no parameter ${u.holder} to hold ${c.name}`);
        else if (this.tyOf(p.type).k !== 'principal') this.err('PL1201', u, `the holder ${u.holder} of ${c.name} is ${tyToString(this.tyOf(p.type))}; a holder is a Principal parameter of the effect (PT10e)`);
      }
    } else if (u.holder !== null) this.err('PL1201', u, `credential ${c.name} is the service's own (client_credentials), so effect ${e.name} names no holder for it (PT10e)`);
    // S455: an exact target is checked against the bases as a prefix is, by its URL.
    const egress = targets.flatMap((t) => t.targets.filter((x) => x.key === 'egress').flatMap((x) => x.values.map((v) => (typeof v === 'string' ? v : v.exact))));
    if (!egress.length) { this.err('PL1201', u, `effect ${e.name} uses ${c.name} and declares no egress target; a credential is sent only to declared targets under its provider's base addresses (PT10e)`); return; }
    const profile = this.profile(c.provider);
    if (!profile) return;
    for (const v of egress) if (!underBase(v, profile.bases)) this.err('PL6823', u, `effect ${e.name} uses ${c.name}, and its egress target ${JSON.stringify(v)} lies outside the base addresses of provider "${c.provider}": ${profile.bases.join(', ')} (PT10e)`);
  }

  // ── workflows (PT10, S166) ─────────────────────────────────────────────
  private checkWorkflow(w: A.Workflow, machines: Map<string, MachineFacts>): void {
    // Review A-F1: the name is the descriptor's directory, so it is a name, as the standalone surface's grammar gives.
    if (!/^[A-Za-z_][A-Za-z0-9_]*(-[A-Za-z0-9_]+)*$/.test(w.name)) { this.err('PL1201', w, `${JSON.stringify(w.name)} is not a workflow name: letters, digits, underscores and single hyphens (PT10)`); return; }
    const m = this.module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === w.machine);
    const facts = machines.get(w.machine);
    if (!m || !facts) { this.err('PL1001', w, `workflow ${w.name} runs ${w.machine}, which is no machine of module ${this.module.name}`); return; }
    // PL6801: polyflow starts a run by dispatching the input action with the caller's input, so it is a handled action.
    const act = m.items.find((i): i is A.Action => i.kind === 'Action' && i.name === w.input);
    if (!act || !m.items.some((i) => i.kind === 'Handler' && i.action === w.input)) {
      this.err('PL6801', w, `workflow ${w.name}: its input ${w.input} is ${act ? 'an action of' : 'no action of'} ${w.machine}${act ? ' with no handler' : ''}, so polyflow could not start a run with it (S166)`);
    }
    // PL6802: the key names parameters of the input action, its patterns compile, and every declared value matches.
    if (w.key) {
      const named = [...w.key.template.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
      if (!named.length) this.err('PL6802', w.key, `workflow ${w.name}: the key template ${JSON.stringify(w.key.template)} names no field, so every run would have one name (S166)`);
      for (const f of named) if (act && !act.params.some((p) => p.name === f)) this.err('PL6802', w.key, `workflow ${w.name}: the key field ${f} is no parameter of ${w.input} (S166)`);
      const patterned = new Set<string>();
      for (const f of w.key.fields) {
        if (!named.includes(f.name)) { this.err('PL6802', f, `workflow ${w.name}: ${f.name} has a pattern, and the key template does not name it (S166)`); continue; }
        // Review A-F3: one pattern per field; the descriptor holds one, so a second would be checked and then lost.
        if (patterned.has(f.name)) { this.err('PL6802', f, `workflow ${w.name}: ${f.name} is given a second pattern, and polyflow keeps one (S166)`); continue; }
        patterned.add(f.name);
        let re: RegExp;
        try { re = new RegExp(f.pattern); } catch (e) { this.err('PL6802', f, `workflow ${w.name}: the pattern of ${f.name} does not compile: ${(e as Error).message} (S166)`); continue; }
        const p = act?.params.find((x) => x.name === f.name);
        // Every declared value of the field: a set's members, or each integer of a range, whether the range is the
        // check domain or the type (polywatch on step 2). A value the pattern refuses is a run that could not start.
        // Review A-F2: every value, ranges in full and enums by member, as the contract gives them to polyflow.
        const d = p?.check?.domain;
        const range = d?.kind === 'DomainRange' ? d : p?.type.kind === 'TRange' ? p.type : null;
        const members = p?.type.kind === 'TName' ? this.env.unions.get(p.type.name) : undefined;
        let values: string[] | null;
        if (d?.kind === 'DomainSet') values = d.values.map((v) => String((v as { value?: unknown }).value));
        else if (range) values = range.hi - range.lo + 1 > 1_000_000 ? null : Array.from({ length: range.hi - range.lo + 1 }, (_, k) => String(range.lo + k));
        else if (members?.isEnum) values = members.ctors.map((c) => c.name);
        else if (p?.type.kind === 'TBool') values = ['true', 'false'];
        else values = null;
        if (p && values === null) { this.err('PL6802', f, `workflow ${w.name}: ${w.input}'s ${f.name} has no finite set of values poly can test against the key's pattern; give it a check domain, an enum or a range of at most a million values (S166)`); continue; }
        if ((values ?? []).includes('')) this.err('PL6802', f, `workflow ${w.name}: ${w.input}'s ${f.name} may be empty, which polyflow refuses as a missing key field (S166)`);
        const refused = (values ?? []).filter((v) => v !== '' && !re.test(v));
        if (refused.length) this.err('PL6802', f, `workflow ${w.name}: ${w.input}'s ${f.name} may be ${refused.slice(0, 3).map((v) => JSON.stringify(v)).join(', ')}${refused.length > 3 ? ` and ${refused.length - 3} more` : ''}, which the key's pattern refuses, so such a run could not start (S166)`);
      }
    }
    // PL6804 (S172): polyflow admits a workflow only on at least one effect invariant, so its machine needs a path
    // property. This mirrors polyflow's rule and goes no further; no fix is offered, since only the author can say it.
    if (!m.items.some((i) => i.kind === 'Property' && i.form === 'path')) {
      this.err('PL6804', w, `workflow ${w.name}: ${w.machine} declares no path property, and polyflow admits only workflows whose machine has at least one path property (S172)`);
    }
    // PL6803: each effect kind of the machine has exactly one tool, and each tool's kind is an effect of the machine.
    const kinds = new Set([...facts.effects.values()].map((e) => effectKind(e)));
    const seen = new Set<string>();
    for (const t of w.tools) {
      if (!kinds.has(t.effect)) this.err('PL6803', t, `workflow ${w.name}: "${t.effect}" is no effect kind of ${w.machine} (${[...kinds].sort().join(', ') || 'it has none'}) (S166)`);
      else if (seen.has(t.effect)) this.err('PL6803', t, `workflow ${w.name}: "${t.effect}" is mapped to a tool twice (S166)`);
      seen.add(t.effect);
    }
    for (const k of [...kinds].sort()) if (!seen.has(k)) this.err('PL6803', w, `workflow ${w.name}: the effect kind "${k}" has no tool, so polyflow would hand out a work order no tool fulfils (S166)`);
  }

  // ── configurations (PS13, PT7a) ─────────────────────────────────────────
  private checkConfiguration(c: A.Configuration, machines: Map<string, MachineFacts>): void {
    this.machine = null;
    this.facts = null;
    const instances: ConfigScope['instances'] = new Map();
    for (const i of c.instances) {
      if (instances.has(i.name)) { this.err('PL1002', i, `instance ${i.name} is declared twice in ${c.name}`); continue; }
      if (i.count !== null && i.count < 1) this.err('PL1201', i, `a group has at least one instance: ${i.name}[${i.count}]`);
      // S176: an instance of this module's machine, or of a used module's as m.M.
      const ref = this.machineRef(i.machine, i, `instance ${i.name}`);
      if (!ref) continue;
      const facts = this.factsOf(ref.name, machines);
      if (!facts) { this.err('PL1001', i, `no machine ${i.machine.join('.')} in module ${ref.mod}`); continue; }
      // S61: an instance with attached children would need its joint machine inside the configuration.
      if (facts.children.size) this.err('PL0901', i, `${facts.machine.name} spawns attached children; a configuration of such a machine is checked from a later milestone (S61)`);
      instances.set(i.name, { machine: facts.machine, name: ref.name, facts, count: i.count });
    }
    this.spawnedGroups(c, instances, machines);
    const cfg: ConfigScope = { instances };
    // PS13.1: an instance's initial state, its addresses included.
    for (const i of c.instances) {
      const inst = instances.get(i.name);
      if (!inst) continue;
      const given = new Set<string>();
      for (const x of i.init) {
        const ft = inst.facts.fieldTypes.get(x.field);
        if (!ft) { this.err('PL1001', x.value, `${inst.machine.name} has no field ${x.field}`); continue; }
        if (given.has(x.field)) this.err('PL1002', x.value, `${x.field} is given twice`);
        given.add(x.field);
        if (ft.k === 'ref') { this.address(x.value, ft.machine, cfg, `${i.name}.${x.field}`); continue; }
        const vt = this.typeOf(x.value, this.scope('init'), ft);
        if (!same(vt, ft)) { this.err(opaqueCode(vt, ft), x.value, `${i.name}.${x.field} is ${tyToString(ft)}, and the value is ${tyToString(vt)}`); continue; }
        if (this.fold(x.value) === undefined && x.value.kind !== 'MapLit' && x.value.kind !== 'ArrayLit' && x.value.kind !== 'CtorExpr') { this.err('PL1201', x.value, 'an initial value in a configuration is a constant (PS13.1)'); continue; }
        this.checkConst(x.value, ft, inst.machine.fields.find((f) => f.name === x.field)!.check, `${i.name}.${x.field}`);
      }
    }
    // S31: inputs name an instance, a member or every member of a group, and an action of its machine.
    const seen = new Set<string>();
    for (const r of c.inputs) {
      const inst = instances.get(r.instance);
      if (!inst) { if (!c.instances.some((i) => i.name === r.instance)) this.err('PL1001', r, `no instance ${r.instance} in ${c.name}`); continue; }
      if (inst.count === null && r.index !== null) this.err('PL1201', r, `${r.instance} is one instance, not a group; write ${r.instance}.${r.action}`);
      if (inst.count !== null && r.index === null) this.err('PL5403', r, `${r.instance} is a group; write ${r.instance}[*].${r.action} or ${r.instance}[i].${r.action}`);
      if (inst.count !== null && typeof r.index === 'number' && (r.index < 0 || r.index >= inst.count)) this.err('PL1201', r, `${r.instance}[${r.index}] is not a member of ${r.instance}[${inst.count}]`);
      if (!inst.machine.items.some((it) => it.kind === 'Action' && it.name === r.action)) this.err('PL1001', r, `${inst.machine.name} has no action ${r.action}`);
      const key = `${r.instance}[${r.index}].${r.action}`;
      if (seen.has(key)) this.err('PL1002', r, `input ${r.instance}${r.index === null ? '' : `[${r.index}]`}.${r.action} is listed twice`);
      seen.add(key);
    }
    // S62: the transit bound is what makes the exploration end.
    if (!c.bounds) this.err('PL5303', c, `configuration ${c.name} declares no bounds; write bounds { transit n } (PS13.1)`);
    else if (c.bounds.transit < 1 || (c.bounds.instances !== null && c.bounds.instances < c.instances.reduce((n, i) => n + (i.count ?? 1), 0))) this.err('PL1201', c.bounds, 'the transit bound is at least 1, and the instance bound at least the declared instances (PS13.1)');
    const names = new Set<string>();
    for (const p of c.properties) {
      if (names.has(p.name)) this.err('PL1002', p, `property ${p.name} is declared twice`);
      names.add(p.name);
      const scope: Scope = { ...this.scope('config'), config: cfg };
      if (p.kind === 'Property') { this.expectBool(p.expr, scope); continue; }
      // M1-2: liveness is typed here and listed as not run; S56: its quantifier ranges over a group.
      const inner: Scope = { ...scope, locals: new Map() };
      if (p.quant) {
        const g = instances.get(p.quant.group);
        if (!g || g.count === null) this.err('PL1001', p, `${p.quant.group} is not a group of ${c.name}`);
        else inner.locals.set(p.quant.var, { ty: { k: 'int', lo: 0, hi: g.count - 1 }, res: { k: 'let', name: p.quant.var } });
      }
      if (p.from) this.expectBool(p.from, inner);
      this.expectBool(p.expr, inner);
      for (const g of p.fair ?? []) {
        for (const m of g.members) {
          // S73: a configuration's fairness names instances as an InputRef does.
          if (!m.input) { this.err('PL1201', g, `in a configuration, fairness names an input as g[*].${m.action} or x.${m.action} (S73)`); continue; }
          const inst = instances.get(m.input.instance);
          if (!inst) { this.err('PL1001', g, `no instance ${m.input.instance} in ${c.name}`); continue; }
          if ((inst.count === null) !== (m.input.index === null)) this.err('PL1201', g, `${m.input.instance} is ${inst.count === null ? 'one instance' : 'a group'}; name it as in inputs (S31, S73)`);
          else if (inst.count !== null && typeof m.input.index === 'number' && (m.input.index < 0 || m.input.index >= inst.count)) this.err('PL1201', g, `${m.input.instance}[${m.input.index}] is not a member of ${m.input.instance}[${inst.count}] (S31, S73)`);
          if (!inst.machine.items.some((it) => it.kind === 'Action' && it.name === m.action)) this.err('PL1001', g, `${inst.machine.name} has no action ${m.action}`);
        }
      }
    }
  }

  /**
   * S60, PS13.3: detached spawns create instances at `<parent>/<k>`, and those of machine T join the group T. Its
   * potential members are every such address reachable within `instances n`, breadth first from the declared
   * instances; properties and inputs read the members that exist. `instances n` is required once a machine of the
   * configuration spawns detached children (PT7a).
   */
  private spawnedGroups(c: A.Configuration, instances: ConfigScope['instances'], machines: Map<string, MachineFacts>): void {
    const declared: string[] = [];
    for (const i of c.instances) { const inst = instances.get(i.name); if (inst) for (let k = 0; k < (i.count ?? 1); k++) declared.push(inst.name); }
    const spawner = declared.find((m) => this.factsOf(m, machines)?.detached.size);
    if (!spawner) return;
    // Every machine a spawn can reach has its group, empty when the bound admits none of its instances.
    const counts = new Map<string, number>();
    const reach = [...new Set(declared)];
    for (let i = 0; i < reach.length; i++) {
      for (const t of this.factsOf(reach[i], machines)?.detached.values() ?? []) {
        if (!counts.has(t)) counts.set(t, 0);
        if (!reach.includes(t)) reach.push(t);
      }
    }
    const limit = c.bounds?.instances;
    if ((limit === null || limit === undefined) && c.bounds) this.err('PL5303', c, `${spawner} spawns detached children, so configuration ${c.name} needs an instance bound; write bounds { transit n, instances n } (S60, S62)`);
    let level = declared;
    for (let depth = 1; limit !== null && limit !== undefined && depth <= limit - declared.length && level.length; depth++) {
      const next: string[] = [];
      for (const m of level) for (const t of this.factsOf(m, machines)?.detached.values() ?? []) next.push(t);
      for (const t of next) counts.set(t, (counts.get(t) ?? 0) + 1);
      if ([...counts.values()].reduce((a, b) => a + b, 0) > 256) { this.err('PL0901', c, `configuration ${c.name} has more than 256 potential detached instances within instances ${limit}; checked from a later milestone (S60)`); return; }
      level = next;
    }
    for (const [t, count] of counts) {
      const facts = this.factsOf(t, machines);
      if (!facts) continue;
      if (instances.has(t)) { this.err('PL1002', c, `the detached ${t} instances form the group ${t}, and ${c.name} also declares an instance ${t} (S60)`); continue; }
      if (facts.children.size) this.err('PL0901', c, `${t} spawns attached children; a configuration of such a machine is checked from a later milestone (S61)`);
      instances.set(t, { machine: facts.machine, name: t, facts, count, spawned: true });
    }
  }

  /** An address in a configuration (PS1.6): `none`, an instance of machine M, or a member `g[k]` of a group of M. */
  private address(e: A.Expr, machine: string | null, cfg: ConfigScope, what: string): void {
    if (e.kind === 'Name' && e.name === 'none') return;
    const name = e.kind === 'Name' ? e.name : e.kind === 'Index' && e.object.kind === 'Name' ? e.object.name : null;
    const inst = name ? cfg.instances.get(name) : undefined;
    if (!inst) { this.err('PL1201', e, `${what} is an address: none, an instance, or a member g[k] of a group`); return; }
    if (e.kind === 'Name' && inst.count !== null) { this.err('PL5403', e, `${name} is a group; name one member, ${name}[k]`); return; }
    if (e.kind === 'Index') {
      if (inst.count === null) { this.err('PL1201', e, `${name} is one instance, not a group`); return; }
      if (e.index.kind !== 'Int' || e.index.value < 0 || e.index.value >= inst.count) { this.err('PL1201', e, `${name}[…] takes a constant index from 0 to ${inst.count - 1}`); return; }
    }
    if (machine !== null && inst.name !== machine) this.err('PL1201', e, `${what} is Ref<${machine}>, and ${name} is a ${inst.name}`);
  }

  /**
   * An instance form in a configuration property (S32): `x`, `g[i]` or, inside an aggregate, `g[*]`. Null when
   * the expression is not one; otherwise the instance, with PL5403 for a `g[*]` outside an aggregate.
   */
  private instanceForm(e: A.Expr, scope: Scope): { machine: A.Machine; facts: MachineFacts; name: string } | 'error' | null {
    const cfg = scope.config;
    if (!cfg) return null;
    if (e.kind === 'Name' && !scope.locals.has(e.name)) {
      const inst = cfg.instances.get(e.name);
      if (!inst) return null;
      if (inst.count !== null) { this.err('PL5403', e, `${e.name} is a group; quantify it, forall i in ${e.name}: …, or aggregate it, count(${e.name}[*] …) (PS13.6)`); return 'error'; }
      return { machine: inst.machine, facts: inst.facts, name: e.name };
    }
    // S176: the group of a used module's machine's detached instances is named as the machine is, m.M.
    // Review B-F5: the module may be dotted (std.channels.M[*]), so the whole member chain is the group's name.
    const qualified = e.kind === 'Index' && e.object.kind === 'Member' ? dottedName(e.object) : null;
    const groupName = e.kind === 'Index' ? (e.object.kind === 'Name' ? e.object.name : qualified && this.admits(qualified.slice(0, qualified.lastIndexOf('.')), qualified.slice(qualified.lastIndexOf('.') + 1)) && !scope.locals.has(qualified.split('.')[0]) ? qualified : null) : null;
    if (e.kind === 'Index' && groupName !== null) {
      const inst = cfg.instances.get(groupName);
      if (!inst) return null;
      if (inst.count === null) { this.err('PL1201', e, `${groupName} is one instance, not a group`); return 'error'; }
      if (e.index.kind === 'Star') {
        if (!scope.star) { this.err('PL5403', e, `${groupName}[*] stands for every member only inside count, sum, all or any; elsewhere write forall i in ${groupName}: … (PS13.6)`); return 'error'; }
      } else {
        const it = this.typeOf(e.index, scope);
        if (it.k !== 'int' && it.k !== 'error') { this.err('PL1201', e.index, `an index is an int, not ${tyToString(it)}`); return 'error'; }
        // S60: which spawned members exist depends on the state, so a spawned group is read through a quantifier
        // or an aggregate, never at a fixed index (review C2).
        if (inst.spawned && !(e.index.kind === 'Name' && scope.locals.has(e.index.name))) { this.err('PL1201', e, `${groupName} is a group of detached instances; read it with forall, exists or an aggregate (S60)`); return 'error'; }
        // The members are g[0] … g[n-1]; an index whose range leaves them names no instance (review finding).
        if (it.k === 'int' && (it.lo < 0 || it.hi > inst.count - 1)) { this.err('PL1201', e.index, `${groupName}[…] takes an index in 0..${inst.count - 1}, and this one ranges over ${tyToString(it)}`); return 'error'; }
      }
      return { machine: inst.machine, facts: inst.facts, name: groupName };
    }
    return null;
  }

  /** S32: `g[i] is C` tests the one field of the machine whose type has every constructor named. */
  private configIs(e: A.Is, inst: { machine: A.Machine; facts: MachineFacts; name: string }): void {
    // S176: an instance of a used module's machine is read with its own module's types.
    const env = inst.facts.env ?? this.env;
    const owners = e.ctors.map((c) => inst.machine.fields.filter((f) => { const t = inst.facts.fieldTypes.get(f.name)!; return t.k === 'union' && env.unions.get(t.name)!.ctors.some((x) => x.name === c); }).map((f) => f.name));
    const field = owners[0]?.length === 1 ? owners[0][0] : null;
    if (!field || owners.some((o) => o.length !== 1 || o[0] !== field)) {
      this.err('PL1005', e, `${e.ctors.join(' | ')} names no single field of ${inst.machine.name}${owners.some((o) => o.length > 1) ? `; several fields have it, so write ${inst.name}[…].f is ${e.ctors[0]}` : ''} (S32)`);
    }
  }

  // ── declarations ────────────────────────────────────────────────────────
  private declarations(): void {
    // A declared name becomes a JSON key and a property of generated objects; __proto__ would set a prototype (review finding L8).
    const proto = (x: unknown): void => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(proto); return; }
      const n = x as { kind?: string; name?: string; members?: string[]; id?: string };
      if (n.kind && n.kind !== 'Name' && (n.name === '__proto__' || n.members?.includes('__proto__'))) this.err('PL1201', n as A.NodeBase, '__proto__ cannot be a name: it is not a safe JSON key');
      // S155: $claims and $lineage are the runtime's reserved data keys; no program declares them.
      if (n.kind && n.kind !== 'Name' && (n.name === '$claims' || n.name === '$lineage' || n.name === '$content')) this.err('PL1208', n as A.NodeBase, `${n.name} is reserved: the runtime writes it, and no program declares it (S155, S180)`);
      for (const [k, v] of Object.entries(x)) if (k !== 'span') proto(v);
    };
    proto(this.module.decls);
    const seen = new Set<string>();
    for (const d of this.module.decls) {
      if (d.kind === 'RecordDecl') {
        // S25: a record has named fields, each once, each finite, and it may not refer to itself.
        if (seen.has(d.name)) this.err('PL1002', d, `type ${d.name} is declared twice`);
        seen.add(d.name);
        const fdup = d.fields.map((f) => f.name).find((n, i, a) => a.indexOf(n) !== i);
        if (fdup) this.err('PL1002', d, `field ${fdup} is declared twice in ${d.name}`);
        if (this.refersTo(d.name, d.fields.map((f) => f.type), new Set())) {
          // A cycle through a record already reported is the same mistake (review finding C8).
          const reported = [...this.recursive].some((r) => this.refersTo(r, d.fields.map((f) => f.type), new Set()));
          this.recursive.add(d.name);
          if (!reported) this.err('PL1201', d, `record ${d.name} refers to itself; a record is finite and not recursive (S25)`);
          continue;
        }
        for (const f of d.fields) {
          // PD5.1.2a, S103: a claims field is an enum, an integer range or a Principal; Tri is refused as everywhere.
          if (d.claims && f.type.kind === 'TName' && f.type.name === 'Tri') { this.err('PL1203', f, `claims field ${d.name}.${f.name} is Tri; a claim is verified, so it is an enum such as Attest { Verified, Failed, Absent } (S103)`); continue; }
          // Review A-F4, PD5.1.2a: an enum without payloads, an integer range or a Principal; int and string are PL1101 below.
          if (d.claims && f.type.kind !== 'TInt' && f.type.kind !== 'TString' && f.type.kind !== 'TRange' && !(f.type.kind === 'TName' && (f.type.name === 'Principal' || this.env.unions.get(f.type.name)?.isEnum))) { this.err('PL1201', f, `claims field ${d.name}.${f.name} is ${f.type.kind === 'TName' ? f.type.name : f.type.kind.slice(1).toLowerCase()}; a claims field is an enum, an integer range or a Principal (PD5.1.2a, S103)`); continue; }
          if (this.tyOf(f.type).k === 'ref') this.err('PL0901', f, `an address inside a record is lowered after milestone M1: ${d.name}.${f.name}`);
          if (this.holds(this.tyOf(f.type), (x) => x.k === 'content' || x.k === 'items')) this.err('PL1209', f, `a Content or an Items is opaque and is no record field: ${d.name}.${f.name} (PS1.4a, PS1.4b)`);
          if (cardinality(f.type, this.env) === null) this.err('PL1101', f, `field ${d.name}.${f.name} has no finite domain; give it a range or an enum type`);
        }
        continue;
      }
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
            // A payload through a recursive record was reported at the record (S25).
            if (cardinality(f.type, this.env) === null && ![...this.recursive].some((r) => this.refersTo(r, [f.type], new Set()))) this.err('PL1101', f, `payload ${c.name}.${f.name} has no finite domain; give it a range or an enum type`);
            if (this.holds(this.tyOf(f.type), (x) => x.k === 'content' || x.k === 'items')) this.err('PL1209', f, `a Content or an Items is opaque and is no payload field: ${c.name}.${f.name} (PS1.4a, PS1.4b)`);
          }
        }
      }
    }
  }

  /** Whether any of the types refers to the type `name`, through records, unions and maps (S25). */
  private refersTo(name: string, types: A.TypeExpr[], visiting: Set<string>): boolean {
    return types.some((t) => {
      if (t.kind === 'TMap') return this.refersTo(name, [t.key, t.value], visiting);
      if (t.kind !== 'TName') return false;
      if (t.name === name) return true;
      if (visiting.has(t.name)) return false;
      visiting.add(t.name);
      const r = this.env.records.get(t.name);
      if (r) return this.refersTo(name, r.fields.map((f) => f.type), visiting);
      const u = this.env.unions.get(t.name);
      return u ? u.ctors.some((c) => this.refersTo(name, c.fields.map((f) => f.type), visiting)) : false;
    });
  }

  /** The semantic type of a type expression, reporting unknown names and bad map keys. */
  private tyOf(t: A.TypeExpr): Ty {
    switch (t.kind) {
      case 'TConf': return { k: 'conf' };
      case 'TBool': return BOOL;
      case 'TInt': return INT;
      case 'TString': return { k: 'string' };
      case 'TRange':
        if (t.lo > t.hi) { this.errOnce('PL1201', t, `empty range ${t.lo}..${t.hi}`); return ERR; }
        return { k: 'int', lo: t.lo, hi: t.hi };
      case 'TRef': {
        // PS1.6: an address of a machine of this module, or of a used module's as m.M (S176).
        const r = this.machineRef(t.machine, t, `Ref<${t.machine.join('.')}>`, true);
        return r ? { k: 'ref', machine: r.name } : ERR;
      }
      case 'TName':
        // A recursive record was reported at its declaration; its uses say nothing more (one mistake, one diagnostic).
        if (this.recursive.has(t.name)) return ERR;
        if (this.env.records.has(t.name)) return { k: 'record', name: t.name };
        // PD5.1.2b: Principal is built in, unless the module declares a type of that name.
        if (t.name === 'Principal' && !this.env.unions.has(t.name)) return { k: 'principal' };
        // PS1.4a, S180: Content is built in, unless the module declares a type of that name.
        if (t.name === 'Content' && !this.env.unions.has(t.name)) return { k: 'content' };
        // PS1.4c, S451: Key is built in, unless the module declares a type of that name.
        if (t.name === 'Key' && !this.env.unions.has(t.name) && !this.env.records.has(t.name)) return { k: 'key' };
        // PS1.4b, S303: Items is built in, unless the module declares a type of that name.
        if (t.name === 'Items' && !this.env.unions.has(t.name) && !this.env.records.has(t.name)) return { k: 'items' };
        // S190: m.E, an enum of a used module, nameable where a use admits it.
        if (t.name.includes('.')) {
          const i = t.name.lastIndexOf('.');
          const mod = t.name.slice(0, i), name = t.name.slice(i + 1);
          if (this.foreignOther.has(t.name)) { this.errOnce('PL0901', t, `${t.name} is a record or a union with payloads of another module; only payload-free enums cross modules (S190)`); return ERR; }
          if (!this.env.unions.has(t.name)) { this.errOnce('PL1001', t, this.used.has(mod) ? `module ${mod} declares no enum ${name}` : `${t.name}: module ${mod} is not used here; write \`use ${mod}\` (S190)`); return ERR; }
          if (!this.admits(mod, name)) { this.errOnce('PL1001', t, `${t.name} is not used here; write \`use ${t.name}\` (S190)`); return ERR; }
          return { k: 'union', name: t.name };
        }
        if (!this.env.unions.has(t.name)) { this.errOnce('PL1001', t, `unknown type ${t.name}`); return ERR; }
        return { k: 'union', name: t.name };
      case 'TMap': {
        // S190: a map of another module's types stays PL0901.
        if ((t.key.kind === 'TName' && t.key.name.includes('.')) || (t.value.kind === 'TName' && t.value.name.includes('.'))) { this.errOnce('PL0901', t, 'a map of another module\'s types is not lowered; only a field, a parameter or a payload holds one (S190)'); return ERR; }
        const value = this.tyOf(t.value);
        if (t.key.kind === 'TRange') {
          if (t.key.lo !== 0) this.errOnce('PL1602', t.key, `a map keyed by a range must start at 0, as it lowers to a JSON array (${t.key.lo}..${t.key.hi})`);
          return { k: 'map', key: { k: 'int', lo: t.key.lo, hi: t.key.hi }, value, array: true };
        }
        const key = this.tyOf(t.key);
        if (key.k === 'principal') this.errOnce('PL1206', t.key, 'a Principal is opaque, so it cannot key a map: it is compared by equality, stored or passed (PD5.1.2b)');
        if (key.k === 'content') this.errOnce('PL1209', t.key, 'a Content is opaque, so it cannot key a map: it is stored, passed or compared for equality (PS1.4a)');
        if (key.k === 'key') this.errOnce('PL1209', t.key, 'a Key is opaque, so it cannot key a map: it is stored, passed or compared for equality (PS1.4c)');
        if (key.k === 'items' || value.k === 'items') this.errOnce('PL1209', t, 'an Items is passed, never stored in a map (PS1.4b)');
        if (key.k === 'union' && !this.env.unions.get(key.name)!.isEnum) this.errOnce('PL1201', t.key, `map key ${key.name} must be an enum (constructors without payload)`);
        // PT3.1: an enum or an integer range 0..n; a record has no key form in JSON.
        if (key.k === 'record') this.errOnce('PL1201', t.key, `map key ${key.name} is a record; a map is keyed by an enum or a range 0..n (PT3.1)`);
        return { k: 'map', key, value, array: false };
      }
    }
  }

  // ── machines ────────────────────────────────────────────────────────────
  private checkMachine(m: A.Machine): MachineFacts {
    this.machine = m;
    const facts: MachineFacts = { machine: m, resolutions: new Map(), types: new Map(), fieldTypes: new Map(), unhandled: [], patternLiterals: new Map(), effects: new Map(), strictParams: new Set(), timerKeys: new Set(), children: new Map(), childKeyDomains: new Map(), families: new Map(), detached: new Map(), decisions: new Map(), env: this.env };
    this.facts = facts;
    this.actions = new Map();

    if (m.version !== null) void 0; // `version N` is recorded; migrations were refused by the parser (PL0901)
    // PS15.0: an interface (a channel kind's Peer) has actions only: no state, no handler, no terminal.
    const iface = m.items.every((i) => i.kind === 'Action');
    if (m.fields.length === 0 && !iface) this.err('PL1201', m, `machine ${m.name} declares no state; the first field is its control field (PT4.4a)`);
    for (const f of m.fields) {
      if (facts.fieldTypes.has(f.name)) { this.err('PL1002', f, `field ${f.name} is declared twice`); continue; }
      const ty = this.tyOf(f.type);
      facts.fieldTypes.set(f.name, ty);
      // PS1.4b: an Items is a reference for one step's use: passed to a decision or an effect, never kept in the state.
      if (ty.k === 'items') this.err('PL1209', f, `an Items is passed, never stored: field ${f.name} (PS1.4b)`);
      if (f.flag) this.err('PL0901', f, `\`${f.flag}\` fields are not lowered in milestone M0`);
      this.checkDomain(f.name, f.type, ty, f.check, f);
      this.checkInit(f, ty);
    }

    const completionActions = new Set<string>();
    const wired = (body: A.Stmt[]): void => {
      for (const s of body) {
        if (s.kind === 'Intent' && s.op === 'spawn') { const i = s.extra.indexOf('complete'); if (i >= 0) completionActions.add(s.extra[i + 1]); }
        if (s.kind === 'If') { wired(s.then); wired(s.else ?? []); }
        if (s.kind === 'Match') for (const a of s.arms) wired(a.body);
        if (s.kind === 'For') wired(s.body);
      }
    };
    for (const it of m.items) if (it.kind === 'Handler') wired(it.body);
    for (const it of m.items) {
      if (it.kind !== 'Action') continue;
      if (this.actions.has(it.name)) { this.err('PL1002', it, `action ${it.name} is declared twice`); continue; }
      this.actions.set(it.name, it);
      const pnames = new Set<string>();
      for (const p of it.params) {
        if (pnames.has(p.name)) this.err('PL1002', p, `parameter ${p.name} is declared twice`);
        pnames.add(p.name);
        // S51: a completion's childKey takes its domain from the keys wired to that action.
        if (p.name === 'childKey' && p.type.kind === 'TString' && !p.check && completionActions.has(it.name)) continue;
        this.checkDomain(`${it.name}.${p.name}`, p.type, this.tyOf(p.type), p.check, p);
      }
    }

    // Effects are declared before the handlers that emit them are checked.
    for (const it of m.items) {
      if (it.kind !== 'EffectDecl') continue;
      if (facts.effects.has(it.name)) { this.err('PL1002', it, `effect ${it.name} is declared twice`); continue; }
      facts.effects.set(it.name, it);
    }
    for (const it of m.items) {
      if (it.kind !== 'Decision') continue;
      if (facts.decisions.has(it.name)) { this.err('PL1002', it, `decision ${it.name} is declared twice`); continue; }
      facts.decisions.set(it.name, it);
    }
    // PD1.7: a decision is an effect of kind decision.<name>. PD2.4: its adjudication is one of kind outcome.<name>,
    // which a path property may name (review D6).
    const kinds = new Set([...[...facts.effects.values()].map(effectKind), ...[...facts.decisions.keys()].flatMap((d) => [`decision.${d}`, `outcome.${d}`])]);
    // M4 review D1: decision.* and outcome.* are the toolchain's own kinds (PD1.7, PD2.4); an effect declaring one
    // would share a manifest entry, or pose as a decision or an adjudication.
    for (const e of facts.effects.values()) {
      const k = effectKind(e);
      if (k.startsWith('decision.') || k.startsWith('outcome.')) this.err('PL1208', e, `effect ${e.name} has kind "${k}": the prefixes decision. and outcome. are reserved for the kinds the toolchain generates (PD1.7, PD2.4)`);
      // Review D-F8 (M8b): channel.<c>.send is a channel's send, which the runtime runs through the channel's certified
      // adapter to the thread's address; only the expansion writes it, on the conversation's effect send (PS15.1).
      const generated = e.items.some((it) => it.kind === 'EffKind' && (it as { generated?: string }).generated === 'channel');
      if (/^channel\.[^.]+\.send$/.test(k) && !generated) this.err('PL1208', e, `effect ${e.name} has kind "${k}": channel.<c>.send is reserved for a channel's conversation, which the expansion writes (PS15.1, S182)`);
      // Merge review F3 (PT10r): route.<r>.call is a route's tier, which only the route's generated module writes.
      const routed = e.items.some((it) => it.kind === 'EffKind' && (it as { generated?: string }).generated === 'route');
      if (/^route\.[^.]+\.call$/.test(k) && !routed) this.err('PL1208', e, `effect ${e.name} has kind "${k}": route.<r>.call is reserved for a route's tier, which its generated module writes (PT10r, PS18.1)`);
    }
    // PT6.3: timer keys are declared by use, so every `after` of the machine is read before any `cancel`.
    // Keys are declared by their use (PT6.3, PT6.4); an indexed key k[i] declares the family k (S49).
    const loops: Loop[] = [];
    const collect = (body: A.Stmt[], action: A.Action | undefined): void => {
      for (const s of body) {
        if (s.kind === 'For') {
          const bound = this.loopBound(s, action);
          loops.push({ var: s.var, lo: s.lo, hi: bound ?? s.lo });
          collect(s.body, action);
          loops.pop();
          continue;
        }
        if (s.kind === 'If') { collect(s.then, action); collect(s.else ?? [], action); }
        if (s.kind === 'Match') for (const a of s.arms) collect(a.body, action);
        if (s.kind !== 'Intent' || !s.as) continue;
        if (s.op === 'spawn' && s.modifier === 'detached') {
          // S60: one key, one address <parent>/<k>; a family of detached children is not in M2.
          if (s.index) { this.err('PL0901', s, `spawn detached … as ${s.as}[…]: a family of detached children is checked from a later milestone (S60)`); continue; }
          const name = this.targetName(s.target);
          const prev = facts.detached.get(s.as);
          if (prev && prev !== name) this.err('PL1002', s, `child key ${s.as} names two children; one key names one child (PT6.4, S60)`);
          else facts.detached.set(s.as, name);
          continue;
        }
        if (s.op !== 'after' && !(s.op === 'spawn' && s.modifier !== 'detached')) continue;
        const range = s.index ? indexRange(s.index, loops) : null;
        if (s.index && !range) { this.err('PL1201', s.index, 'the index of a key is the loop variable, the loop variable plus or minus a constant, or a constant (S49)'); continue; }
        const keys = range ? keysOf(s.as, range) : [s.as];
        if (s.op === 'after') { for (const k of keys) facts.timerKeys.add(k); continue; }
        if (range) {
          const prev = facts.families.get(s.as);
          facts.families.set(s.as, prev ? { lo: Math.min(prev.lo, range.lo), hi: Math.max(prev.hi, range.hi) } : range);
        }
        for (const k of keys) {
          const spec = { ...childSpec(s, this.module.name), key: k };
          const prev = facts.children.get(k);
          if (prev && JSON.stringify(prev) !== JSON.stringify(spec)) this.err('PL1002', s, `child key ${k} is spawned as ${prev.machine} and as ${spec.machine}, or with different wiring; one key names one child (PT6.4)`);
          else facts.children.set(k, spec);
        }
      }
    };
    for (const it of m.items) if (it.kind === 'Handler') collect(it.body, this.actions.get(it.action));
    // PT6.4, S60: a key is attached or detached, never both, whatever the order of the handlers (review A7).
    for (const k of facts.detached.keys()) if (facts.children.has(k) || facts.families.has(k)) this.err('PL1002', m, `child key ${k} names an attached and a detached child; one key names one child (PT6.4, S60)`);
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
          this.reason(it);
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
          if (it.form === 'compose') { this.expectBool(it.expr, { ...this.scope('compose'), spawned: new Set() }); break; }
          if (it.form === 'path') { this.pathProperty(it, kinds); break; }
          this.expectBool(it.expr, this.scope(it.form === 'invariant' ? 'invariant' : it.form));
          break;
        }
        case 'NeverEmit':
          // PS5.2a, S178: a never shares the properties' names; its filter is emits', and while reads the pre-state.
          if (propNames.has(it.name)) this.err('PL1002', it, `property ${it.name} is declared twice`);
          propNames.add(it.name);
          this.emitsFilter(it, it.effect, it.fields);
          if (it.cond) this.neverCond(it.cond);
          break;
        case 'Liveness':
          if (propNames.has(it.name)) this.err('PL1002', it, `property ${it.name} is declared twice`);
          propNames.add(it.name);
          // M1-2: a liveness property is checked as far as M1 can (its names and types) and then listed as
          // not run by the pipeline, which folds the verdict to INCONCLUSIVE at best. It no longer refuses the program.
          if (it.from) this.expectBool(it.from, this.scope('invariant'));
          this.expectBool(it.expr, this.scope('invariant'));
          // S56: the fairness clause may be left out, and a quantifier written, only in a configuration.
          if (!it.fair) this.err('PL1201', it, `liveness ${it.name} of a machine states its fairness: under fair { … } (PS6)`);
          if (it.quant) this.err('PL1201', it, `${it.quant.q} ${it.quant.var} in ${it.quant.group}: ranges over a group of a configuration, not over a machine's property (PS13.6)`);
          for (const g of it.fair ?? []) {
            for (const m of g.members) {
              if (m.input) this.err('PL1201', g, `${m.input.instance}.${m.action} names an instance, which only a configuration has (S73)`);
              else if (!this.actions.has(m.action)) this.err('PL1001', g, `fairness names ${m.action}, which is not an action of ${this.machine!.name}`);
            }
          }
          break;
        case 'EffectDecl':
          this.effectDecl(it, handlerOf);
          break;
        case 'Decision':
          this.decisionDecl(it, handlerOf);
          break;
      }
    }
    this.confUses(m, facts);
    facts.unhandled = [...this.actions.keys()].filter((a) => !handled.has(a));
    // S53: an action with no handler is not in the lowered module (S35), so a strict check on it never runs.
    for (const a of facts.unhandled) {
      for (const p of this.actions.get(a)!.params) {
        if (p.check?.mode === 'strict') this.err('PL1302', p.check, `${a}.${p.name} is strict, and ${a} has no handler, so the runtime answers it unhandled and never checks the domain; remove strict or add a handler (S53)`);
      }
    }
    this.strictFlow(m, facts);
    // PS17.3a (S459): an envelope reaches an emit only from an envelope retrieval.
    this.envelopeOrigins(m, facts);
    this.machine = null;
    return facts;
  }

  /**
   * PS17.3a (S459): the envelope rule, static. In every emit of an effect with `envelope e`, the argument for e is
   * none, a parameter of the emitting action that an envelope retrieval's ok outcome binds from r.envelope (an envelope
   * slot), or a field every write of which, in every handler, is such a parameter or none; each passed as a bare name.
   * Any other origin (a decision's answer, a body from a channel, an input's parameter, a computed value) is PL6830.
   * A slot is A.p only when every other delivery of A this machine writes (another completion, a timer) gives p none:
   * a decision's answer bound to the same parameter would choose the recipient (PS17.3a). The run-time origin check
   * holds the rest, the digest being one the runtime stored as an envelope (PT10j).
   */
  private envelopeOrigins(m: A.Machine, facts: MachineFacts): void {
    // An envelope that names no Content parameter is PL1001 or PL1201 at the effect, and no origin is read for it.
    const enveloped = [...facts.effects.values()].filter((e) => e.items.some((x) => x.kind === 'EffEnvelope' && e.params.some((p) => p.name === x.param && this.tyOf(p.type).k === 'content')));
    if (!enveloped.length) return;
    const isNone = (v: A.Expr) => v.kind === 'Name' && facts.resolutions.get(v.id)?.k === 'none';
    // The slots, and the parameters some other delivery of the same action gives a value other than none.
    const slots = new Set<string>();
    const other = new Set<string>();
    const outcomes = (items: readonly { kind: string }[], envelopeRetrieval: boolean) => {
      for (const it of items) {
        if (it.kind !== 'EffOutcome') continue;
        const o = it as A.EffOutcomeItem;
        for (const arg of o.args) {
          if (arg.name === null) continue;
          const path = o.bind !== undefined ? boundPath(arg.value, o.bind) : null;
          if (envelopeRetrieval && o.outcome === 'ok' && path && path.length === 1 && path[0] === 'envelope') slots.add(`${o.action}.${arg.name}`);
          else if (!isNone(arg.value)) other.add(`${o.action}.${arg.name}`);
        }
      }
    };
    for (const e of facts.effects.values()) outcomes(e.items, e.items.some((x) => x.kind === 'EffRetrieve' && x.envelope === true));
    for (const d of facts.decisions.values()) outcomes(d.items, false);
    const handlers = m.items.filter((h): h is A.Handler => h.kind === 'Handler');
    const walk = (body: A.Stmt[], f: (st: A.Stmt) => void): void => {
      for (const st of body) {
        f(st);
        if (st.kind === 'If') { walk(st.then, f); walk(st.else ?? [], f); }
        if (st.kind === 'Match') for (const arm of st.arms) walk(arm.body, f);
        if (st.kind === 'For') walk(st.body, f);
      }
    };
    // A timer (`after`) or a send of this machine to one of its own actions is another delivery of that action.
    for (const h of handlers) walk(h.body, (st) => {
      if (st.kind !== 'Intent' || (st.op !== 'after' && !(st.op === 'send' && st.to?.kind === 'Name' && facts.resolutions.get(st.to.id)?.k === 'self'))) return;
      const act = this.actions.get(st.target);
      if (!act) return;
      st.args.forEach((arg, i) => { const name = arg.name ?? act.params[i]?.name; if (name && !isNone(arg.value)) other.add(`${st.target}.${name}`); });
    });
    const isSlot = (action: string, param: string) => slots.has(`${action}.${param}`) && !other.has(`${action}.${param}`);
    // A field qualifies when every write of it is a slot of the writing action, passed as a bare name, or none.
    const fieldOk = new Map(m.fields.map((f) => [f.name, true]));
    for (const h of handlers) walk(h.body, (st) => {
      if (st.kind === 'MapUpdate') fieldOk.set(st.field, false);
      if (st.kind !== 'Assign' || !fieldOk.has(st.field)) return;
      const r = st.expr.kind === 'Name' ? facts.resolutions.get(st.expr.id) : undefined;
      if (!(isNone(st.expr) || (r?.k === 'param' && isSlot(h.action, r.name)))) fieldOk.set(st.field, false);
    });
    for (const h of handlers) walk(h.body, (st) => {
      if (st.kind !== 'Intent' || st.op !== 'emit') return;
      const eff = facts.effects.get(st.target);
      const env = eff?.items.find((x): x is A.EffectItem & { kind: 'EffEnvelope'; param: string } => x.kind === 'EffEnvelope');
      if (!eff || !env) return;
      const positional = st.args.every((x) => x.name === null);
      const arg = positional ? st.args[eff.params.findIndex((x) => x.name === env.param)] : st.args.find((x) => x.name === env.param);
      // A missing argument is the arity check's (PL1201).
      if (!arg) return;
      const v = arg.value;
      if (isNone(v)) return;
      const r = v.kind === 'Name' ? facts.resolutions.get(v.id) : v.kind === 'Member' && v.object.kind === 'Name' && facts.resolutions.get(v.object.id)?.k === 'pre' ? { k: 'field' as const, name: v.prop } : undefined;
      if (r?.k === 'param' && isSlot(h.action, r.name)) return;
      if (r?.k === 'field' && fieldOk.get(r.name)) return;
      const why = r?.k === 'param'
        ? (slots.has(`${h.action}.${r.name}`) ? `${h.action}.${r.name}, which another delivery of ${h.action} also gives` : `${h.action}.${r.name}, which no envelope retrieval binds from r.envelope`)
        : r?.k === 'field' ? `field ${r.name}, which some handler writes with a value that is not an envelope a retrieval gave` : 'a value computed here, not an envelope a retrieval gave';
      this.err('PL6830', v, `emit ${eff.name} passes ${why} as its envelope ${env.param}; the envelope comes from the source only, through an envelope retrieval's r.envelope passed unchanged, or none (PS17.3a)`);
    });
  }

  // ── effects (PT6.1, PT6.2, PT3.4a) ─────────────────────────────────────
  private effectDecl(e: A.EffectDecl, handlers: Set<string>): void {
    const pnames = new Set<string>();
    for (const p of e.params) {
      if (pnames.has(p.name)) this.err('PL1002', p, `parameter ${p.name} is declared twice`);
      pnames.add(p.name);
      const ty = this.tyOf(p.type);
      // A payload is plain JSON (PT6.1); maps and payload unions are lowered from plan step 10, as for action parameters.
      if (this.holds(ty, (x) => x.k === 'map' || x.k === 'ref' || (x.k === 'union' && !this.env.unions.get(x.name)!.isEnum))) this.err('PL0901', p, `an effect parameter of type ${tyToString(ty)} is lowered after milestone M1: an intent carries no type from which poly-ref could read it back (S65)`);
      if (p.check) this.err('PL1201', p.check, 'an effect parameter takes its value from the handler; it has no check domain');
    }
    const seen = new Set<string>();
    let labelled = false;
    const targets: (A.EffectItem & { kind: 'EffTargets' })[] = [];
    const uses: A.EffUses[] = [];
    const retrieve = e.items.find((x): x is A.EffRetrieve => x.kind === 'EffRetrieve') ?? null;
    const remember = e.items.find((x): x is A.EffRemember => x.kind === 'EffRemember') ?? null;
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
        case 'EffTargets':
          targets.push(it);
          break;
        case 'EffUses':
          uses.push(it);
          break;
        case 'EffTo': {
          // PS17.3: the recipient is a Principal parameter of the effect.
          const p = e.params.find((x) => x.name === it.param);
          if (!p) this.err('PL1001', it, `effect ${e.name} has no parameter ${it.param} to name its recipient`);
          else if (this.tyOf(p.type).k !== 'principal') this.err('PL1201', it, `the recipient ${it.param} is ${tyToString(this.tyOf(p.type))}; it is a Principal parameter of the effect (PS17.3)`);
          break;
        }
        case 'EffAudience':
          this.audienceClass(it.cls, it, `effect ${e.name}`);
          break;
        case 'EffEnvelope': {
          // PS17.3a, S459: the envelope is a Content parameter of the effect; written once, by the PL1002 above.
          const p = e.params.find((x) => x.name === it.param);
          if (!p) this.err('PL1001', it, `effect ${e.name} has no parameter ${it.param} to give its envelope`);
          else if (this.tyOf(p.type).k !== 'content') this.err('PL1201', it, `the envelope ${it.param} is ${tyToString(this.tyOf(p.type))}; it is a Content parameter of the effect (PS17.3a)`);
          break;
        }
        case 'EffRetry':
          if (it.attempts < 1) this.err('PL1201', it, 'retry needs at least one attempt');
          for (const d of [it.base, it.timeout]) if (durationMs(d) === null) this.err('PL1201', it, `${d} is not a duration`);
          break;
        case 'EffOutcome':
          // PS17.2: a retrieval's ok(r) binds r.items, an Items; an envelope retrieval's binds r.envelope, a Content (S459).
          this.completion(it, handlers, retrieve && it.outcome === 'ok' ? (retrieve.envelope ? (path) => (path.length === 1 && path[0] === 'envelope' ? { k: 'content' } : null) : (path) => (path.length === 1 && path[0] === 'items' ? { k: 'items' } : null)) : null);
          break;
        default:
          break;
      }
    }
    if (retrieve || remember) this.memoryEffect(e, retrieve, remember);
    // PS17.2: a retrieval's and a remember's labels are the runtime's.
    if (!labelled && !retrieve && !remember) this.err('PL6301', e, `effect ${e.name} has no labels (PT6.2)`);
    const labels = new Set(e.items.flatMap((x) => (x.kind === 'EffLabels' ? x.labels : [])));
    for (const t of targets) this.targets(e, t, labels);
    for (const u of uses) this.usesCredential(e, u, targets);
    // polyrun reads timer, cancelTimer, spawnChild and signalChild before its manifest, and PT7a adds sendTo (review finding L3).
    const kind = effectKind(e);
    if (KERNEL_KINDS.has(kind)) this.err('PL1201', e, `effect ${e.name} has kind "${kind}", which is the kernel's own intent kind; choose another (PT6.1)`);
  }

  /** A constant expression (S67): literals, constructors, none, and records, maps, payloads and arithmetic over them. */
  private constant(e: A.Expr): boolean {
    const r = this.facts?.resolutions.get(e.id);
    switch (e.kind) {
      case 'Int': case 'Bool': case 'String': return true;
      case 'Name': return r?.k === 'ctor' || r?.k === 'none';
      case 'Member': return r?.k === 'ctor';
      case 'Unary': return this.constant(e.arg);
      case 'Binary': return this.constant(e.left) && this.constant(e.right);
      case 'CtorExpr': return e.fields.every((x) => this.constant(x.value));
      case 'MapLit': return e.entries.every((x) => this.constant(x.value) && (x.key.kind === 'Name' || this.constant(x.key)));
      case 'ArrayLit': return e.items.every((x) => this.constant(x));
      default: return false;
    }
  }

  /** Whether a type is, or holds through record fields, a type the predicate names (S25, S65). */
  private holds(t: Ty, p: (x: Ty) => boolean, seen: Set<string> = new Set()): boolean {
    if (p(t)) return true;
    // Review C-F1: through a map's values too, so a map of Content in a record field or payload is found.
    if (t.k === 'map') return this.holds(t.value, p, seen);
    if (t.k !== 'record' || seen.has(t.name)) return false;
    seen.add(t.name);
    return this.env.records.get(t.name)!.fields.some((f) => this.holds(this.tyOf(f.type), p, seen));
  }

  /** `ok -> A(p: v)`: a completion is an ordinary action (PS4.4) whose data the manifest carries as constants (PT6.1). */
  /**
   * PT6.5, S151: each target names a capability one of the effect's labels grants (PL6303). An egress target is an
   * absolute http or https prefix with no user, query or fragment, since the runtime matches the normalised URL's
   * origin and path against it; a secret name, a command and a table are non-empty strings.
   */
  private targets(e: A.EffectDecl, t: A.EffTargets, labels: Set<string>): void {
    const keys = new Set<string>();
    for (const { key, values } of t.targets) {
      if (keys.has(key)) { this.err('PL1002', t, `effect ${e.name} states the ${key} targets twice`); continue; }
      keys.add(key);
      const grants = GRANTS[key];
      if (!grants) { this.err('PL1001', t, `${key} is not a kind of target: egress, secrets, exec or store (PT6.5)`); continue; }
      if (!grants.some((l) => labels.has(l))) this.err('PL6303', t, `effect ${e.name} declares ${key} targets, and none of its labels grants them: ${grants.join(' or ')} (PT6.5)`);
      for (const tv of values) {
        // S455: `exact "<url>"` is allowed on egress only, and its URL is written as a prefix is.
        if (typeof tv !== 'string' && key !== 'egress') { this.err('PL1201', t, `exact ${JSON.stringify(tv.exact)}: an exact target is an egress URL, and ${key} targets are names (S455)`); continue; }
        const v = typeof tv === 'string' ? tv : tv.exact;
        if (!v.length) { this.err('PL1201', t, `an empty ${key} target`); continue; }
        if (key !== 'egress') continue;
        let u: URL | null = null;
        try { u = new URL(v); } catch { u = null; }
        if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash || v.includes('?') || v.includes('#')) this.err('PL1201', t, `${JSON.stringify(v)} is not an egress prefix: an absolute http or https URL with no user, query or fragment (S151)`);
        // Review D3: the prefix the runtime binds is the parsed URL, so the text must be that form already: no dot
        // segments, backslashes, encoded separators, upper-case host or default port that parsing would rewrite.
        // Review D-F2: a glob character would widen the sandbox, which reads host and path as patterns.
        else if (/[*?[\]{}]/.test(u.hostname + u.pathname)) this.err('PL1201', t, `${JSON.stringify(v)} holds a glob character (* ? [ ] { }), which the sandbox would read as a pattern (S152)`);
        else if (u.href !== v || /%2e|%2f|%5c/i.test(u.pathname)) this.err('PL1201', t, `${JSON.stringify(v)} is not written in its normalised form${u.href !== v ? ` (${JSON.stringify(u.href)})` : ''}; an egress prefix is bound as parsed, so it is written as parsed, with no encoded dot or separator (S151)`);
      }
    }
  }

  private completion(it: A.EffOutcomeItem, handlers: Set<string>, bound: ((path: string[]) => Ty | null) | null = null): void {
    const act = this.actions.get(it.action);
    if (!act) { this.err('PL1001', it, `${it.outcome} -> ${it.action}: no action ${it.action}`); return; }
    // S40: polyrun refuses a manifest whose completion action is outside the lowered action surface (S35).
    if (!handlers.has(it.action)) this.err('PL6101', it, `completion action ${it.action} has no handler, so it is not in the lowered module and the runtime cannot deliver it; add a handler for ${it.action} (S40)`);
    const given = new Set<string>();
    for (const a of it.args) {
      if (a.name === null) { this.err('PL1201', a.value, `a completion names its arguments: ${it.action}(p: value)`); continue; }
      const p = act.params.find((x) => x.name === a.name);
      if (!p) { this.err('PL1001', a.value, `${it.action} has no parameter ${a.name}`); continue; }
      if (given.has(a.name)) this.err('PL1002', a.value, `${a.name} is given twice`);
      given.add(a.name);
      const pt = this.tyOf(p.type);
      // PD1.2b, S79: `ok(r) -> A(p: r.x)` binds the handler's result; p is strict by default (PD1.4a).
      const path = it.bind !== undefined ? boundPath(a.value, it.bind) : null;
      if (path) {
        const bt = bound ? bound(path) : pt;
        if (!bt) { this.err('PL1001', a.value, `${[it.bind, ...path].join('.')} is not part of the reply: r.answer, r.conf or r.margin (PD1.2b)`); continue; }
        if (!same(bt, pt) || (bt.k === 'conf') !== (pt.k === 'conf')) { this.err('PL1201', p, `${it.action}.${a.name} is ${tyToString(pt)}, and ${[it.bind, ...path].join('.')} is ${tyToString(bt)} (PD1.2f)`); continue; }
        if (pt.k === 'conf' && p.check) this.err('PL1201', p.check, `a Conf takes no check clause: it is explored by the intervals the program uses (PD1.4b)`);
        // PS4.1f, S180: a Content has no check domain; its representatives are the check's, never a run-time domain.
        // Probe reviewer A, F1: nor a Principal, a Ref or a type holding one, which has no dispatch row (PT3.4a).
        if (p.check?.mode !== 'disclosed' && this.hasCheckDomain(act, p)) this.facts!.strictParams.add(`${it.action}.${a.name}`);
        continue;
      }
      const t = this.typeOf(a.value, this.scope('init'), pt);
      if (!same(t, pt)) { this.err(opaqueCode(t, pt), a.value, `${it.action}.${a.name} is ${tyToString(pt)}, and the value is ${tyToString(t)}`); continue; }
      // S67: any constant of a finite type, structured ones included; a field or a parameter is not one.
      if (!this.constant(a.value)) this.err('PL1201', a.value, 'a completion argument is a constant, since a manifest cannot compute: not a field, a parameter or a local (PT6.1, S67)');
      else this.checkConst(a.value, pt, p.check, `${it.action}.${a.name}`);
    }
  }

  /**
   * S78: a detached child's address exists only when the step that creates it commits, so in that handler `k` is
   * stored whole, sent to, or passed whole as an argument; any other use, such as a comparison, would read a
   * value the lowered step does not have yet (review B5).
   */
  private childAddressUses(body: A.Stmt[]): void {
    const isChild = (e: A.Expr | null) => !!e && e.kind === 'Name' && this.facts!.resolutions.get(e.id)?.k === 'child';
    const visit = (n: unknown, whole: boolean): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach((x) => visit(x, false)); return; }
      const o = n as A.Expr;
      if (isChild(o)) { if (!whole) this.err('PL0901', o, `${(o as A.NameRef).name} is a detached child's address, which is known only when this step commits: store it, send to it or pass it on (S78)`); return; }
      const s = n as A.Stmt;
      if (s.kind === 'Assign') { visit(s.expr, true); return; }
      if (s.kind === 'Intent') {
        visit(s.to, true);
        for (const a of s.args) visit(a.value, true);
        visit(s.index, false);
        return;
      }
      for (const [k, v] of Object.entries(o)) if (k !== 'span' && k !== 'id') visit(v, false);
    };
    visit(body, false);
  }

  /** `decide d(args)` (PD1.2): asks a declared decision, typed against its parameters. */
  private decide(s: A.IntentStmt, scope: Scope): void {
    const d = this.facts!.decisions.get(s.target);
    if (!d) { this.err('PL1001', s, `${s.target} is not a declared decision`); for (const a of s.args) this.typeOf(a.value, scope); return; }
    this.intentArgs(s, d.params, `decision ${d.name}`, scope);
  }

  /** `decision d(params) -> R { … }` (PD1.2, PD1.2a to PD1.2d, S76). */
  private decisionDecl(d: A.Decision, handlers: Set<string>): void {
    // S75 judges the completion step and its cascade; poly-ref judges it on the machine's own graph in M2.
    if (this.facts!.children.size) this.err('PL0901', d, `decision ${d.name} is in a machine with attached children, whose cascade PL6201 would have to follow; checked from a later milestone (S75)`);
    const pnames = new Set<string>();
    for (const p of d.params) {
      if (pnames.has(p.name)) this.err('PL1002', p, `parameter ${p.name} is declared twice`);
      pnames.add(p.name);
      const ty = this.tyOf(p.type);
      if (ty.k === 'conf' || this.holds(ty, (x) => x.k === 'map' || x.k === 'ref' || (x.k === 'union' && !this.env.unions.get(x.name)!.isEnum))) this.err('PL0901', p, `a decision parameter of type ${tyToString(ty)} is not lowered in M2`);
      // S180: a decision that reads a body comes with the channels (M8b), not in M8a.
      if (p.check) this.err('PL1201', p.check, 'a decision parameter takes its value from the handler; it has no check domain');
    }
    // PD1.2a: a finite result: an enum, a range, Tri, or a record of these.
    const result = this.tyOf(d.result);
    const finite = (t: Ty): boolean => (t.k === 'union' && this.env.unions.get(t.name)!.isEnum) || (t.k === 'int' && Number.isFinite(t.lo) && Number.isFinite(t.hi));
    const recordOk = result.k === 'record' && this.env.records.get(result.name)!.fields.every((f) => finite(this.tyOf(f.type)));
    // PS17.2 (M10): an answer that is a body, a Content, explored by its representatives with its taint.
    if (result.k !== 'error' && result.k !== 'content' && !finite(result) && !recordOk) this.err('PL1101', d.result, `a decision's result is finite: an enum, a range, Tri, or a record of these, or a Content, not ${tyToString(result)} (PD1.2a, PS17.2)`);
    // PS17.6, S304: `cites x`, x an Items parameter of the decision.
    const cites = d.items.find((x): x is A.DecisionItem & { kind: 'DecCites'; param: string } => x.kind === 'DecCites');
    if (cites) {
      const p = d.params.find((x) => x.name === cites.param);
      if (!p) this.err('PL1001', cites, `decision ${d.name} has no parameter ${cites.param} to cite`);
      else if (this.tyOf(p.type).k !== 'items') this.err('PL1201', cites, `decision ${d.name} cites ${cites.param}, which is ${tyToString(this.tyOf(p.type))}; it cites an Items parameter (PS17.6)`);
    }
    const tri = result.k === 'union' && result.name === 'Tri';
    const seen = new Set<string>();
    let labelled = false;
    for (const it of d.items) {
      const key = it.kind === 'EffOutcome' ? it.outcome : it.kind;
      if (seen.has(key)) this.err('PL1002', it, `decision ${d.name} states ${key.replace(/^Dec|^Eff/, '').toLowerCase()} twice`);
      seen.add(key);
      if (it.kind === 'EffLabels') { labelled = true; for (const l of it.labels) if (!LABELS.has(l)) this.err('PL1001', it, `${l} is not a label of the closed vocabulary (PT6.2)`); }
      if (it.kind === 'DecTimeout' && durationMs(it.value) === null) this.err('PL1201', it, `${it.value} is not a duration`);
      // PT24.1c, PS18.2: a routed decision's tiers name their providers, and its one confidence is what the route reads.
      if (it.kind === 'DecRoute') {
        if (!this.module.decls.some((x) => x.kind === 'Route' && x.name === it.route)) this.err('PL1001', it, `decision ${d.name} names route ${it.route}, which the module does not declare`);
        if (d.items.some((x) => x.kind === 'DecProvider')) this.err('PL1201', it, `decision ${d.name} names its route, so its tiers name the providers, and it names no provider (PT24.1c)`);
        if (result.k === 'record') this.err('PL1201', it, `decision ${d.name} returns a record, with a confidence per field; a routed decision has one answer and one confidence for its route to read (PS18.1)`);
        // PS18.2, F1 as ruled: a route's tiers get no materials, keep no Content answer with its taint and check no
        // citation, so a routed decision reads no body and no item set, answers no body and cites nothing (S402 lifts the parameters in v1).
        // S402: a routed decision reads Content and Items; its tiers are given the decision's materials (PS18.2).
        if (result.k === 'content') this.err('PL6839', d.result, `decision ${d.name} names route ${it.route}, and its result is a Content; a routed decision answers a finite value, since no tier's answer is kept with its taint (PS18.2)`);
        if (cites) this.err('PL6839', cites, `decision ${d.name} names route ${it.route}, and cites ${cites.param}; a routed decision cites nothing, since no tier's citations are checked (PS18.2)`);
      }
      if (it.kind === 'DecBand') {
        if (!tri) this.err('PL1201', it, `band belongs to a decision whose result is Tri (PD1.2d)`);
        else if (!(it.lo < it.hi && it.hi <= 1000)) this.err('PL1201', it, `a band is lo..hi with 0 <= lo < hi <= 1 (PD1.2d)`);
      }
      if (it.kind === 'EffOutcome') {
        if (it.outcome === 'exhausted') { this.err('PL1201', it, 'a decision is tried once: its completions are ok and failed (PD1.7)'); continue; }
        this.completion(it, handlers, it.outcome === 'ok' ? (path) => (cites && path.length === 1 && path[0] === 'cites' ? { k: 'items' } : this.replyType(result, path)) : null);
      }
    }
    if (tri && !seen.has('DecBand')) this.err('PL1201', d, `decision ${d.name} returns Tri, so it declares its band: band lo..hi (PD1.2d)`);
    if (!labelled) this.err('PL6301', d, `decision ${d.name} has no labels (PT6.2)`);
    // PD1.2c: a machine waiting on a dead provider can wait forever.
    if (!seen.has('DecTimeout') || !seen.has('failed')) this.err('PL6202', d, `decision ${d.name} has no ${!seen.has('DecTimeout') ? 'timeout' : 'failed completion'}; a machine waiting on a dead provider could wait forever (PD1.2c)`);
  }

  /** PD1.2b: the type of `r.answer`, `r.conf`, `r.margin`, and of their fields for a record result. */
  private replyType(result: Ty, path: string[]): Ty | null {
    const [head, field, ...rest] = path;
    if (rest.length) return null;
    const rec = result.k === 'record' ? this.env.records.get(result.name)! : null;
    if (field !== undefined && (!rec || !rec.fields.some((f) => f.name === field))) return null;
    if (head === 'answer') return field === undefined ? result : this.tyOf(rec!.fields.find((f) => f.name === field)!.type);
    if (head === 'conf' || head === 'margin') return rec && field === undefined ? null : { k: 'conf' };
    return null;
  }

  /** PD1.3b: a Conf is compared with a constant in [0, 1], never with a field, a parameter or another Conf. */
  private confCompare(e: A.Binary, l: Ty, r: Ty): Ty {
    const constant = (x: A.Expr) => x.kind === 'Decimal' || (x.kind === 'Int' && (x.value === 0 || x.value === 1));
    const [q, c, ct] = constant(e.right) && !constant(e.left) ? [e.left, e.right, r] : constant(e.left) && !constant(e.right) ? [e.right, e.left, l] : [null, null, null];
    if (!q || !c) { if (l.k !== 'error' && r.k !== 'error') this.err('PL1205', e, `a Conf is compared with a constant in [0, 1], not with ${constant(e.left) ? 'another constant' : 'a field, a parameter or another Conf'} (PD1.3b)`); return BOOL; }
    const qt = q === e.left ? l : r;
    if (qt.k !== 'conf') return BOOL; // a decimal beside a non-Conf is PL1201, reported once by confUses (S76)
    if (c.kind === 'Decimal' && c.value > 1000) this.err('PL1201', c, 'a Conf constant is in [0, 1] (PD1.3a)');
    void ct;
    return BOOL;
  }

  /**
   * PD1.3b and S76, after typing: a Conf may only be an operand of a comparison, and a decimal only the
   * constant a Conf is compared with. Anything else is PL1205, or PL1201 for a decimal.
   */
  private confUses(m: A.Machine, facts: MachineFacts): void {
    const cmp = new Set(['==', '!=', '<', '<=', '>', '>=']);
    const visit = (n: unknown, parent: unknown): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach((x) => visit(x, parent)); return; }
      const o = n as A.Expr;
      // Arithmetic on a Conf: one PL1205 at the operation, however many Conf operands it has.
      if (o.kind === 'Binary' && !cmp.has(o.op) && o.op !== '&&' && o.op !== '||' && o.op !== 'implies' && [o.left, o.right].some((x) => x.kind !== 'Decimal' && facts.types.get(x.id)?.k === 'conf')) {
        this.err('PL1205', o, 'a Conf may only be compared with a constant: no arithmetic on it (PD1.3b)');
        return;
      }
      const pb = parent as A.Binary | null;
      const inCompare = !!pb && (pb as { kind?: string }).kind === 'Binary' && cmp.has(pb.op);
      if (o.kind === 'Decimal') {
        const other = inCompare ? (pb!.left === o ? pb!.right : pb!.left) : null;
        if (!other || facts.types.get(other.id)?.k !== 'conf') this.err('PL1201', o, 'a decimal literal is legal only as the constant a Conf is compared with (S76)');
      } else if (typeof (o as { kind?: unknown }).kind === 'string' && facts.types.get((o as A.NodeBase).id)?.k === 'conf' && !inCompare) {
        this.err('PL1205', o, 'a Conf may only be compared with a constant or passed as a completion argument: no arithmetic, no write, no other use (PD1.3b)');
        return;
      }
      for (const [k, v] of Object.entries(o)) if (k !== 'span' && k !== 'id') visit(v, o);
    };
    for (const f of m.fields) {
      if (hasConf(f.type)) { this.err('PL1205', f, `${f.name} holds a Conf, and a state field cannot hold one (PD1.3b)`); continue; }
      visit(f.init, null);
    }
    // PD1.4b: a Conf quantity is a completion parameter bound from a reply, `ok(r) -> A(p: r.conf)`; the checker
    // explores it by the intervals the program uses, so a Conf anywhere else has no domain (review A4, A5).
    const bound = new Set<string>();
    for (const it of m.items) {
      if (it.kind !== 'EffectDecl' && it.kind !== 'Decision') continue;
      for (const o of it.items) if (o.kind === 'EffOutcome' && o.bind !== undefined) for (const a of o.args) if (boundPath(a.value, o.bind)) bound.add(`${o.action}.${a.name}`);
    }
    for (const it of m.items) {
      if (it.kind === 'Action') {
        for (const p of it.params) {
          if (p.type.kind === 'TConf' ? !bound.has(`${it.name}.${p.name}`) : hasConf(p.type)) this.err('PL1205', p, `${it.name}.${p.name} is a Conf, and a Conf is only a completion parameter bound from a reply: ok(r) -> ${it.name}(${p.name}: r.conf) (PD1.3b, PD1.4b)`);
        }
        continue;
      }
      if (it.kind === 'Decision') {
        for (const p of it.params) if (hasConf(p.type)) this.err('PL1205', p, 'a decision parameter cannot carry a Conf (PD1.3b)');
        if (hasConf(it.result)) this.err('PL1205', it.result, 'a decision answers a finite value; its confidence is r.conf (PD1.2b)');
        continue;
      }
      if (it.kind === 'EffectDecl') { for (const p of it.params) if (hasConf(p.type)) this.err('PL1205', p, 'an effect payload cannot carry a Conf (PD1.3b)'); continue; }
      visit(it, null);
    }
  }

  /**
   * S52, S81: the runtime delivers a child's completion itself and refuses it from outside (K9, S80), so an
   * action that is also an effect completion or a timer's action would be refused when the effect or the timer
   * delivers it. PL6102, at whichever wiring comes second. A parent-terminal cancel is accepted from outside.
   */
  private sharedCompletions(machines: Map<string, MachineFacts>): void {
    const kernel = new Map<string, Map<string, A.NodeBase>>(); // machine -> action -> spawn that wires it
    const external = new Map<string, Map<string, A.NodeBase>>(); // machine -> action -> outcome or after
    const add = (m: Map<string, Map<string, A.NodeBase>>, machine: string, action: string, at: A.NodeBase) => {
      const byAction = m.get(machine) ?? new Map<string, A.NodeBase>();
      if (!byAction.has(action)) byAction.set(action, at);
      m.set(machine, byAction);
    };
    const walk = (body: A.Stmt[], f: (s: A.Stmt) => void): void => {
      for (const s of body) {
        f(s);
        if (s.kind === 'If') { walk(s.then, f); walk(s.else ?? [], f); }
        if (s.kind === 'Match') for (const a of s.arms) walk(a.body, f);
        if (s.kind === 'For') walk(s.body, f);
      }
    };
    for (const facts of machines.values()) {
      const m = facts.machine;
      for (const it of m.items) {
        if (it.kind === 'EffectDecl') for (const o of it.items) if (o.kind === 'EffOutcome') add(external, m.name, o.action, o);
        if (it.kind !== 'Handler') continue;
        walk(it.body, (s) => {
          if (s.kind !== 'Intent') return;
          if (s.op === 'after') add(external, m.name, s.target, s);
          if (s.op === 'spawn' && s.modifier !== 'detached') {
            const spec = childSpec(s, this.module.name);
            if (spec.onComplete) add(kernel, m.name, spec.onComplete, s);
          }
        });
      }
    }
    const later = (a: A.NodeBase, b: A.NodeBase) => ((a.span?.line ?? 0) > (b.span?.line ?? 0) || ((a.span?.line ?? 0) === (b.span?.line ?? 0) && (a.span?.col ?? 0) >= (b.span?.col ?? 0)) ? a : b);
    for (const [machine, byAction] of kernel) {
      for (const [action, wiredBy] of byAction) {
        const other = external.get(machine)?.get(action);
        if (!other) continue;
        this.machine = machines.get(machine)?.machine ?? null;
        this.err('PL6102', later(wiredBy, other), `${machine}.${action} is delivered by the runtime as a child's completion, and also by an effect or a timer, which the runtime would then refuse (S52, S81, K9)`);
      }
    }
    this.machine = null;
  }

  /**
   * The machine a spawn names: one of this module (S28), or, for a detached spawn, a used module's as m.M (S176). An
   * attached child is checked as one cascade with its parent (PT7), so an attached spawn of another module's machine
   * stays PL0901.
   */
  private childMachine(s: A.IntentStmt): A.Machine | null {
    const parts = s.target.split('.');
    const mod = parts.length > 1 ? parts.slice(0, -1).join('.') : this.module.name;
    if (mod !== this.module.name && s.modifier !== 'detached') { this.err('PL0901', s, `an attached spawn of another module's machine (${s.target}) is checked from a later milestone: an attached child is one cascade with its parent (PT7, S176)`); return null; }
    return this.machineRef(parts, s, `spawn ${s.target}`)?.decl ?? null;
  }

  /** S176: the qualified name of the machine a spawn names, as the view spells it. */
  private targetName(target: string): string {
    const parts = target.split('.');
    const mod = parts.length > 1 ? parts.slice(0, -1).join('.') : this.module.name;
    return this.canon(mod, parts[parts.length - 1]);
  }

  /**
   * `spawn M as k -> Start(args) on complete -> P on parent terminal -> C` (PT6.4): an attached child of this
   * module, its optional creation action (S43), and its wiring with the parameter lists the runtime supplies (S44).
   */
  private spawn(s: A.IntentStmt, scope: Scope): void {
    const spec = childSpec(s, this.module.name);
    if (s.as === 'parent') this.err('PL1201', s, 'the child key parent names the parent in the joint state (PT7); choose another key');
    const child = this.childMachine(s);
    if (!child) { for (const a of s.args) this.typeOf(a.value, scope); return; }
    if (child === this.machine) { this.err('PL0901', s, `${child.name} spawns itself; children of children are checked from a later milestone (S46)`); return; }
    // S46: check-product runs the parent's mapper only, so a child that spawns or signals is out of M1.
    if (spawnsOrSignals(child)) this.err('PL0901', s, `${child.name} spawns or signals children of its own; children of children are checked from a later milestone (S46)`);
    const handled = (m: A.Machine, a: string) => m.items.some((i) => i.kind === 'Handler' && i.action === a);
    const actionOf = (m: A.Machine, a: string) => m.items.find((i): i is A.Action => i.kind === 'Action' && i.name === a);
    if (spec.create) {
      const act = actionOf(child, spec.create);
      if (!act) { this.err('PL1001', s, `${child.name} has no action ${spec.create}`); for (const a of s.args) this.typeOf(a.value, scope); }
      else {
        if (!handled(child, spec.create)) this.err('PL6101', s, `creation action ${child.name}.${spec.create} has no handler, so the runtime cannot deliver it; add a handler (S40, S43)`);
        this.intentArgs(s, act.params, `${child.name}.${spec.create}`, scope);
      }
    } else if (s.args.length) this.err('PL1201', s, `a spawn passes arguments only to a creation action: spawn ${s.target} as ${s.as} -> A(…) (S43)`);
    if (spec.onComplete) {
      const act = this.actions.get(spec.onComplete);
      if (!act) this.err('PL1001', s, `on complete -> ${spec.onComplete}: no action ${spec.onComplete} in ${this.machine!.name}`);
      else {
        if (!handled(this.machine!, spec.onComplete)) this.err('PL6101', s, `completion action ${spec.onComplete} has no handler, so the runtime cannot deliver it; add a handler (S40)`);
        this.completionParams(act, child);
        // S51: a family's completion takes every key of the family, not its name (S49).
        const keys = this.facts!.childKeyDomains.get(spec.onComplete) ?? [];
        const mine = s.index ? [...this.facts!.children.keys()].filter((k) => memberOf(k, spec.key)) : [spec.key];
        this.facts!.childKeyDomains.set(spec.onComplete, [...keys, ...mine.filter((k) => !keys.includes(k))]);
      }
    }
    if (spec.onParentTerminal) {
      const act = actionOf(child, spec.onParentTerminal);
      if (!act) this.err('PL1001', s, `on parent terminal -> ${spec.onParentTerminal}: no action ${spec.onParentTerminal} in ${child.name}`);
      else {
        if (!handled(child, spec.onParentTerminal)) this.err('PL6101', s, `cancel action ${child.name}.${spec.onParentTerminal} has no handler, so the runtime cannot deliver it; add a handler (S40)`);
        this.cancelParams(act, child);
      }
    }
  }

  /**
   * `spawn detached M as k -> A(args)` (PS7.5, S60, PT6.4): a separate actor at `<parent>/<k>`. `as k` binds `k`,
   * a local of type Ref<M> the handler may store or send to (S78). The child's completion is a message it sends,
   * so there is no `on complete` wiring; it is not part of the parent's cascade, so no `on parent terminal` either.
   */
  private detachedSpawn(s: A.IntentStmt, scope: Scope): void {
    const spec = childSpec(s, this.module.name);
    const child = this.childMachine(s);
    if (spec.onComplete) this.err('PL1201', s, `a detached child takes no on complete wiring: its completion is a message it sends (PT6.4, S60)`);
    if (spec.onParentTerminal) this.err('PL1201', s, `a detached child is a separate actor, not part of its parent's cascade, so it takes no on parent terminal wiring (PS7.5)`);
    if (child && spec.create) {
      const act = child.items.find((i): i is A.Action => i.kind === 'Action' && i.name === spec.create);
      if (!act) { this.err('PL1001', s, `${child.name} has no action ${spec.create}`); for (const a of s.args) this.typeOf(a.value, scope); }
      else {
        if (!child.items.some((i) => i.kind === 'Handler' && i.action === spec.create)) this.err('PL6101', s, `creation action ${child.name}.${spec.create} has no handler, so the child cannot take its first message; add a handler (S43, S60)`);
        this.intentArgs(s, act.params, `${child.name}.${spec.create}`, scope, this.foreignParams(s.target));
      }
    } else if (!child || s.args.length) {
      if (child && s.args.length) this.err('PL1201', s, `a spawn passes arguments only to a creation action: spawn detached ${s.target} as ${s.as} -> A(…) (S43)`);
      for (const a of s.args) this.typeOf(a.value, scope);
    }
    if (!child || !s.as || s.index) return;
    // PS15.3: the spawn a channel's expansion writes binds the key its handlers already read as the conversation's address.
    const own = scope.locals.get(s.as);
    if (s.generated === 'channel' && own?.res.k === 'child' && own.res.key === s.as) return;
    if (scope.locals.has(s.as) || scope.params.has(s.as) || this.facts!.fieldTypes.has(s.as)) { this.err('PL1002', s, `${s.as} is already a name here`); return; }
    const name = this.targetName(s.target);
    scope.locals.set(s.as, { ty: { k: 'ref', machine: name }, res: { k: 'child', key: s.as, machine: name } });
  }

  /**
   * S44: a completion action declares no parameters, or `(childKey: string, childState: R)`, where R is a record
   * whose fields are the child's fields, with their types (the runtime supplies the child's terminal state).
   */
  private completionParams(act: A.Action, child: A.Machine): void {
    if (act.params.length === 0) return;
    const [k, st] = act.params;
    if (act.params.length === 2 && k.name === 'childKey' && k.type.kind === 'TString' && st.name === 'childState') {
      const rt = this.tyOf(st.type);
      const rec = rt.k === 'record' ? this.env.records.get(rt.name)! : null;
      const matches = rec !== null && rec.fields.length === child.fields.length
        && child.fields.every((f) => { const rf = rec.fields.find((x) => x.name === f.name); return rf !== undefined && tyToString(this.tyOf(rf.type)) === tyToString(this.tyOf(f.type)); });
      if (!matches) { this.errOnce('PL1201', act, `${act.name}.childState is the state of ${child.name}; its type is a record with the fields ${child.fields.map((f) => f.name).join(', ')}, of the same types (S44)`); return; }
      // The runtime passes the child's flat snapshot; a union field with payloads is flat there (PS9.1b).
      if (child.fields.some((f) => { const t = this.tyOf(f.type); return t.k === 'union' && !this.env.unions.get(t.name)!.isEnum; })) this.errOnce('PL0901', act, `${act.name}.childState of ${child.name}, which has a union field with payloads, is lowered after milestone M1: the runtime passes the child's flat snapshot (PS9.1b, S65)`);
      return;
    }
    this.errOnce('PL1201', act, `completion action ${act.name} declares (${act.params.map((p) => p.name).join(', ')}); the runtime supplies (childKey: string, childState: R) or nothing (S44)`);
  }

  /** S44: a cancel action declares no parameters, or `(reason: string check { "parent-terminal" })`. */
  private cancelParams(act: A.Action, child: A.Machine): void {
    if (act.params.length === 0) return;
    const p = act.params[0];
    const values = p.check && p.check.domain.kind !== 'DomainRange' ? p.check.domain.values.map((v) => (v.kind === 'String' ? v.value : null)) : null;
    const ok = act.params.length === 1 && p.name === 'reason' && p.type.kind === 'TString' && values?.length === 1 && values[0] === 'parent-terminal';
    if (!ok) this.errOnce('PL1201', act, `cancel action ${child.name}.${act.name} declares (${act.params.map((x) => x.name).join(', ')}); the runtime supplies (reason: string check { "parent-terminal" }) or nothing (S44)`);
  }

  /** `signal k -> A(args)` (PT6.4): k is a child this machine spawns, A an action of that child with a handler. */
  /** A key of an int-keyed map whose range leaves the map's keys names no entry (review finding L9). */
  private keyInRange(kt: Ty, key: Ty, at: A.NodeBase): void {
    if (kt.k !== 'int' || key.k !== 'int') return;
    if (kt.lo < key.lo || kt.hi > key.hi) this.err('PL1201', at, `the map's keys are ${tyToString(key)}, and this key ranges over ${tyToString(kt)}`);
  }

  /**
   * S49: every index an index expression can take must name a member of its family; a family may have gaps
   * (t1 and t3 with no t2), so the members are the declared keys, not an interval. PL1201 at the index.
   */
  private inFamily(it: Ty, keys: Iterable<string>, at: A.NodeBase, fam: string): boolean {
    if (it.k !== 'int') return true;
    const members = new Set([...keys].filter((k) => memberOf(k, fam)).map((k) => Number(k.slice(fam.length))));
    const all = Number.isFinite(it.lo) && Number.isFinite(it.hi) && Array.from({ length: it.hi - it.lo + 1 }, (_, k) => it.lo + k).every((i) => members.has(i));
    if (all) return true;
    this.err('PL1201', at, `${fam}[…] has the members ${[...members].sort((a, b) => a - b).join(', ')}, and this index ranges over ${tyToString(it)} (S49)`);
    return false;
  }

  private signal(s: A.IntentStmt, scope: Scope): void {
    const key = s.extra[0];
    // S49: `signal f[i]` names a member of the family f; they share one machine and wiring.
    const spec = s.index ? [...this.facts!.children.values()].find((c) => memberOf(c.key, key)) : this.facts!.children.get(key);
    if (!spec) { this.err('PL1001', s, `signal ${key}: ${this.machine!.name} spawns no attached child ${key}`); for (const a of s.args) this.typeOf(a.value, scope); return; }
    const child = this.module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === spec.machine.split('.').pop());
    const act = child?.items.find((i): i is A.Action => i.kind === 'Action' && i.name === s.target);
    // A child machine that does not exist is reported at its spawn, once.
    if (!child) { for (const a of s.args) this.typeOf(a.value, scope); return; }
    if (!act) { this.err('PL1001', s, `signal ${key} -> ${s.target}: ${spec.machine} has no action ${s.target}`); for (const a of s.args) this.typeOf(a.value, scope); return; }
    if (!child.items.some((i) => i.kind === 'Handler' && i.action === s.target)) this.err('PL6101', s, `signalled action ${child.name}.${s.target} has no handler, so the runtime cannot deliver it; add a handler (S40)`);
    this.intentArgs(s, act.params, `${child.name}.${s.target}`, scope);
  }

  /** PT7: parent.f, and children.k.f under a `k spawned` narrowing (S48). */
  private jointMember(e: A.Member, scope: Scope): Ty {
    if (e.object.kind === 'Name' && e.object.name === 'parent') {
      const t = this.facts!.fieldTypes.get(e.prop);
      if (!t) { this.err('PL1001', e, `${this.machine!.name} has no field ${e.prop}`); return ERR; }
      this.resolve(e, { k: 'jointParent', field: e.prop });
      return t;
    }
    // S49: `children.f[i].x` and, inside an aggregate, `children.f[*].x`.
    if (e.object.kind === 'Index' && e.object.object.kind === 'Member' && e.object.object.object.kind === 'Name' && e.object.object.object.name === 'children') {
      const fam = e.object.object.prop;
      const idx = e.object.index;
      const range = this.facts!.families.get(fam);
      if (!range) { this.err('PL1001', e, `${this.machine!.name} spawns no family ${fam}`); return ERR; }
      if (idx.kind === 'Star') {
        if (!scope.star) { this.err('PL1201', idx, `${fam}[*] stands for the members of a family inside count, sum, all or any (S49)`); return ERR; }
      } else {
        const it = this.typeOf(idx, scope);
        if (it.k !== 'int' && it.k !== 'error') { this.err('PL1201', idx, `an index is an int, not ${tyToString(it)}`); return ERR; }
        if (!this.inFamily(it, this.facts!.children.keys(), idx, fam)) return ERR;
        if (!scope.spawned?.has(`${fam}[${indexText(idx)}]`)) { this.err('PL5103', e, `children.${fam}[${indexText(idx)}].${e.prop} is read where ${fam}[${indexText(idx)}] may not be spawned; write ${fam}[${indexText(idx)}] spawned implies … (S48, S49)`); return ERR; }
      }
      const spec = [...this.facts!.children.values()].find((c) => c.key === `${fam}${range.lo}`);
      const child = this.module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === spec?.machine.split('.').pop());
      const f = child?.fields.find((x) => x.name === e.prop);
      if (!f) { this.err('PL1001', e, `${spec?.machine ?? fam} has no field ${e.prop}`); return ERR; }
      this.resolve(e, { k: 'jointFamily', family: fam, field: e.prop });
      return this.tyOf(f.type);
    }
    if (e.object.kind === 'Member' && e.object.object.kind === 'Name' && e.object.object.name === 'children') {
      const key = e.object.prop;
      const spec = this.facts!.children.get(key);
      if (!spec) { this.err('PL1001', e, `${this.machine!.name} spawns no attached child ${key}`); return ERR; }
      if (!scope.spawned?.has(key)) { this.err('PL5103', e, `children.${key}.${e.prop} is read where ${key} may not be spawned; write ${key} spawned implies … (S48)`); return ERR; }
      const child = this.module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === spec.machine.split('.').pop());
      const f = child?.fields.find((x) => x.name === e.prop);
      if (!f) { this.err('PL1001', e, `${spec.machine} has no field ${e.prop}`); return ERR; }
      this.resolve(e, { k: 'jointChild', key, field: e.prop });
      return this.tyOf(f.type);
    }
    this.err('PL1201', e, 'a compose invariant reads parent.f and children.k.f (PT7)');
    return ERR;
  }

  /**
   * S49: the largest index a loop `for i in lo..n` takes: n itself when it is a literal, and otherwise the
   * upper bound of the range type of the field or parameter n names. Null when n is neither.
   */
  private loopBound(s: A.For, action: A.Action | undefined): number | null {
    if (s.hi.kind === 'Int') return s.hi.value;
    if (s.hi.kind !== 'Name') return null;
    const p = action?.params.find((x) => x.name === (s.hi as A.NameRef).name);
    const t = p ? this.tyOf(p.type) : this.facts?.fieldTypes.get(s.hi.name);
    return t && t.k === 'int' && Number.isFinite(t.hi) ? t.hi : null;
  }

  /** The least value a loop's bound takes: the bottom of the range type of the field or parameter it names (S49). */
  private loopLeast(s: A.For, action: A.Action | undefined): number {
    if (s.hi.kind !== 'Name') return -Infinity;
    const p = action?.params.find((x) => x.name === (s.hi as A.NameRef).name);
    const t = p ? this.tyOf(p.type) : this.facts?.fieldTypes.get(s.hi.name);
    return t && t.k === 'int' && Number.isFinite(t.lo) ? t.lo : -Infinity;
  }

  /** `for i in lo..n { … }` (S49): a bound the checker can read, and a body of intents and map-entry writes. */
  private forLoop(s: A.For, scope: Scope): void {
    const bound = this.loopBound(s, this.handlerAction);
    if (bound === null) { this.err('PL1201', s.hi, 'a loop runs to an integer literal, or to a field or parameter whose type is a range (S49)'); return; }
    const ht = this.typeOf(s.hi, scope);
    if (ht.k !== 'int' && ht.k !== 'error') this.err('PL1201', s.hi, `a loop's bound is an int, not ${tyToString(ht)}`);
    if (scope.locals.has(s.var) || scope.params.has(s.var) || this.facts!.fieldTypes.has(s.var)) this.err('PL1002', s, `${s.var} is already a name here`);
    for (const b of s.body) {
      if (!loopStatement(b)) this.err('PL1201', b, 'a loop body holds spawn, signal, emit, after, cancel and map-entry writes (S49)');
    }
    const inner: Scope = { ...scope, locals: new Map(scope.locals) };
    inner.locals.set(s.var, { ty: { k: 'int', lo: s.lo, hi: Math.max(s.lo, bound) }, res: { k: 'let', name: s.var } });
    this.stmts(s.body, inner);
  }

  /** `after d -> A(args) as key` (PT6.3): a duration, an action of this machine and its typed arguments. */
  private timer(s: A.IntentStmt, scope: Scope): void {
    if (!s.modifier || durationMs(s.modifier) === null) this.err('PL1201', s, `${s.modifier} is not a duration`);
    const act = this.actions.get(s.target);
    if (!act) { this.err('PL1001', s, `after … -> ${s.target}: no action ${s.target}`); for (const a of s.args) this.typeOf(a.value, scope); return; }
    this.intentArgs(s, act.params, `${s.target}`, scope);
  }

  /** Arguments of an intent against declared parameters: all positional or all named, typed, none missing. */
  private intentArgs(s: A.IntentStmt, params: A.Param[], what: string, scope: Scope, foreign?: (t: A.TypeExpr) => Ty | null): void {
    const positional = s.args.every((a) => a.name === null);
    if (!positional && !s.args.every((a) => a.name !== null)) {
      this.err('PL1201', s, `the arguments of ${what} are all positional or all named`);
      for (const a of s.args) this.typeOf(a.value, scope);
      return;
    }
    if (positional && s.args.length !== params.length) {
      this.err('PL1201', s, `${what} takes ${params.length} argument${params.length === 1 ? '' : 's'} (${params.map((p) => p.name).join(', ')}), not ${s.args.length}`);
      for (const a of s.args) this.typeOf(a.value, scope);
      return;
    }
    const given = new Set<string>();
    s.args.forEach((a, i) => {
      const p = a.name === null ? params[i] : params.find((x) => x.name === a.name);
      if (!p) { this.err('PL1001', a.value, `${what} has no parameter ${a.name}`); this.typeOf(a.value, scope); return; }
      if (given.has(p.name)) this.err('PL1002', a.value, `${p.name} is given twice`);
      given.add(p.name);
      // S176: a message across modules carries only values whose types need no module.
      const pt = foreign ? foreign(p.type) : this.tyOf(p.type);
      if (pt === null) { this.err('PL0901', a.value, `${what}.${p.name} is a type its module declares, and a message across modules carries only types that need no module (booleans, ranges, int, strings, Principal, addresses) until types cross modules (S176, S190)`); this.typeOf(a.value, scope); return; }
      // S58, S177: self is a whole argument of a send, or of a detached spawn's creation action.
      const whole = (s.op === 'send' || (s.op === 'spawn' && s.modifier === 'detached')) && a.value.kind === 'Name' && a.value.name === 'self';
      const t = this.typeOf(a.value, whole ? { ...scope, selfOk: true } : scope, pt);
      if (!same(t, pt)) this.err(opaqueCode(t, pt), a.value, `${what}.${p.name} is ${tyToString(pt)}, and the value is ${tyToString(t)}`);
    });
    const missing = params.filter((p) => !given.has(p.name)).map((p) => p.name);
    if (!positional && missing.length) this.err('PL1201', s, `${what} is missing ${missing.join(', ')}`);
  }

  /**
   * `send r <- A(args)` (PS2.2, PS13.3): r is an address of a machine T of this module, A an action of T, and
   * the arguments are typed against A's parameters. `as n` names nothing in PS or PT yet (S58).
   */
  private send(s: A.IntentStmt, scope: Scope): void {
    if (s.as) this.err('PL0901', s, `send … as ${s.as} names nothing in the semantics yet (S58)`);
    const tt = this.typeOf(s.to!, scope);
    // One mistake, one diagnostic: an argument written `self` is still a whole argument of the send.
    const rest = () => { for (const a of s.args) this.typeOf(a.value, a.value.kind === 'Name' && a.value.name === 'self' ? { ...scope, selfOk: true } : scope); };
    if (tt.k === 'error') { rest(); return; }
    if (tt.k !== 'ref') { this.err('PL1201', s.to!, `a send's target is an address, Ref<M>, not ${tyToString(tt)}`); rest(); return; }
    if (tt.machine === null) { this.err('PL1201', s.to!, "a send's target is none here, so it names no machine and no action; send to a field or parameter of type Ref<M>"); rest(); return; }
    const receiver = this.machineDecl(tt.machine);
    const act = receiver?.items.find((i): i is A.Action => i.kind === 'Action' && i.name === s.target);
    if (!act) { this.err('PL1001', s, `send … <- ${s.target}: ${tt.machine} has no action ${s.target}`); rest(); return; }
    // M4 review C5, K10: a decision's completion is delivered by the outbox worker only, with its decision event.
    const decision = receiver!.items.find((i): i is A.Decision => i.kind === 'Decision' && i.items.some((x) => x.kind === 'EffOutcome' && (x as A.EffOutcomeItem).action === s.target));
    if (decision) { this.err('PL6204', s, `send … <- ${s.target}: ${s.target} completes decision ${decision.name} of ${tt.machine}, and only the outbox worker delivers it, with its decision event (K10)`); rest(); return; }
    this.intentArgs(s, act.params, `${tt.machine}.${s.target}`, scope, tt.machine.includes('.') ? this.foreignParams(tt.machine) : undefined);
  }

  /** S176: for a machine of another module, how its parameters are typed here; undefined for this module's own. */
  private foreignParams(target: string): ((t: A.TypeExpr) => Ty | null) | undefined {
    const parts = target.split('.');
    const mod = parts.length > 1 ? parts.slice(0, -1).join('.') : this.module.name;
    return mod === this.module.name ? undefined : (t) => this.foreignTy(t, mod);
  }

  private emit(s: A.IntentStmt, scope: Scope): void {
    const e = this.facts!.effects.get(s.target);
    if (!e) {
      this.err('PL1001', s, `${s.target} is not a declared effect`);
      for (const a of s.args) this.typeOf(a.value, scope);
      return;
    }
    this.intentArgs(s, e.params, s.target, scope);
  }

  /**
   * PS5.4, S37: the compiler accepts only path properties that are prefix-closed by construction, a
   * conjunction of `count("k") <= n`, `count("k") < n` and `before("k1", "k2")` over effect kinds.
   */
  private pathProperty(p: A.Property, kinds: Set<string>): void {
    const conjuncts: A.Expr[] = [];
    const split = (e: A.Expr): void => {
      if (e.kind === 'Binary' && e.op === '&&') { split(e.left); split(e.right); } else conjuncts.push(e);
    };
    split(p.expr);
    for (const c of conjuncts) {
      const order = beforeKinds(c);
      const bound = countBound(c);
      const named = order ? [order.first, order.then] : bound ? [{ kind: bound.kind, at: bound.at }] : null;
      if (!named) { this.err('PL1701', c, 'a path property is a conjunction of count("kind") <= n, count("kind") < n and before("k1", "k2"), so that it is prefix-closed (PS5.4)'); continue; }
      for (const n of named) if (!kinds.has(n.kind)) this.err('PL1001', n.at, `no effect of machine ${this.machine!.name} has kind "${n.kind}"`);
    }
  }

  /**
   * PT3.4a: a parameter whose value can flow into the payload of an irreversible or compensable effect is
   * strict by default. The flow is read from each handler: a parameter flows when an argument of such an
   * emit reads it, directly or through a `let`. An explicit `disclosed` on an input that flows into an
   * irreversible payload is PL1301, a finding a person must accept (PT12.5).
   */
  private strictFlow(m: A.Machine, facts: MachineFacts): void {
    const handled = new Set(m.items.flatMap((h) => (h.kind === 'Handler' ? [h.action] : [])));
    for (const it of m.items) {
      if (it.kind !== 'Action') continue;
      for (const p of it.params) {
        if (p.check?.mode === 'strict') facts.strictParams.add(`${it.name}.${p.name}`);
        // S400: every parameter of a handled action with a check domain is strict unless written disclosed.
        else if (handled.has(it.name) && p.check?.mode !== 'disclosed' && this.hasCheckDomain(it, p)) facts.strictParams.add(`${it.name}.${p.name}`);
      }
    }
    // F3 (PT3.4a, through fields): the fields an irreversible emit reads, and each write's flow from a parameter or a
    // field into a field, over every handler, so a disclosed value stored by one step and charged by another is found.
    const fieldNames = new Set(m.fields.map((f) => f.name));
    const sinks = new Set<string>();
    const flows: { from: string; to: string }[] = [];
    for (const h of m.items) {
      if (h.kind !== 'Handler') continue;
      const act = this.actions.get(h.action);
      if (!act) continue;
      const params = new Set(act.params.map((p) => p.name));
      const source = (n: string): string | null => (n.startsWith('pre.') ? n.slice(4) : params.has(n) ? `${act.name}.${n}` : fieldNames.has(n) ? n : null);
      const guarded = new Set<string>();
      const irreversible = new Set<string>();
      const lets = new Map<string, Set<string>>();
      const visit = (body: A.Stmt[]): void => {
        for (const st of body) {
          if (st.kind === 'Let') lets.set(st.name, readsOf(st.expr, lets));
          if (st.kind === 'Assign' && fieldNames.has(st.field)) for (const n of readsOf(st.expr, lets)) { const s = source(n); if (s && s !== st.field) flows.push({ from: s, to: st.field }); }
          if (st.kind === 'If') { visit(st.then); visit(st.else ?? []); }
          if (st.kind === 'Match') for (const a of st.arms) visit(a.body);
          if (st.kind === 'For') visit(st.body);
          if (st.kind !== 'Intent' || st.op !== 'emit') continue;
          const e = facts.effects.get(st.target);
          const cls = e ? effectClass(e) : 'none';
          if (cls !== 'irreversible' && cls !== 'compensable') continue;
          for (const a of st.args) {
            for (const n of readsOf(a.value, lets)) {
              guarded.add(n);
              if (cls === 'irreversible') irreversible.add(n);
              if (cls === 'irreversible') { const s = source(n); if (s && !s.includes('.')) sinks.add(s); }
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
        const read = irreversible.has(`pre.${f.name}`) || (irreversible.has(f.name) && !act.params.some((p) => p.name === f.name));
        if (f.check?.mode === 'disclosed' && read) this.errOnce('PL1301', f.check, `${f.name} is disclosed, and it flows into an irreversible effect (PT3.4a)`);
      }
    }
    // F3: from each disclosed parameter, the chain of writes that reaches a field an irreversible emit reads.
    for (const it of m.items) {
      if (it.kind !== 'Action') continue;
      for (const p of it.params) {
        if (p.check?.mode !== 'disclosed') continue;
        const start = `${it.name}.${p.name}`;
        const prev = new Map<string, string>([[start, '']]);
        const queue = [start];
        let hit: string | null = null;
        while (queue.length && !hit) {
          const x = queue.shift()!;
          for (const e of flows) {
            if (e.from !== x || prev.has(e.to)) continue;
            prev.set(e.to, x);
            if (sinks.has(e.to)) { hit = e.to; break; }
            queue.push(e.to);
          }
        }
        if (!hit) continue;
        const chain: string[] = [];
        for (let x: string = hit; x; x = prev.get(x)!) chain.unshift(x);
        this.errOnce('PL1301', p.check, `${start} is disclosed, and it flows through ${chain.slice(1).join(' then ')} into an irreversible effect (PT3.4a, F3)`);
      }
    }
  }

  /**
   * PT3.4a, S400: whether a parameter has a check domain the runtime can test at dispatch. A Principal, a Ref, a
   * Content or an Items, or a type that holds one, is explored by representatives and has none (PS4.1c, PS4.1f);
   * nor has a completion's childKey and childState, which the runtime supplies from the child (S44, S51).
   */
  private hasCheckDomain(act: A.Action, p: A.Param): boolean {
    // Probe reviewer A, F2: only a completion a spawn names is supplied by the runtime (S44, S51), not any action whose
    // parameters carry those names.
    if (this.facts?.childKeyDomains.has(act.name) && act.params.length === 2 && act.params[0].name === 'childKey' && act.params[1].name === 'childState') return false;
    const ty = this.tyOf(p.type);
    if ((ty.k === 'int' && !Number.isFinite(ty.lo)) || ty.k === 'string') return p.check !== null;
    const seen = new Set<string>();
    const opaque = (t: Ty): boolean => {
      if (t.k === 'principal' || t.k === 'ref' || t.k === 'content' || t.k === 'key' || t.k === 'items' || t.k === 'error' || t.k === 'action') return true;
      if (t.k === 'string' || (t.k === 'int' && !Number.isFinite(t.lo))) return true;
      if (t.k === 'map') return opaque(t.key) || opaque(t.value);
      if ((t.k !== 'record' && t.k !== 'union') || seen.has(t.name)) return false;
      seen.add(t.name);
      const fields = t.k === 'record' ? this.env.records.get(t.name)!.fields : this.env.unions.get(t.name)!.ctors.flatMap((c) => c.fields);
      return fields.some((f) => opaque(this.tyOf(f.type)));
    };
    return !opaque(ty);
  }

  private checkDomain(what: string, t: A.TypeExpr, ty: Ty, check: A.CheckClause | null, at: A.NodeBase): void {
    if (check && ty.k === 'items') { this.err('PL1209', check, 'an Items has no check domain: its count is explored from 0 to the largest limit (PS1.4b)'); return; }
    if (check && ty.k === 'key') { this.err('PL1209', check, 'a Key has no check domain: its only constant is none, and check explores it by representatives (PS1.4c, PS4.1g)'); return; }
    if (check && ty.k === 'content') { this.err('PL1209', check, `a Content has no check domain: its only constant is none, and check explores it by representatives (PS1.4a, PS4.1f)`); return; }
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
    // A record with an unbounded field was reported at the field (S25); its uses say nothing more.
    if (ty.k === 'record' && this.env.records.get(ty.name)!.fields.some((x) => cardinality(x.type, this.env) === null)) return;
    if (cardinality(t, this.env) === null) this.err('PL1101', at, `${what} has type ${tyToString(ty)}, which has no finite check domain; add \`check { … }\` or \`check a..b\` (PT3.2)`);
  }

  // ── initial values ─────────────────────────────────────────────────────
  private checkInit(f: A.Field, ty: Ty): void {
    const got = this.typeOf(f.init, this.scope('init'), ty);
    if (!same(got, ty)) { this.err(opaqueCode(got, ty), f.init, `initial value of ${f.name} has type ${tyToString(got)}, not ${tyToString(ty)}`); return; }
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
    if (ty.k === 'record' && e.kind === 'MapLit') {
      // S25: a record literal's fields against their declared types (PS4.2).
      const r = this.env.records.get(ty.name)!;
      for (const en of e.entries) {
        const decl = en.key.kind === 'Name' ? r.fields.find((x) => x.name === (en.key as A.NameRef).name) : undefined;
        if (decl) this.checkConst(en.value, this.tyOf(decl.type), null, `${what}.${decl.name}`);
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
    // PS15.3: a channel's key names its conversation's address p/c in every handler of the application.
    for (const c of this.machine?.channelKeys ?? []) scope.locals.set(c.key, { ty: { k: 'ref', machine: c.machine }, res: { k: 'child', key: c.key, machine: c.machine } });
    for (const p of act.params) scope.params.set(p.name, this.tyOf(p.type));
    // PD5.1.2: `by c: C` binds the claims, a claims type's value, in the handler.
    if (h.by) {
      // Polywatch: the binder is not a node, so the reserved-name walk misses it; the embedded surface can spell it.
      if (h.by.name === '$claims' || h.by.name === '$lineage') this.err('PL1208', h, `on ${h.action} by ${h.by.name}: ${h.by.name} is reserved: the runtime writes it, and no program declares it (S155)`);
      const rec =this.module.decls.find((d): d is A.RecordDecl => d.kind === 'RecordDecl' && d.name === h.by!.type);
      // A binder whose type is wrong is still bound, as an error, so its uses are not reported again.
      if (!rec && !this.env.unions.has(h.by.type)) { this.err('PL1001', h, `on ${h.action} by ${h.by.name}: ${h.by.type}: no claims type ${h.by.type}`); scope.params.set(h.by.name, ERR); }
      else if (!rec?.claims) { this.err('PL1201', h, `on ${h.action} by ${h.by.name}: ${h.by.type}: ${h.by.type} is not a claims type (PD5.1.2)`); scope.params.set(h.by.name, ERR); }
      else if (scope.params.has(h.by.name)) this.err('PL1002', h, `on ${h.action}: ${h.by.name} names a parameter and the claims`);
      // Review A-F7: a name the language gives a meaning is not a binder.
      else if (['pre', 'post', 'action', 'self', 'none'].includes(h.by.name)) { this.err('PL1201', h, `on ${h.action} by ${h.by.name}: ${h.by.name} is a name of the language, not a binder`); scope.params.set(h.by.name, ERR); }
      else scope.params.set(h.by.name, { k: 'record', name: rec.name });
    }
    this.handlerAction = act;
    this.stmts(h.body, scope);
    this.childAddressUses(h.body);
    // Per-path rules (PT4.1, PS2.4, PT4.4).
    const ends = this.paths(h.body, [{ written: new Map(), done: false, emits: false, timers: new Map() }]);
    this.handlerAction = undefined;
    for (const e of ends) {
      if (!e.done && e.written.size === 0 && !e.emits) {
        this.err('PL2201', h, `on ${h.action} can complete with no write, no effect and no rejection (PT4.4)`);
        break;
      }
    }
  }

  /** PL1207 (PS3.2, S101, S127): the reasons the runtime gives are not the module's to give. */
  private reason(n: A.Require | A.Reject | A.Guard): void {
    if (RESERVED_REASONS.includes(n.reason)) this.err('PL1207', n, `reject "${n.reason}" uses a reason the runtime reserves (${RESERVED_REASONS.join(', ')})`);
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
        this.reason(s);
        break;
      case 'Reject':
        this.reason(s);
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
        if (!same(got, ft)) this.err(opaqueCode(got, ft), s.expr, `${s.field}' is ${tyToString(ft)}, and the value is ${tyToString(got)}`);
        break;
      }
      case 'MapUpdate': {
        const ft = fields.get(s.field);
        if (!ft) { this.err('PL1001', s, `${s.field} is not a declared field (PF1.1)`); break; }
        if (s.base !== s.field) this.err('PL1201', s, `a map update writes one entry of the same field: ${s.field}' = ${s.field} with [k] = v`);
        if (ft.k !== 'map') { this.err('PL1201', s, `${s.field} is not a map`); break; }
        const kt = this.typeOf(s.key, scope, ft.key);
        if (!same(kt, ft.key)) this.err('PL1201', s.key, `key has type ${tyToString(kt)}, the map's keys are ${tyToString(ft.key)}`);
        else this.keyInRange(kt, ft.key, s.key);
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
      case 'For':
        this.forLoop(s, scope);
        break;
      case 'Intent':
        if (s.index) {
          const it = this.typeOf(s.index, scope);
          if (it.k !== 'int' && it.k !== 'error') this.err('PL1201', s.index, `a key's index is an int, not ${tyToString(it)} (S49)`);
          // S49: signal and cancel name members a spawn or an after declared; their index must stay in that family.
          const fam = s.op === 'signal' ? s.extra[0] : s.op === 'cancel' ? s.target : null;
          const keys = s.op === 'signal' ? [...this.facts!.children.keys()] : [...this.facts!.timerKeys];
          if (fam && keys.some((k) => memberOf(k, fam))) this.inFamily(it, keys, s.index, fam);
        }
        if (s.op === 'emit') this.emit(s, scope);
        else if (s.op === 'after') this.timer(s, scope);
        else if (s.op === 'spawn' && s.modifier !== 'detached') this.spawn(s, scope);
        else if (s.op === 'spawn') this.detachedSpawn(s, scope);
        else if (s.op === 'signal') this.signal(s, scope);
        else if (s.op === 'send') this.send(s, scope);
        else if (s.op === 'decide') this.decide(s, scope);
        else if (s.op === 'adjudicate') {
          // PD2.4, S129: the decision is the machine's own.
          if (!this.facts!.decisions.has(s.target)) this.err('PL1001', s, `adjudicate ${s.target}: ${s.target} is not a declared decision`);
        }
        else if (s.op === 'cancel') {
          const armedKey = s.index ? [...this.facts!.timerKeys].some((k) => k.startsWith(s.target) && /^\d+$/.test(k.slice(s.target.length))) : this.facts!.timerKeys.has(s.target);
          if (!armedKey) this.err('PL1001', s, `cancel ${s.target}${s.index ? '[…]' : ''}: no \`after\` of ${this.machine!.name} arms a timer ${s.target} (PT6.3)`);
        }
        break;
    }
  }

  private match(s: A.Match, scope: Scope): void {
    const st = this.typeOf(s.scrutinee, scope);
    if (st.k !== 'union') {
      if (st.k !== 'error') this.err(st.k === 'content' || st.k === 'key' ? 'PL1209' : 'PL1201', s.scrutinee, `match needs a union value, not ${tyToString(st)}`);
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
      for (const { name, mark } of marks) if (!mark.used) this.err('PL1504', arm.pattern, `${name} is bound and never read; write \`_\` to ignore the payload (a misspelled constructor binds too)`, { names: [name] });
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
        // S49: entry writes to distinct constant keys of one map compose, as the copies of a loop write them;
        // a whole write, or two writes to one entry, is still written twice.
        const k = s.kind === 'MapUpdate' ? constantKey(s.key, this.facts!.resolutions) : null;
        const slot = k === null ? s.field : `${s.field}[${k}]`;
        const clash = [...p.written.entries()].find(([w]) => w === s.field || w === slot || (k === null && w.startsWith(`${s.field}[`)));
        if (clash) this.errOnce('PL2102', s, `${s.field}' is written twice on one path (first at line ${clash[1].span?.line ?? '?'}) (PS2.4)`);
        const written = new Map(p.written);
        written.set(slot, s);
        return [{ ...p, written }];
      }
      case 'If':
        return [...this.paths(s.then, [p]), ...this.paths(s.else ?? [], [p])];
      case 'Match':
        return s.arms.flatMap((a) => this.paths(a.body, [p]));
      case 'For': {
        // S49: the copies i = lo..n run in order. With a literal n exactly those run; with n a field or a
        // parameter, any prefix up to the bound of its type may run, so every prefix is a path.
        const bound = this.loopBound(s, this.handlerAction) ?? s.lo;
        const n = s.hi.kind === 'Int' ? s.hi.value : null;
        const last = n === null ? bound : Math.min(n, bound);
        // The copies up to the bound's least value always run; only the ones after it may stop (review finding C6).
        const least = n === null ? this.loopLeast(s, this.handlerAction) : last;
        let cur = [p];
        const prefixes: PathState[] = n === null && least < s.lo ? [p] : [];
        for (let k = s.lo; k <= last; k++) {
          // A statement the loop body may not hold is reported once, by forLoop, and not read for paths.
          cur = this.paths(substitute(s.body.filter(loopStatement), s.var, k), cur);
          if (n === null && k >= least) prefixes.push(...cur);
        }
        return n === null ? prefixes : cur;
      }
      case 'Intent': {
        if (s.op === 'spawn' && s.as) {
          const idx = s.index ? constantIndex(s.index) : null;
          if (s.index && idx === null) return [{ ...p, emits: true }];
          const key = `spawn:${s.as}${idx ?? ''}`;
          const prev = p.timers.get(key);
          if (prev) this.errOnce('PL5101', s, `child ${s.as} is spawned twice on one path (first at line ${prev.span?.line ?? '?'}); the kernel would make a second instance behind one key (PS7.2)`);
          const timers = new Map(p.timers);
          timers.set(key, s);
          return [{ ...p, emits: true, timers }];
        }
        if (s.op === 'signal') {
          // S66: the kernel poisons a step that signals one child with one action twice (kernel.mjs, check-product.mjs).
          const sidx = s.index ? constantIndex(s.index) : null;
          if (s.index && sidx === null) return [{ ...p, emits: true }];
          const skey = `signal:${s.extra[0]}${sidx ?? ''}:${s.target}`;
          const prev = p.timers.get(skey);
          if (prev) this.errOnce('PL5105', s, `${s.extra[0]}${sidx ?? ''} is signalled with ${s.target} twice on one path (first at line ${prev.span?.line ?? '?'}); the kernel poisons such a step (S66)`);
          const timers = new Map(p.timers);
          timers.set(skey, s);
          return [{ ...p, emits: true, timers }];
        }
        if (s.op !== 'after' || !s.as) return [{ ...p, emits: true }];
        // A timer key indexed by the loop variable names one key per copy (S49); a key not indexed is one key.
        const tidx = s.index ? constantIndex(s.index) : null;
        if (s.index && tidx === null) return [{ ...p, emits: true }];
        const tkey = `${s.as}${tidx ?? ''}`;
        // PT6.3: arming one key twice on one path would leave only the second timer; say so.
        const prev = p.timers.get(tkey);
        if (prev) this.errOnce('PL2301', s, `timer ${tkey} is armed twice on one path (first at line ${prev.span?.line ?? '?'}) (PT6.3)`);
        const timers = new Map(p.timers);
        timers.set(tkey, s);
        return [{ ...p, emits: true, timers }];
      }
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
    if (t.k !== 'bool' && t.k !== 'error') this.err(t.k === 'content' || t.k === 'key' ? 'PL1209' : 'PL1201', e, `expected a Bool condition, found ${tyToString(t)}`);
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
    const dot = name.lastIndexOf('.');
    if (dot >= 0) {
      const union = name.slice(0, dot);
      const info = this.env.unions.get(union);
      if (!info || !info.ctors.some((c) => c.name === name.slice(dot + 1))) { this.err('PL1001', at, `${name}: ${info ? `${union} has no constructor ${name.slice(dot + 1)}` : `unknown type ${union}`}`); return null; }
      // S190: m.E.C names an enum of another module, which a use must admit.
      if (union.includes('.') && !this.admits(union.slice(0, union.lastIndexOf('.')), union.slice(union.lastIndexOf('.') + 1))) { this.err('PL1001', at, `${union} is not used here; write \`use ${union}\` (S190)`); return null; }
      return { union, info };
    }
    const owners = this.env.ctorOwners.get(name) ?? [];
    // S190: the admitted enums of other modules that have the member; a bare one names them only through an expected type.
    const foreign = [...this.env.unions.values()].filter((u) => u.name.includes('.') && u.ctors.some((c) => c.name === name) && this.admits(u.name.slice(0, u.name.lastIndexOf('.')), u.name.slice(u.name.lastIndexOf('.') + 1))).map((u) => u.name);
    let union: string | undefined;
    if (expected?.k === 'union' && (owners.includes(expected.name) || (expected.name.includes('.') && this.env.unions.get(expected.name)?.ctors.some((c) => c.name === name)))) union = expected.name;
    else if (owners.length === 1 && !foreign.length) union = owners[0];
    else if (owners.length + foreign.length > 1 || foreign.length) {
      const all = [...owners, ...foreign];
      this.err('PL1005', at, `${name} is a member of ${all.join(' and ')}, and no expected type fixes which; write ${all.map((o) => `${o}.${name}`).join(' or ')} (S22, S190)`, { names: all });
      return null;
    }
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
      case 'Decimal':
        // S76: a decimal is the constant a Conf is compared with; outside a machine there is no Conf (review A2).
        if (!this.facts) { this.err('PL1201', e, 'a decimal literal is legal only as the constant a Conf is compared with (S76)'); return ERR; }
        return { k: 'conf' };
      case 'Bool': return BOOL;
      // PS1.4a, S180: the only constant of type Content is none; a digest written in source is no body.
      case 'String':
        // PS1.4c, S451: and of type Key; a key enters only as data at run time.
        if (expected?.k === 'key') { this.err('PL1209', e, 'a Key enters only as data at run time; the only constant of type Key is none (PS1.4c)'); return { k: 'key' }; }
        if (expected?.k === 'content') { this.err('PL1209', e, 'a Content is a body that enters at run time, through ingress or the store; the only constant of type Content is none (PS1.4a)'); return { k: 'content' }; }
        return { k: 'string' };
      case 'Primed':
        this.err('PL1202', e, `${e.name}' is write-only; expressions read the pre-state (PS2.3)`);
        return ERR;
      case 'Name': {
        const n = e.name;
        const local = scope.locals.get(n);
        if (local) { if (local.mark) local.mark.used = true; this.resolve(e, local.res); return local.ty; }
        // S32: an instance is read through its fields or tested with `is`.
        const inf = this.instanceForm(e, scope);
        if (inf === 'error') return ERR;
        if (inf) { this.err('PL1201', e, `${n} is an instance; read a field, ${n}.f, or test it with is (S32)`); return ERR; }
        if (scope.params.has(n)) { this.resolve(e, { k: 'param', name: n }); return scope.params.get(n)!; }
        if (fields.has(n) && scope.ctx === 'compose') { this.err('PL1201', e, `a compose invariant reads the parent's field as parent.${n} (PT7)`); return ERR; }
        if (fields.has(n) && scope.ctx !== 'init' && scope.ctx !== 'step') {
          this.resolve(e, { k: 'field', name: n });
          scope.reads?.add(n);
          return fields.get(n)!;
        }
        if (n === 'action' && (scope.ctx === 'step' || scope.ctx === 'reject' || scope.ctx === 'guard')) { this.resolve(e, { k: 'actionVar' }); return { k: 'action' }; }
        if (expected?.k === 'action' && this.actions.has(n)) { this.resolve(e, { k: 'action', name: n }); return { k: 'action' }; }
        if (n === 'none') { this.resolve(e, { k: 'none' }); return { k: 'ref', machine: null }; }
        if (n === 'self' && this.machine && scope.ctx === 'handler') {
          // S58: the mapper has no instance id, so `self` lowers to a marker the kernel resolves in a send's data.
          if (!scope.selfOk) { this.err('PL0901', e, 'self is legal only as a whole argument of a send in milestone M1 (S58)'); return ERR; }
          this.resolve(e, { k: 'self' });
          return { k: 'ref', machine: this.canon(this.module.name, this.machine.name) };
        }
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
        // S32: `x.f` and `g[i].f`, a field of an instance, only in a configuration property.
        const inf = this.instanceForm(e.object, scope);
        if (inf === 'error') return ERR;
        if (inf) {
          const t = inf.facts.fieldTypes.get(e.prop);
          if (!t) { this.err('PL1001', e, `${inf.machine.name} has no field ${e.prop}`); return ERR; }
          // Review B-F4, S190: a field whose type another module declares is read here only through `is`, which resolves
          // its constructors in that module; any other use would read them in this one's namespace.
          // S190 (B-F4 lifted): a field of another module's machine has that module's types, spelled m.E from here.
          const env = inf.facts.env ?? this.env;
          if (env !== this.env && (t.k === 'union' || t.k === 'record')) {
            const q = t.name.includes('.') ? t.name : `${env.module}.${t.name}`;
            if (t.k === 'record' || !this.env.unions.has(q)) { this.err('PL0901', e, `${inf.name}.${e.prop} has type ${q}, which is not a payload-free enum of a used module; only those cross modules (S190)`); return ERR; }
            return { k: 'union', name: q };
          }
          return t;
        }
        // S190: `m.E.C`, a member of another module's enum, named with its module and enum.
        const qualified = dottedName(e.object);
        if (qualified && qualified.includes('.') && (this.env.unions.has(qualified) || this.foreignOther.has(qualified)) && !scope.locals.has(qualified.split('.')[0]) && !scope.params.has(qualified.split('.')[0]) && !fields.has(qualified.split('.')[0])) {
          if (this.foreignOther.has(qualified)) { this.err('PL0901', e, `${qualified} is a record or a union with payloads of another module; only payload-free enums cross modules (S190)`); return ERR; }
          const c = this.ctorType(`${qualified}.${e.prop}`, expected, e);
          if (!c) return ERR;
          this.resolve(e, { k: 'ctor', union: c.union, ctor: e.prop });
          return { k: 'union', name: c.union };
        }
        // S22: `Type.C`, a constructor without payload named with its type.
        if (e.object.kind === 'Name' && this.env.unions.has(e.object.name) && !scope.locals.has(e.object.name) && !scope.params.has(e.object.name) && !fields.has(e.object.name)) {
          const c = this.ctorType(`${e.object.name}.${e.prop}`, expected, e);
          if (!c) return ERR;
          if (c.info.ctors.find((x) => x.name === e.prop)!.fields.length) this.err('PL1201', e, `${e.object.name}.${e.prop} carries a payload; write ${e.object.name}.${e.prop} { … }`);
          this.resolve(e, { k: 'ctor', union: c.union, ctor: e.prop });
          return { k: 'union', name: c.union };
        }
        if (scope.ctx === 'compose') return this.jointMember(e, scope);
        // S19: in a handler, pre.f names the pre-state field f even where a parameter f shadows it.
        const handlerPre = scope.ctx === 'handler' && e.object.kind === 'Name' && e.object.name === 'pre' && !scope.locals.has('pre') && !scope.params.has('pre');
        if (handlerPre || (e.object.kind === 'Name' && (e.object.name === 'pre' || e.object.name === 'post') && (scope.ctx === 'step' || scope.ctx === 'reject'))) {
          const obj = e.object as A.NameRef;
          if (obj.name === 'post' && scope.ctx === 'reject') { this.err('PL1201', e, 'a reject property reads the state a step starts from: pre.f, not post.f (PT5)'); return ERR; }
          this.resolve(obj, obj.name === 'pre' ? { k: 'pre' } : { k: 'post' });
          const t = fields.get(e.prop);
          if (!t) { this.err('PL1001', e, `unknown field ${e.prop}`); return ERR; }
          return t;
        }
        // S25: `r.f` reads a field of a record value.
        const ot = this.typeOf(e.object, scope);
        // PS1.4b: `x.count` is the one field of an Items a module reads.
        if (ot.k === 'items') {
          if (e.prop !== 'count') { this.err('PL1209', e, `an Items is opaque: a module reads only its count, not ${e.prop} (PS1.4b)`); return ERR; }
          this.resolve(e, { k: 'recordField', field: 'count' });
          return { k: 'int', lo: 0, hi: this.itemsLimit() };
        }
        if (ot.k === 'record') {
          const f = this.env.records.get(ot.name)!.fields.find((x) => x.name === e.prop);
          if (!f) { this.err('PL1001', e, `${ot.name} has no field ${e.prop}`); return ERR; }
          this.resolve(e, { k: 'recordField', field: e.prop });
          return this.tyOf(f.type);
        }
        if (ot.k === 'error') return ERR;
        this.err('PL1201', e, `field access .${e.prop} is only pre.f or post.f, in step and reject properties, pre.f in handlers, and r.f of a record`);
        return ERR;
      }
      case 'Index': {
        const inf = this.instanceForm(e, scope);
        if (inf === 'error') return ERR;
        if (inf) { this.err('PL1201', e, `${inf.name}[…] is an instance; read a field, ${inf.name}[i].f, or test it with is (S32)`); return ERR; }
        const mt = this.typeOf(e.object, scope);
        if (mt.k !== 'map') { if (mt.k !== 'error') this.err('PL1201', e, `indexing needs a map, not ${tyToString(mt)}`); this.typeOf(e.index, scope); return ERR; }
        const kt = this.typeOf(e.index, scope, mt.key);
        if (!same(kt, mt.key)) this.err('PL1201', e.index, `key has type ${tyToString(kt)}, the map's keys are ${tyToString(mt.key)}`);
        else this.keyInRange(kt, mt.key, e.index);
        return mt.value;
      }
      case 'Call': {
        if (e.callee === 'rejected' && scope.ctx === 'reject') {
          if (e.args.length !== 1 || e.args[0].kind !== 'String') { this.err('PL1201', e, 'rejected takes one reason string: rejected("reason")'); return ERR; }
          this.record(e.args[0], { k: 'string' });
          return BOOL;
        }
        // PS13.6: count, sum, all and any over the members of one group, and init(e), in a configuration property.
        if (scope.config && ['count', 'sum', 'all', 'any'].includes(e.callee)) {
          if (e.args.length !== 1) { this.err('PL1201', e, `${e.callee} takes one expression over a group's members, as in ${e.callee}(g[*] is C)`); return ERR; }
          const groups = starGroups(e.args[0], scope.config);
          if (groups.length !== 1) { this.err('PL1201', e, `${e.callee}(…) ranges over one group, written g[*] (PS13.6)`); return ERR; }
          const inner: Scope = { ...scope, star: true };
          if (e.callee === 'sum') {
            const t = this.typeOf(e.args[0], inner);
            if (t.k !== 'int' && t.k !== 'error') this.err('PL1201', e, `sum adds ints, not ${tyToString(t)}`);
            return INT;
          }
          this.expectBool(e.args[0], inner);
          return e.callee === 'count' ? { k: 'int', lo: 0, hi: scope.config.instances.get(groups[0])!.count! } : BOOL;
        }
        if (scope.config && e.callee === 'init') {
          if (e.args.length !== 1) { this.err('PL1201', e, 'init takes one expression: init(x.f)'); return ERR; }
          if (scope.config.inInit) { this.err('PL1201', e, 'init(…) inside init(…) says nothing more; write init once'); return ERR; }
          return this.typeOf(e.args[0], { ...scope, config: { ...scope.config, inInit: true } }, expected);
        }
        // S49: count, sum, all and any over a family's spawned members, in a compose invariant.
        if (scope.ctx === 'compose' && ['count', 'sum', 'all', 'any'].includes(e.callee)) {
          if (e.args.length !== 1) { this.err('PL1201', e, `${e.callee} takes one expression over a family's members, as in ${e.callee}(children.f[*].x == V)`); return ERR; }
          const fams = starFamilies(e.args[0]);
          if (fams.length !== 1) { this.err('PL1201', e, `${e.callee}(…) ranges over one family, written children.f[*] (S49)`); return ERR; }
          const inner: Scope = { ...scope, star: true };
          if (e.callee === 'sum') {
            const t = this.typeOf(e.args[0], inner);
            if (t.k !== 'int' && t.k !== 'error') this.err('PL1201', e, `sum adds ints, not ${tyToString(t)}`);
            return INT;
          }
          this.expectBool(e.args[0], inner);
          const r = this.facts!.families.get(fams[0]);
          return e.callee === 'count' ? { k: 'int', lo: 0, hi: r ? r.hi - r.lo + 1 : 0 } : BOOL;
        }
        if (e.callee === 'count' || e.callee === 'before') { this.err('PL1201', e, `${e.callee}(…) is read only in a path property (PS5.4)`); return ERR; }
        this.err('PL1001', e, `unknown function ${e.callee}; expressions call no functions (PT2.2)`);
        return ERR;
      }
      case 'Unary': {
        if (e.op === '!') { this.expectBool(e.arg, scope); return BOOL; }
        const t = this.typeOf(e.arg, scope);
        if (t.k === 'principal') { this.err('PL1206', e, 'a Principal is opaque: unary - is not defined on it (PD5.1.2b)'); return ERR; }
        if (t.k === 'content') { this.err('PL1209', e, 'a Content is opaque: unary - is not defined on it (PS1.4a)'); return ERR; }
        if (t.k === 'key') { this.err('PL1209', e, 'a Key is opaque: unary - is not defined on it (PS1.4c)'); return ERR; }
        if (t.k !== 'int') { if (t.k !== 'error' && t.k !== 'conf') this.err('PL1201', e, `unary - needs an int, not ${tyToString(t)}`); return ERR; }
        return { k: 'int', lo: -t.hi, hi: -t.lo };
      }
      case 'Binary': return this.binary(e, scope);
      case 'Spawned': {
        if (scope.ctx !== 'compose') { this.err('PL1201', e, `${e.key} spawned is read only in a compose invariant (PT7)`); return BOOL; }
        if (e.index) {
          if (!this.facts!.families.has(e.key)) this.err('PL1001', e, `${this.machine!.name} spawns no family ${e.key}`);
          const it = this.typeOf(e.index, scope);
          if (it.k !== 'int' && it.k !== 'error') this.err('PL1201', e.index, `an index is an int, not ${tyToString(it)}`);
          if (this.facts!.families.has(e.key)) this.inFamily(it, this.facts!.children.keys(), e.index, e.key);
        } else if (!this.facts!.children.has(e.key)) this.err('PL1001', e, `${this.machine!.name} spawns no attached child ${e.key}`);
        return BOOL;
      }
      case 'Quant': {
        // PS13.6: `forall i in g: e` and `exists i in g: e` over the members of a group of a configuration.
        if (scope.config) {
          const g = scope.config.instances.get(e.group);
          if (!g || g.count === null) { this.err('PL1001', e, `${e.group} is not a group of this configuration`); return BOOL; }
          const inner: Scope = { ...scope, locals: new Map(scope.locals) };
          inner.locals.set(e.var, { ty: { k: 'int', lo: 0, hi: g.count - 1 }, res: { k: 'let', name: e.var } });
          this.expectBool(e.body, inner);
          return BOOL;
        }
        // S49: `forall i in f: e` and `exists i in f: e` over the indices of a family, in a compose invariant.
        if (scope.ctx !== 'compose') { this.err('PL0901', e, `${e.q} over a group is checked in compose invariants now, and in configurations from plan step 8`); return BOOL; }
        const range = this.facts!.families.get(e.group);
        if (!range) { this.err('PL1001', e, `${this.machine!.name} spawns no family ${e.group}`); return BOOL; }
        const inner: Scope = { ...scope, locals: new Map(scope.locals) };
        inner.locals.set(e.var, { ty: { k: 'int', lo: range.lo, hi: range.hi }, res: { k: 'let', name: e.var } });
        this.expectBool(e.body, inner);
        return BOOL;
      }
      case 'Emits':
        // PS5.2, S178: the step's intents are read only in a step property.
        if (scope.ctx !== 'step') { this.err('PL1201', e, 'emits reads the intents of a step, so only a step property reads it (PS5.2)'); return BOOL; }
        this.emitsFilter(e, e.effect, e.fields);
        return BOOL;
      case 'Star':
        if (scope.config) { this.err('PL5403', e, '[*] stands for every member of a group only inside count, sum, all or any (PS13.6)'); return ERR; }
        this.err('PL1201', e, '[*] stands for the members of a family inside count, sum, all or any (S49)');
        return ERR;
      case 'Is': {
        const inf = this.instanceForm(e.expr, scope);
        if (inf === 'error') return BOOL;
        if (inf) { this.configIs(e, inf); return BOOL; }
        // Review B-F4: x.f is C on an instance of a used module's machine reads C in that module's types.
        const owner = e.expr.kind === 'Member' ? this.instanceForm(e.expr.object, scope) : null;
        if (owner && owner !== 'error' && owner.facts.env && owner.facts.env !== this.env && e.expr.kind === 'Member') {
          const ft = owner.facts.fieldTypes.get(e.expr.prop);
          if (!ft) { this.err('PL1001', e.expr, `${owner.machine.name} has no field ${e.expr.prop}`); return BOOL; }
          const u = ft.k === 'union' ? owner.facts.env.unions.get(ft.name) : undefined;
          if (!u) { this.err('PL1201', e, `\`is\` needs a union value, not ${tyToString(ft)}`); return BOOL; }
          for (const c of e.ctors) if (!u.ctors.some((x) => x.name === c)) this.err('PL1201', e, `${c} is not a constructor of ${u.name}`);
          return BOOL;
        }
        const t = this.typeOf(e.expr, scope);
        if (t.k !== 'union') { if (t.k !== 'error') this.err(t.k === 'content' || t.k === 'key' ? 'PL1209' : 'PL1201', e, `\`is\` needs a union value, not ${tyToString(t)}`); return BOOL; }
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
        if (expected?.k === 'record') return this.recordLit(e, expected, scope);
        if (expected?.k === 'error') return ERR;
        // S25: `{ k: v }` is a map or a record by its expected type; with none, it is ambiguous.
        if (!expected) { this.err('PL1005', e, 'a literal { … } is a map or a record by the type it is given; give it one (S25)'); return ERR; }
        if (expected.k !== 'map') { this.err('PL1201', e, `a literal { … } is a map or a record, and ${tyToString(expected)} is expected here`); return ERR; }
        const keys = this.keyValues(expected.key);
        const seen: unknown[] = [];
        // One mistake, one diagnostic (M1-4): a key of the wrong type is reported once, and coverage is
        // judged only when every key given is a key of the map, so a wrong key does not also read as a missing one.
        let everyKeyValid = true;
        for (const en of e.entries) {
          const kt = this.typeOf(en.key, scope, expected.key);
          // A bare name is a constant key only when it resolved to a constructor; a parameter, a local or a field
          // spelled like one is a value, not a key the literal can be checked against (polywatch).
          const res = en.key.kind === 'Name' ? this.facts?.resolutions.get(en.key.id) : undefined;
          const kv = res && res.k !== 'ctor' ? undefined : this.fold(en.key);
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

  /**
   * PS5.2, S178: `emits(k, f: v, …)` and `never … emit k(f: v, …)`. k names an effect of the machine; a send, a timer or
   * a spawn is not one (PL1001). Each f is a payload field of k (PL1001), and each v a constant of its type (PL1201).
   */
  private emitsFilter(at: A.NodeBase, name: string, fields: A.EmitsField[]): void {
    const f = this.facts!;
    const eff = f.effects.get(name);
    // PS15.3: c.reply and c.template are messages to a channel's conversation after the expansion, not effects.
    if (!eff && name.includes('.')) { this.err('PL1001', at, `${name} is a message to channel ${name.slice(0, name.indexOf('.'))}'s conversation, a send after the expansion (PS15.3), not an effect of ${this.machine!.name}; state the rule on the conversation, whose never statements are checked alone and in the channel's configuration (S178)`); return; }
    if (!eff) {
      const timer = f.timerKeys.has(name) || [...f.timerKeys].some((k) => new RegExp(`^${name}\\d+$`).test(k));
      const child = f.children.has(name) || f.families.has(name) || f.detached.has(name);
      const what = timer ? 'a timer' : child ? 'a spawned child' : this.actions.has(name) ? 'an action, which a send or a timer delivers' : null;
      this.err('PL1001', at, what ? `${name} is ${what}, not an effect: emits names an effect, never a send, a timer or a spawn (PS5.2, S178)` : `${this.machine!.name} declares no effect ${name} (PS5.2)`);
      return;
    }
    const seen = new Set<string>();
    for (const x of fields) {
      if (seen.has(x.name)) this.err('PL1002', x, `the filter names ${x.name} twice`);
      seen.add(x.name);
      const p = eff.params.find((q) => q.name === x.name);
      if (!p) { this.err('PL1001', x, `effect ${name} has no payload field ${x.name} (PS5.2)`); continue; }
      this.emitsConstant(x.value, this.tyOf(p.type), `${name}.${x.name}`);
    }
    // Review D-F2: an intent carries its effect's kind, not its name, so emits cannot tell apart two effects of one kind.
    const twins = [...f.effects.values()].filter((o) => o !== eff && effectKind(o) === effectKind(eff)).map((o) => o.name);
    if (twins.length) this.err('PL1201', at, `emits ${name} cannot be told from ${twins.join(' and ')}: they share the kind "${effectKind(eff)}", and an intent carries only its kind (PS5.2)`);
  }

  /** PS5.2: a field filter's value is a constant of the field's type: an enum constructor, an integer, a boolean, or none. */
  private emitsConstant(v: A.Expr, ty: Ty, what: string): void {
    const bad = (why: string) => this.err('PL1201', v, `${what} is compared with ${why}; a filter takes a constant of the field's type: an enum constructor, an integer, a boolean or none (PS5.2)`);
    if (ty.k === 'error') return;
    const n = v.kind === 'Int' ? v.value : v.kind === 'Unary' && v.op === '-' && v.arg.kind === 'Int' ? -v.arg.value : null;
    if (n !== null) { if (ty.k !== 'int' || n < ty.lo || n > ty.hi) bad(`${n}, not a value of ${tyToString(ty)}`); return; }
    if (v.kind === 'Bool') { if (ty.k !== 'bool') bad(`a boolean, not a value of ${tyToString(ty)}`); return; }
    if (v.kind === 'Name' && v.name === 'none') { if (ty.k !== 'content' && ty.k !== 'principal' && ty.k !== 'key') bad(`none, not a value of ${tyToString(ty)}`); return; }
    // A bare name is a constructor, never a field (review D-F6); `T.C` names it with its type.
    const ctor = v.kind === 'Name' ? v.name : v.kind === 'Member' && v.object.kind === 'Name' && ty.k === 'union' && v.object.name === ty.name ? v.prop : null;
    if (ctor !== null) {
      const u = ty.k === 'union' ? this.env.unions.get(ty.name) : undefined;
      if (!u?.isEnum || !u.ctors.some((c) => c.name === ctor)) bad(`${ctor}, not a constructor of ${tyToString(ty)}`);
      return;
    }
    bad('an expression that is not a constant');
  }

  /** PS5.2a: while P reads the pre-state alone: its fields, and neither post., pre., a parameter, action nor emits. */
  private neverCond(cond: A.Expr): void {
    const fields = new Set(this.machine!.fields.map((f) => f.name));
    let ok = true;
    const no = (n: A.NodeBase, what: string) => { ok = false; this.err('PL1201', n, `while reads ${what}; it is a predicate on the pre-state's fields alone (PS5.2a)`); };
    const walk = (x: unknown): void => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      const n = x as A.Expr;
      if (n.kind === 'Member' && n.object.kind === 'Name' && (n.object.name === 'pre' || n.object.name === 'post')) { no(n, `${n.object.name}.${n.prop}`); return; }
      if (n.kind === 'Emits') { no(n, 'emits'); return; }
      if (n.kind === 'Name' && !fields.has(n.name) && (n.name === 'action' || this.isParamOfSomeAction(n.name))) { no(n, n.name === 'action' ? 'action' : `the parameter ${n.name}`); return; }
      for (const [k, v] of Object.entries(n)) if (k !== 'span') walk(v);
    };
    walk(cond);
    if (ok) this.expectBool(cond, this.scope('invariant'));
  }

  private isParamOfSomeAction(n: string): boolean {
    for (const a of this.actions.values()) if (a.params.some((p) => p.name === n)) return true;
    return false;
  }

  /** A record literal (S25): every field of the record once, each value of its field's type (PL1502 for a missing one). */
  private recordLit(e: A.MapLit, t: { k: 'record'; name: string }, scope: Scope): Ty {
    const r = this.env.records.get(t.name)!;
    const given = new Set<string>();
    let ok = true;
    for (const en of e.entries) {
      if (en.key.kind !== 'Name') { this.err('PL1201', en.key, `a field of ${r.name} is named, not computed`); ok = false; continue; }
      const f = r.fields.find((x) => x.name === (en.key as A.NameRef).name);
      if (!f) { this.err('PL1001', en.key, `${r.name} has no field ${en.key.name}`); ok = false; this.typeOf(en.value, scope); continue; }
      if (given.has(f.name)) { this.err('PL1502', en.key, `field ${f.name} is listed twice`); ok = false; }
      given.add(f.name);
      const ft = this.tyOf(f.type);
      const vt = this.typeOf(en.value, scope, ft);
      if (!same(vt, ft)) this.err('PL1201', en.value, `${r.name}.${f.name} is ${tyToString(ft)}, and the value is ${tyToString(vt)}`);
    }
    const missing = r.fields.filter((f) => !given.has(f.name)).map((f) => f.name);
    if (ok && missing.length) this.err('PL1502', e, `a record literal lists every field; missing ${missing.join(', ')} (S25)`);
    return t;
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
        let right: Scope = known ? { ...scope, knownAction: known, params: this.paramsOf(known, scope) } : scope;
        // S48: `k spawned` on the left establishes the child k on the right, as `action == A` does its parameters.
        const born = e.op !== '||' && scope.spawned ? spawnedKeys(e.left) : [];
        if (born.length) right = { ...right, spawned: new Set([...scope.spawned!, ...born]) };
        this.expectBool(e.right, right);
        return BOOL;
      }
      case '==':
      case '!=': {
        // S22: each side is typed first; an ambiguous constructor on either side takes the other side's type.
        let l: Ty;
        let r: Ty;
        const literal = (x: A.Expr) => x.kind === 'MapLit' || x.kind === 'ArrayLit';
        if ((this.ambiguousCtor(e.left, scope) && !this.ambiguousCtor(e.right, scope)) || (literal(e.left) && !literal(e.right))) {
          r = this.typeOf(e.right, scope);
          l = this.typeOf(e.left, scope, r);
        } else {
          l = this.typeOf(e.left, scope);
          r = this.typeOf(e.right, scope, l);
        }
        if (l.k === 'conf' || r.k === 'conf') return this.confCompare(e, l, r);
        // PD5.1.2b: a Principal is compared only with a Principal (or none).
        if ((l.k === 'principal' || r.k === 'principal') && !same(l, r)) { this.err('PL1206', e, `a Principal is opaque: it is compared only with another Principal, not with ${tyToString(l.k === 'principal' ? r : l)} (PD5.1.2b)`); return BOOL; }
        if ((l.k === 'content' || r.k === 'content') && !same(l, r)) { this.err('PL1209', e, `a Content is opaque: it is compared only with another Content or none, not with ${tyToString(l.k === 'content' ? r : l)} (PS1.4a)`); return BOOL; }
        // PS1.4c, S451: a Key is compared only with another Key or none.
        if ((l.k === 'key' || r.k === 'key') && !same(l, r)) { this.err('PL1209', e, `a Key is opaque: it is compared only with another Key or none, not with ${tyToString(l.k === 'key' ? r : l)} (PS1.4c)`); return BOOL; }
        // PS1.4b: an Items is passed and its count read; it is never compared.
        if (l.k === 'items' || r.k === 'items') { this.err('PL1209', e, 'an Items is opaque: it is passed and its count read, never compared (PS1.4b)'); return BOOL; }
        if (!same(l, r)) this.err('PL1201', e, `cannot compare ${tyToString(l)} with ${tyToString(r)}`);
        return BOOL;
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const l = this.typeOf(e.left, scope);
        const r = this.typeOf(e.right, scope);
        if (l.k === 'conf' || r.k === 'conf') return this.confCompare(e, l, r);
        if (l.k === 'principal' || r.k === 'principal') { this.err('PL1206', e, `a Principal is opaque and has no order: ${e.op} is not defined on it (PD5.1.2b)`); return BOOL; }
        if (l.k === 'key' || r.k === 'key') { this.err('PL1209', e, `a Key is opaque and has no order: ${e.op} is not defined on it (PS1.4c)`); return BOOL; }
        if (l.k === 'content' || r.k === 'content' || l.k === 'items' || r.k === 'items') { this.err('PL1209', e, `a ${l.k === 'items' || r.k === 'items' ? 'Items' : 'Content'} is opaque and has no order: ${e.op} is not defined on it (PS1.4a, PS1.4b)`); return BOOL; }
        if ((l.k !== 'int' && l.k !== 'error') || (r.k !== 'int' && r.k !== 'error')) this.err('PL1201', e, `${e.op} compares ints, not ${tyToString(l)} and ${tyToString(r)}`);
        return BOOL;
      }
      default: {
        const l = this.typeOf(e.left, scope);
        const r = this.typeOf(e.right, scope);
        // PD1.3b: arithmetic on a Conf is PL1205, reported once at the Conf by confUses.
        if (l.k === 'conf' || r.k === 'conf') return ERR;
        if (l.k === 'principal' || r.k === 'principal') { this.err('PL1206', e, `a Principal is opaque: ${e.op} is not defined on it (PD5.1.2b)`); return ERR; }
        if (l.k === 'key' || r.k === 'key') { this.err('PL1209', e, `a Key is opaque: ${e.op} is not defined on it (PS1.4c)`); return ERR; }
        if (l.k === 'content' || r.k === 'content' || l.k === 'items' || r.k === 'items') { this.err('PL1209', e, `a ${l.k === 'items' || r.k === 'items' ? 'Items' : 'Content'} is opaque: ${e.op} is not defined on it (PS1.4a, PS1.4b)`); return ERR; }
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

/** An index as the narrowing records it: a name, a number, or the expression's shape (S49). */
function indexText(e: A.Expr): string {
  if (e.kind === 'Name') return e.name;
  if (e.kind === 'Int') return String(e.value);
  if (e.kind === 'Binary' && e.right.kind === 'Int') return `${indexText(e.left)}${e.op}${e.right.value}`;
  return '?';
}

/** The groups of a configuration an aggregate's expression reads with `g[*]` (PS13.6). */
function starGroups(e: A.Expr, cfg: ConfigScope): string[] {
  const out = new Set<string>();
  const walk = (x: unknown): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const n = x as A.Expr;
    if (n.kind === 'Index' && n.index.kind === 'Star' && n.object.kind === 'Name' && cfg.instances.has(n.object.name)) out.add(n.object.name);
    // S176: the group of a used module's machine, m.M[*].
    if (n.kind === 'Index' && n.index.kind === 'Star' && n.object.kind === 'Member') { const q = dottedName(n.object); if (q && cfg.instances.has(q)) out.add(q); }
    for (const [k, v] of Object.entries(x)) if (k !== 'span') walk(v);
  };
  walk(e);
  return [...out];
}

/** `a.b.c` as the string it spells, or null when the chain has anything but names and members (review B-F5). */
function dottedName(e: A.Expr): string | null {
  if (e.kind === 'Name') return e.name;
  if (e.kind === 'Member') { const o = dottedName(e.object); return o === null ? null : `${o}.${e.prop}`; }
  return null;
}

/** The families an aggregate's expression reads with `[*]`. */
function starFamilies(e: A.Expr): string[] {
  const out = new Set<string>();
  const walk = (x: unknown): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const n = x as A.Expr;
    if (n.kind === 'Index' && n.index.kind === 'Star' && n.object.kind === 'Member') out.add(n.object.prop);
    for (const [k, v] of Object.entries(x)) if (k !== 'span') walk(v);
  };
  walk(e);
  return [...out];
}

/** What a loop body may hold (S49): intents other than send, and writes (a whole write fails PL2102 on its second copy). */
function loopStatement(b: A.Stmt): boolean {
  return (b.kind === 'Intent' && b.op !== 'send') || b.kind === 'MapUpdate' || b.kind === 'Assign';
}

/** A map key that is a literal, as a loop copy writes it (S49). */
function constantKey(e: A.Expr, resolutions: Map<string, Resolution>): string | null {
  if (e.kind === 'Int') return String(e.value);
  if (e.kind === 'String') return JSON.stringify(e.value);
  // S55: a constructor is a constant key, written bare or with its type.
  const r = resolutions.get(e.id);
  if (r?.k === 'ctor') return `${r.union}.${r.ctor}`;
  return null;
}

/** Whether a key is a member of a family: f1 of f (S49). */
function memberOf(key: string, family: string): boolean {
  return key.startsWith(family) && /^\d+$/.test(key.slice(family.length));
}

/** An enclosing loop: its variable and the indices it takes (S49). */
interface Loop { var: string; lo: number; hi: number }

/** The indices an index expression takes inside the loops around it: the loop variable, it plus or minus a constant, or a constant. */
function indexRange(e: A.Expr, loops: Loop[]): { lo: number; hi: number } | null {
  if (e.kind === 'Int') return { lo: e.value, hi: e.value };
  if (e.kind === 'Name') { const l = loops.find((x) => x.var === e.name); return l ? { lo: l.lo, hi: l.hi } : null; }
  if (e.kind === 'Binary' && (e.op === '+' || e.op === '-') && e.right.kind === 'Int') {
    const r = indexRange(e.left, loops);
    const c = e.op === '+' ? e.right.value : -e.right.value;
    return r ? { lo: r.lo + c, hi: r.hi + c } : null;
  }
  return null;
}

/** The keys of a family over a range: f with 1..2 is f1 and f2 (S49). */
export function keysOf(name: string, r: { lo: number; hi: number }): string[] {
  return Array.from({ length: Math.max(0, r.hi - r.lo + 1) }, (_, k) => `${name}${r.lo + k}`);
}

/** A key's index when it is a constant (inside an unrolled copy, the loop variable is one). */
function constantIndex(e: A.Expr): number | null {
  const r = indexRange(e, []);
  return r && r.lo === r.hi ? r.lo : null;
}

/** A copy of a loop body with the loop variable replaced by an integer literal, for the per-path rules (S49). */
function substitute(body: A.Stmt[], v: string, k: number): A.Stmt[] {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== 'object') return x;
    const n = x as { kind?: string; name?: string };
    if (n.kind === 'Name' && n.name === v) return { ...(x as object), kind: 'Int', value: k };
    return Object.fromEntries(Object.entries(x).map(([key, val]) => [key, key === 'span' ? val : walk(val)]));
  };
  return walk(body) as A.Stmt[];
}

/** A spawn's child as a ChildSpec: its machine id `<module>.<Machine>` (S28), creation action and wiring. */
export function childSpec(s: A.IntentStmt, module: string): ChildSpec {
  const pair = (tag: string) => { const i = s.extra.indexOf(tag); return i >= 0 ? s.extra[i + 1] : null; };
  // S28, S176: the machine id is module.Machine; a used module's machine is written qualified, as its id.
  const parts = s.target.split('.');
  const name = parts[parts.length - 1];
  return { key: s.as ?? '', machine: parts.length > 1 ? s.target : `${module}.${name}`, create: pair('create'), onComplete: pair('complete'), onParentTerminal: pair('parent-terminal') };
}

function spawnsOrSignals(m: A.Machine): boolean {
  const walk = (body: A.Stmt[]): boolean => body.some((s) => (s.kind === 'Intent' && (s.op === 'spawn' || s.op === 'signal')) || (s.kind === 'If' && (walk(s.then) || walk(s.else ?? []))) || (s.kind === 'Match' && s.arms.some((a) => walk(a.body))) || (s.kind === 'For' && walk(s.body)));
  return m.items.some((i) => i.kind === 'Handler' && walk(i.body));
}

/** The keys a conjunction of `k spawned` establishes (S48). */
function spawnedKeys(e: A.Expr): string[] {
  if (e.kind === 'Spawned') return [e.index ? `${e.key}[${indexText(e.index)}]` : e.key];
  if (e.kind === 'Binary' && e.op === '&&') return [...spawnedKeys(e.left), ...spawnedKeys(e.right)];
  return [];
}

/** The intent kinds the kernel reads itself (PT6.3, PT6.4, PT7a). */
const KERNEL_KINDS = new Set(['timer', 'cancelTimer', 'spawnChild', 'signalChild', 'sendTo', 'createInstance']);

// PT6.2: the closed Polyaxion vocabulary.
/** PT6.5: the labels that grant each kind of target's capability. */
const GRANTS: Record<string, string[]> = { egress: ['egress:external', 'egress:public'], secrets: ['read:private'], exec: ['exec'], store: ['read:store', 'write:store'] };

export const LABELS = new Set(['read:repo', 'read:private', 'read:store', 'read:web', 'write:store', 'write:repo', 'write:workspace', 'egress:public', 'egress:external', 'exec', 'admin']);
const CLASSES = new Set(['none', 'reversible', 'compensable', 'irreversible']);

/** PS17.0: the kinds of source, and the source adapters poly-io makes (PS17.0, S308). */
export const SOURCE_KINDS = new Set(['records', 'documents', 'memory']);
export const SOURCE_ADAPTERS = new Set(['postgres', 'opensearch']);

/**
 * S41: an effect with no `kind` has its name as its kind; PS17.2, PS17.5: a retrieval's and a remember's are the
 * runtime's, and an envelope retrieval's is source.<s>.envelope (S459), labelled as a retrieval of s by effectLabels.
 */
export function effectKind(e: A.EffectDecl): string {
  for (const it of e.items) {
    if (it.kind === 'EffRetrieve') return `source.${it.source}.${it.envelope ? 'envelope' : 'retrieve'}`;
    if (it.kind === 'EffRemember') return `source.${it.source}.remember`;
  }
  for (const it of e.items) if (it.kind === 'EffKind') return it.value;
  return e.name;
}

/**
 * PT6.2, PS17.2: an effect's labels: as written, or, for a retrieval, read:private when its source is owned or above the
 * lowest class and read:store otherwise, and for a remember, write:store.
 */
export function effectLabels(e: A.EffectDecl, module: A.Module): string[] | null {
  for (const it of e.items) {
    if (it.kind !== 'EffRetrieve' && it.kind !== 'EffRemember') continue;
    if (it.kind === 'EffRemember') return ['write:store'];
    const s = module.decls.find((d): d is A.SourceDecl => d.kind === 'Source' && d.name === it.source);
    const lowest = module.decls.find((d): d is A.AudienceDecl => d.kind === 'Audience')?.classes[0];
    return [s && (s.owned || s.audience !== lowest) ? 'read:private' : 'read:store'];
  }
  for (const it of e.items) if (it.kind === 'EffLabels') return it.labels;
  return null;
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

/** S41: what must agree between effects that share a kind: the payload, the completions and the class. */
export function effectSignature(e: A.EffectDecl): string {
  const strip = (x: unknown): unknown => {
    if (!x || typeof x !== 'object') return x;
    if (Array.isArray(x)) return x.map(strip);
    return Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'id' && k !== 'span' && k !== 'comments').map(([k, v]) => [k, strip(v)]));
  };
  const outcomes = e.items.filter((i) => i.kind === 'EffOutcome').map(strip).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // PT10e: the credential an effect uses is in its manifest entry, so effects that share a kind use the same one.
  const uses = e.items.find((i) => i.kind === 'EffUses');
  // PS17.3a (S459): and so is its envelope parameter, which the runtime's origin check reads.
  const envelope = e.items.find((i) => i.kind === 'EffEnvelope');
  return JSON.stringify({ params: e.params.map((p) => [p.name, strip(p.type)]), outcomes, cls: effectClass(e), ...(uses ? { uses: strip(uses) } : {}), ...(envelope ? { envelope: envelope.param } : {}) });
}

/** `before("k1", "k2")` (S37): the two kinds, in order. */
export function beforeKinds(e: A.Expr): { first: { kind: string; at: A.NodeBase }; then: { kind: string; at: A.NodeBase } } | null {
  if (e.kind !== 'Call' || e.callee !== 'before' || e.args.length !== 2) return null;
  const [a, b] = e.args;
  if (a.kind !== 'String' || b.kind !== 'String') return null;
  return { first: { kind: a.value, at: a }, then: { kind: b.value, at: b } };
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

/**
 * The names an expression reads, with each `let` name replaced by the names it reads. `pre.f` always
 * names the field (S19), so it is recorded as `pre.f`, apart from a bare `f` a parameter may shadow.
 */
function readsOf(e: A.Expr, lets: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  const walk = (x: unknown): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const n = x as { kind?: string; name?: string; object?: { kind?: string; name?: string }; prop?: string };
    if (n.kind === 'Member' && n.object?.kind === 'Name' && n.object.name === 'pre' && n.prop) { out.add(`pre.${n.prop}`); return; }
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
  /** Timer keys armed on this path (PT6.3, PL2301). */
  timers: Map<string, A.NodeBase>;
}

/** PD1.2b, S79: `r.x.y` as the path [x, y] when it is rooted at the bound name r; null for any other expression. */
/** Whether a type is Conf or holds one in a map (PD1.3b). Records and unions are judged at their declaration. */
function hasConf(t: A.TypeExpr): boolean {
  return t.kind === 'TConf' || (t.kind === 'TMap' && (hasConf(t.key) || hasConf(t.value)));
}

export function boundPath(e: A.Expr, bind: string): string[] | null {
  const path: string[] = [];
  let x = e;
  while (x.kind === 'Member') { path.unshift(x.prop); x = x.object; }
  return x.kind === 'Name' && x.name === bind ? path : null;
}
