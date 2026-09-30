// The combinators of poly's embedded surface (PT2.5, S71), as `tsc` checks an embedded module against them.
// They are declarations only: poly-embed reads the module's syntax with the TypeScript compiler API and never
// runs it. A name inside an arrow is a property of its parameter, `$.x`, so `$` is untyped here; the poly
// checker types the program after reading it, as it types the standalone syntax.

declare const node: unique symbol;
interface Node<K extends string> { readonly [node]: K }

export type Decl = Node<'decl'>;
export type Item = Node<'item'>;
export type Stmt = Node<'stmt'>;
export type Arm = Node<'arm'>;
export type Pattern = Node<'pattern'>;
export type Bind = Node<'bind'>;
export type EffItem = Node<'effect-item'>;
export type Instance = Node<'instance'>;
export type Field = Node<'field'>;
export type NameLiteral = Node<'name'>;

/** An expression of PT2.2; the checker types it. */
export type Expr = any;
/** The parameter of an arrow: every name of the program is a property of it. */
export type Scope = any;
export type Arrow<T = Expr> = (scope: Scope) => T;
export type Args = Expr[] | { [name: string]: Expr };
export type Literal = number | string | boolean | NameLiteral;
export type Mode = 'strict' | 'disclosed';

export interface Type {
  /** A parameter's check clause: a set of literals, or a range, and its mode. */
  check(values: Literal[], mode?: Mode): Type;
  check(lo: number, hi: number, mode?: Mode): Type;
}

export declare const t: {
  readonly bool: Type;
  readonly int: Type;
  readonly string: Type;
  range(lo: number, hi: number): Type;
  named(name: string): Type;
  map(key: Type, value: Type): Type;
  ref(machine: string): Type;
  readonly conf: Type;
};

// ── declarations ───────────────────────────────────────────────────────────
export declare function module(name: string, decls: Decl[]): Decl;
export declare function enumType(name: string, members: string[]): Decl;
export declare function union(name: string, ctors: { [ctor: string]: { [payload: string]: Type } }): Decl;
export declare function record(name: string, fields: { [field: string]: Type }): Decl;
export declare function use(path: string): Decl;
export declare function machine(name: string, body: { service?: true; version?: number; state?: { [field: string]: Field }; items?: Item[] }): Decl;
export declare function field(type: Type, init: Arrow, opts?: { check?: Literal[] | { lo: number; hi: number }; mode?: Mode; flag?: 'internal' | 'derived' }): Field;
export declare function name(ctor: string): NameLiteral;
export declare function configuration(name: string, body: { instances: Instance[]; inputs?: string[]; bounds?: { transit: number; instances?: number }; properties?: Item[] }): Decl;
export declare function instance(name: string, machine: string, opts?: { count?: number; init?: (scope: Scope) => { [field: string]: Expr } }): Instance;

// ── machine items ──────────────────────────────────────────────────────────
export declare function action(name: string, params: { [param: string]: Type }): Item;
export declare function on(action: string, body: (scope: Scope) => Stmt[], params?: string[]): Item;
export declare function guard(cond: Arrow, reason: string): Item;
export declare function terminal(cond: Arrow): Item;
export declare function invariant(name: string, e: Arrow): Item;
export declare function stepProperty(name: string, e: Arrow): Item;
export declare function rejectProperty(name: string, e: Arrow): Item;
export declare function pathProperty(name: string, e: Arrow): Item;
export declare function composeInvariant(name: string, e: Arrow): Item;
export declare function liveness(name: string, goal: { eventually: Arrow } | { from: Arrow; to: Arrow }, opts?: { forall?: [string, string]; exists?: [string, string]; fair?: string[][] }): Item;
export declare function effect(name: string, params: { [param: string]: Type }, items: EffItem[]): Item;
export declare function kind(kind: string): EffItem;
export declare function labels(labels: string[]): EffItem;
export declare function cls(value: 'none' | 'reversible' | 'compensable' | 'irreversible'): EffItem;
export declare function retry(attempts: number, base: string, timeout: string): EffItem;
export declare function ok(action: string, args: Args | ((scope: Scope) => Args)): EffItem;
export declare function failed(action: string, args: Args | ((scope: Scope) => Args)): EffItem;
export declare function exhausted(action: string, args: Args | ((scope: Scope) => Args)): EffItem;
/** `ok(r) -> A(p: r.x)` (PD1.2b, S79): the reply is `$.r` in the arguments' arrow. */
export declare function okWith(reply: string, action: string, args: Args | ((scope: Scope) => Args)): EffItem;

// ── decisions (PD1) ────────────────────────────────────────────────────────
export type DecisionItem = EffItem | Node<'decision-item'>;
export declare function decision(name: string, params: { [param: string]: Type }, result: Type, items: DecisionItem[]): Item;
export declare function provider(kind: string): DecisionItem;
export declare function timeout(duration: string): DecisionItem;
export declare function band(lo: number, hi: number): DecisionItem;
export declare function decide(decision: string, args: Args): Stmt;

// ── statements ─────────────────────────────────────────────────────────────
export declare function require(cond: Expr, reason: string): Stmt;
export declare function reject(reason: string): Stmt;
export declare function let_(name: string, e: Expr): Stmt;
export declare function set(field: string, e: Expr): Stmt;
export declare function setEntry(field: string, key: Expr, value: Expr, base?: string): Stmt;
export declare function when(cond: Expr, then: Stmt[], otherwise?: Stmt[]): Stmt;
export declare function match(e: Expr, arms: Arm[]): Stmt;
export declare function arm(pattern: Pattern | '_', body: Stmt[]): Arm;
export declare function pattern(ctor: string, fields?: { [payload: string]: Literal | Bind }): Pattern;
export declare function bind(name: string): Bind;
export declare function forEach(v: string, lo: number, hi: Expr, body: Stmt[]): Stmt;
export declare function emit(effect: string, args: Args): Stmt;
export declare function after(duration: string, action: string, args: Args, key: string, index?: Expr): Stmt;
export declare function cancel(key: string, index?: Expr): Stmt;
export declare function spawn(machine: string, key: string, opts?: { index?: Expr; detached?: true; create?: [string, Args]; complete?: string; parentTerminal?: string }): Stmt;
export declare function send(to: Expr, action: string, args: Args, as?: string): Stmt;
export declare function signal(key: string, index: Expr | null, action: string, args: Args): Stmt;
export declare function named(param: string, e: Expr): Expr;

// ── expressions ────────────────────────────────────────────────────────────
export declare const ALL: Expr;
/** S84: a record or map literal as an operand of an operator. */
export declare function lit(literal: { [key: string]: Expr } | Expr[]): Expr;
export declare function implies(a: Expr, b: Expr): Expr;
export declare function is(e: Expr, ...ctors: string[]): Expr;
export declare function isIn(e: Expr, set: Expr[]): Expr;
export declare function ctor(ctor: string, payload: { [payload: string]: Expr }): Expr;
export declare function spawned(key: Expr): Expr;
export declare function forall(v: string, group: string, body: Arrow): Expr;
export declare function exists(v: string, group: string, body: Arrow): Expr;
export declare function primed(field: string): Expr;
export declare function call(callee: string, ...args: Expr[]): Expr;
export declare function count(...args: Expr[]): Expr;
export declare function before(first: string, second: string): Expr;
export declare function rejected(reason: string): Expr;
export declare function init(e: Expr): Expr;
export declare function sum(e: Expr): Expr;
export declare function all(e: Expr): Expr;
export declare function any(e: Expr): Expr;
export declare function unknown(e: Expr): Expr;
