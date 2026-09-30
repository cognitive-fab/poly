// The poly AST (PT1.4, PT2). Every surface produces it: the standalone
// syntax (poly-lang) now, the embedded TypeScript surface (poly-embed) at M2.
//
// The AST is plain JSON: strings, safe integers, booleans, null, arrays and
// objects. That keeps the RFC 8785 digest simple (PT1.4) and lets poly-ref
// read it with `import type` only (PS9.3). Every node carries `id`, derived
// from its path (PT12.1), and a display-only `span`. Neither enters the
// digest. Comments are trivia and are not in the AST at all (PT1.4a).

export interface Span {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export interface NodeBase {
  id: string;
  span?: Span;
}

// ── Module and declarations ────────────────────────────────────────────────

export interface Module extends NodeBase {
  kind: 'Module';
  name: string;
  decls: Decl[];
}

export type Decl = TypeDecl | EnumDecl | RecordDecl | Machine | UseDecl | Configuration;

/**
 * `configuration c { … }` (PS13, PT7a): named instances of machines of this module, the inputs the
 * environment may inject, the bounds, and properties over the global state.
 */
export interface Configuration extends NodeBase {
  kind: 'Configuration';
  name: string;
  instances: ConfigInstance[];
  inputs: InputRef[];
  bounds: ConfigBounds | null;
  properties: (Property | Liveness)[];
}

/** `x : M { f: e, … }`, or a group `g[n] : M { … }` of n instances g[0] … g[n-1] (PS13.1). */
export interface ConfigInstance extends NodeBase {
  kind: 'ConfigInstance';
  name: string;
  /** The group's size, or null for a single instance. */
  count: number | null;
  machine: string[];
  /** Initial values that replace the machine's own, addresses included (PS13.1). */
  init: { field: string; value: Expr }[];
}

/** `x.A`, `g[i].A` or `g[*].A` (S31): an action the environment may inject at those instances. */
export interface InputRef extends NodeBase {
  kind: 'InputRef';
  instance: string;
  index: number | '*' | null;
  action: string;
}

/** `bounds { transit B, instances N }` (PS13.1, PS13.5). */
export interface ConfigBounds extends NodeBase {
  kind: 'ConfigBounds';
  transit: number;
  instances: number | null;
}

/** `type R = { f1: T1, …, fn: Tn }` (S25): a nominal record, every field present, no tag. */
export interface RecordDecl extends NodeBase {
  kind: 'RecordDecl';
  name: string;
  fields: PayloadField[];
}

/** `type U = C1 { p: T } | C2` (PT2, PS1.4). */
export interface TypeDecl extends NodeBase {
  kind: 'TypeDecl';
  name: string;
  ctors: Ctor[];
}

/** `enum E { A, B }`: a union whose constructors carry no payload (PT3.1). */
export interface EnumDecl extends NodeBase {
  kind: 'EnumDecl';
  name: string;
  members: string[];
}

export interface Ctor extends NodeBase {
  kind: 'Ctor';
  name: string;
  fields: PayloadField[];
}

export interface PayloadField extends NodeBase {
  kind: 'PayloadField';
  name: string;
  type: TypeExpr;
}

export interface UseDecl extends NodeBase {
  kind: 'Use';
  path: string[];
}

// ── Types and check domains (PT3) ──────────────────────────────────────────

export type TypeExpr = TBool | TInt | TString | TName | TRange | TMap | TRef;
export interface TBool extends NodeBase { kind: 'TBool' }
export interface TInt extends NodeBase { kind: 'TInt' }
export interface TString extends NodeBase { kind: 'TString' }
/** A declared `type` or `enum`, by name. */
export interface TName extends NodeBase { kind: 'TName'; name: string }
export interface TRange extends NodeBase { kind: 'TRange'; lo: number; hi: number }
/** `map<K, T>`: K is an enum name or an integer range 0..n (PT3.1). */
export interface TMap extends NodeBase { kind: 'TMap'; key: TName | TRange; value: TypeExpr }
/** `Ref<M>` (PS1.6). A type only in M0. */
export interface TRef extends NodeBase { kind: 'TRef'; machine: string[] }

export type CheckMode = 'strict' | 'disclosed';

export interface CheckClause extends NodeBase {
  kind: 'Check';
  domain: Domain;
  /** null when not written; the default is decided by PT3.4a. */
  mode: CheckMode | null;
}

export type Domain = DomainSet | DomainRange;
export interface DomainSet extends NodeBase { kind: 'DomainSet'; values: Literal[] }
export interface DomainRange extends NodeBase { kind: 'DomainRange'; lo: number; hi: number }

// ── Machines ───────────────────────────────────────────────────────────────

export interface Machine extends NodeBase {
  kind: 'Machine';
  name: string;
  service: boolean;
  version: number | null;
  fields: Field[];
  items: MachineItem[];
}

export interface Field extends NodeBase {
  kind: 'Field';
  name: string;
  type: TypeExpr;
  check: CheckClause | null;
  init: Expr;
  flag: 'internal' | 'derived' | null;
}

export type MachineItem = Terminal | Action | Handler | Guard | Property | Liveness | EffectDecl;

export interface Terminal extends NodeBase {
  kind: 'Terminal';
  expr: Expr;
}

export interface Action extends NodeBase {
  kind: 'Action';
  name: string;
  params: Param[];
}

export interface Param extends NodeBase {
  kind: 'Param';
  name: string;
  type: TypeExpr;
  check: CheckClause | null;
}

export interface Handler extends NodeBase {
  kind: 'Handler';
  action: string;
  /** The written parameter list, or null when omitted (PT2.4a). */
  params: string[] | null;
  body: Stmt[];
}

/** `guard all when e reject "r"` (PT4.3). */
export interface Guard extends NodeBase {
  kind: 'Guard';
  cond: Expr;
  reason: string;
}

export type PropertyForm = 'invariant' | 'step' | 'reject' | 'path' | 'compose';

export interface Property extends NodeBase {
  kind: 'Property';
  form: PropertyForm;
  name: string;
  expr: Expr;
}

export interface Liveness extends NodeBase {
  kind: 'Liveness';
  name: string;
  /** `eventually P` has no `from`; `P leads to Q` has `from = P`, `expr = Q`. */
  from: Expr | null;
  expr: Expr;
  /** `under fair { … }`, or null where it is not written: only in a configuration (S56). */
  fair: FairGroup[] | null;
  /** `forall i in g:` before the property, scoping over the whole `leads to` (PS13.6, S56). */
  quant: { q: 'forall' | 'exists'; var: string; group: string } | null;
}

export interface FairGroup extends NodeBase {
  kind: 'FairGroup';
  /** In a configuration, a member names its instances as an InputRef does (S73): `order[*].Place(*)`. */
  members: { action: string; perValue: boolean; input?: { instance: string; index: number | '*' | null } }[];
}

/** `effect k(params) { … }` (PT6.1). Parsed in M0, lowered from M1. */
export interface EffectDecl extends NodeBase {
  kind: 'EffectDecl';
  name: string;
  params: Param[];
  items: EffectItem[];
}

export type EffectItem =
  | (NodeBase & { kind: 'EffKind'; value: string })
  | (NodeBase & { kind: 'EffLabels'; labels: string[] })
  | (NodeBase & { kind: 'EffClass'; value: string })
  | (NodeBase & { kind: 'EffRetry'; attempts: number; base: string; timeout: string })
  | (NodeBase & { kind: 'EffOutcome'; outcome: 'ok' | 'failed' | 'exhausted'; action: string; args: NamedArg[] });

// ── Statements (PS2.2) ─────────────────────────────────────────────────────

export type Stmt =
  | Require
  | Reject
  | Let
  | Assign
  | MapUpdate
  | If
  | Match
  | For
  | IntentStmt;

/**
 * `for i in lo..n { … }` (S49): unrolled at compile time. `n` is an integer literal, or a field or
 * parameter whose range type bounds it; the loop runs `i` from `lo` to that bound, each copy guarded by `i <= n`.
 */
export interface For extends NodeBase { kind: 'For'; var: string; lo: number; hi: Expr; body: Stmt[] }

export interface Require extends NodeBase { kind: 'Require'; cond: Expr; reason: string }
/** `reject "r"` (S11). */
export interface Reject extends NodeBase { kind: 'Reject'; reason: string }
export interface Let extends NodeBase { kind: 'Let'; name: string; expr: Expr }
/** `f' = e`. */
export interface Assign extends NodeBase { kind: 'Assign'; field: string; expr: Expr }
/** `f' = m with [k] = v` (PT2.2). */
export interface MapUpdate extends NodeBase { kind: 'MapUpdate'; field: string; base: string; key: Expr; value: Expr }
export interface If extends NodeBase { kind: 'If'; cond: Expr; then: Stmt[]; else: Stmt[] | null }
export interface Match extends NodeBase { kind: 'Match'; scrutinee: Expr; arms: Arm[] }

export interface Arm extends NodeBase {
  kind: 'Arm';
  pattern: Pattern;
  /** One statement or a block; the formatter decides the braces (one AST, one text). */
  body: Stmt[];
}

export type Pattern = PWild | PCtor;
export interface PWild extends NodeBase { kind: 'PWild' }
export interface PCtor extends NodeBase {
  kind: 'PCtor';
  ctor: string;
  /** `{ q: 1 }` matches a literal; `{ q: n }` binds n. */
  fields: { name: string; bind: string | null; literal: Literal | null }[];
}

/** emit, after, cancel, spawn, send, signal (PS2.2, PT6). Parsed in M0, lowered from M1 (PL0901). */
export interface IntentStmt extends NodeBase {
  kind: 'Intent';
  op: 'emit' | 'after' | 'cancel' | 'spawn' | 'send' | 'signal';
  /** emit/after/send/signal: the action or effect name; spawn: the machine; cancel: the timer key. */
  target: string;
  args: NamedArg[];
  /** send: the address expression. */
  to: Expr | null;
  /** after: the duration literal; spawn: 'detached' or null. */
  modifier: string | null;
  /** after/spawn/send: the `as` name. */
  as: string | null;
  /** after/spawn: `as k[i]`; cancel: `cancel k[i]`; signal: `signal k[i]`: the index of a key family (S49). */
  index: Expr | null;
  /** signal: the child key; spawn: the creation action ('create', A) and the completion wiring, as written (S43). */
  extra: string[];
}

export interface NamedArg {
  /** null for a positional argument. */
  name: string | null;
  value: Expr;
}

// ── Expressions (PT2.2, PS12) ──────────────────────────────────────────────

export type Expr =
  | IntLit
  | BoolLit
  | StringLit
  | NameRef
  | PrimedRef
  | Member
  | Index
  | Call
  | Unary
  | Binary
  | Is
  | In
  | CtorExpr
  | MapLit
  | ArrayLit
  | Spawned
  | Star
  | Quant;

/** `g[*]` inside an aggregate: every member of a family (S49, PS13.6). */
export interface Star extends NodeBase { kind: 'Star' }
/** `forall i in g: e` and `exists i in g: e` over a family (S49) or a configuration group (PS13.6). */
export interface Quant extends NodeBase { kind: 'Quant'; q: 'forall' | 'exists'; var: string; group: string; body: Expr }

export type Literal = IntLit | BoolLit | StringLit | NameRef;

/** `k spawned` (S48): true iff the attached child k exists; only in a compose invariant. */
export interface Spawned extends NodeBase { kind: 'Spawned'; key: string; /** `f[i] spawned`: a member of a family (S49). */ index: Expr | null }
export interface IntLit extends NodeBase { kind: 'Int'; value: number }
export interface BoolLit extends NodeBase { kind: 'Bool'; value: boolean }
export interface StringLit extends NodeBase { kind: 'String'; value: string }
/** A field, parameter, let binding, constructor without payload, action name, `none` or `self`. */
export interface NameRef extends NodeBase { kind: 'Name'; name: string }
/** `f'` read in an expression: always an error (PS2.3, PL1202); kept so the fix can address it. */
export interface PrimedRef extends NodeBase { kind: 'Primed'; name: string }
/** `pre.f`, `post.f`, and field access. */
export interface Member extends NodeBase { kind: 'Member'; object: Expr; prop: string }
export interface Index extends NodeBase { kind: 'Index'; object: Expr; index: Expr }
/** `count(k)`, `before(a, b)`, `rejected("r")`, `unknown(x)`. */
export interface Call extends NodeBase { kind: 'Call'; callee: string; args: Expr[] }
export type UnaryOp = '!' | '-';
export interface Unary extends NodeBase { kind: 'Unary'; op: UnaryOp; arg: Expr }
export type BinaryOp = '*' | '/' | '%' | '+' | '-' | '<' | '<=' | '>' | '>=' | '==' | '!=' | '&&' | '||' | 'implies';
export interface Binary extends NodeBase { kind: 'Binary'; op: BinaryOp; left: Expr; right: Expr }
/** `e is C1 | C2` (PT2.4). */
export interface Is extends NodeBase { kind: 'Is'; expr: Expr; ctors: string[] }
/** `e in { v1, v2 }`. */
export interface In extends NodeBase { kind: 'In'; expr: Expr; set: Expr[] }
/** `C { q: e }`. A constructor without payload is a NameRef. */
export interface CtorExpr extends NodeBase { kind: 'CtorExpr'; ctor: string; fields: { name: string; value: Expr }[] }
/** `{ k1: v1, … }` (PT2.2, S4). */
export interface MapLit extends NodeBase { kind: 'MapLit'; entries: { key: Expr; value: Expr }[] }
/** `[v0, …, vn]` for maps keyed by 0..n (PT2.2, S4). */
export interface ArrayLit extends NodeBase { kind: 'ArrayLit'; items: Expr[] }

export type AnyNode = Module | Decl | Ctor | PayloadField | TypeExpr | CheckClause | Domain | Field | MachineItem | EffectItem | Param | Stmt | Arm | Pattern | Expr | FairGroup | ConfigInstance | InputRef | ConfigBounds;
