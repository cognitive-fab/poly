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

export type Decl = TypeDecl | EnumDecl | RecordDecl | Machine | UseDecl | Configuration | Policy | Workflow | Channel | Credential | AudienceDecl | SourceDecl | Route | Budget;

// ── Memory (PT23, PS17, M10) ───────────────────────────────────────────────

/** `audience { a1 < a2 < … }` (PS1.4b, Q3): the enum Audience, its members in a total order, the first the lowest. */
export interface AudienceDecl extends NodeBase {
  kind: 'Audience';
  classes: string[];
}

/**
 * `source s: k { adapter "a"  audience c [owned]  freshness d [stale escalate | stale deny] }` (PS17.0): where items
 * come from, the class every item has, whether each has an owner, and how old an item may be.
 */
export interface SourceDecl extends NodeBase {
  kind: 'Source';
  name: string;
  /** records, documents or memory. */
  sourceKind: string;
  adapter: string | null;
  audience: string;
  owned: boolean;
  freshness: string | null;
  stale: 'escalate' | 'deny';
  /** PS17.0, S451: the item keys the adapter supplies with each item, in source order; absent when none are declared. */
  keys?: string[];
  /** PS17.0, S459: the key by which the adapter gives a thread's envelope; absent when the source gives none. */
  envelope?: string;
  /**
   * PS17.0, S460: the credential under whose grant the adapter reaches its provider; absent when none. Holder-less, it has
   * one grant; with holder Principal, on an owned source only, a grant per owner (S461).
   */
  credential?: string;
}

// ── Routes and budgets (PT24, PS18, M11) ───────────────────────────────────

/**
 * `route r { tier t provider "p" prices "f" [calibration "f"] max tokens n …  escalate when … or …  [budget b] }`
 * (PS18.1): the module m.r, std.routing with Route instantiated for these tiers and this condition.
 */
export interface Route extends NodeBase {
  kind: 'Route';
  name: string;
  tiers: RouteTier[];
  /** The escalation condition's terms, in the order written (PS18.1). */
  escalate: RouteTerm[];
  budget: string | null;
}
export interface RouteTier extends NodeBase {
  kind: 'RouteTier';
  name: string;
  provider: string;
  /** The price table's path, relative to the source file's directory (PS18.3). */
  prices: string;
  /** The calibration map's path, or null for a tier with none (PL6841 when the condition reads conf or margin). */
  calibration: string | null;
  /** S360: the input token limit, at the table's `input` price; `maxTokens` is the output limit. */
  maxInputTokens: number;
  maxTokens: number;
}
/** `conf < c` or `margin < c`, `c` in thousandths (PD1.3a), or `failed`. */
export type RouteTerm = { on: 'conf' | 'margin'; below: number } | { on: 'failed' };

/**
 * `budget b { cap <currency> <amount> per run | per scope | per <period> [per scope] …  [on exhausted deny | escalate] }`
 * (PS18.4): the module m.b, std.routing's Budget, one instance per cap and address.
 */
export interface Budget extends NodeBase {
  kind: 'Budget';
  name: string;
  caps: BudgetCap[];
  onExhausted: 'deny' | 'escalate';
}
export interface BudgetCap extends NodeBase {
  kind: 'BudgetCap';
  currency: string;
  /** The cap in micro-units (PS18.3). */
  amount: number;
  run: boolean;
  period: 'hour' | 'day' | 'month' | null;
  scope: boolean;
}

// ── Credentials (PT10e, S203) ──────────────────────────────────────────────

/**
 * `credential c: oauth2 { provider "p"  grant authorization_code [pkce] | client_credentials  scopes { s, ... }  holder Principal }`:
 * a credential the vault holds, named by reference only, whose provider profile is std/credentials/providers/p.json.
 */
export interface Credential extends NodeBase {
  kind: 'Credential';
  name: string;
  credKind: string;
  provider: string;
  grant: 'authorization_code' | 'client_credentials';
  pkce: boolean;
  scopes: string[];
  /** The holder's type, `Principal`, or null for a credential with no holder (the service's own). */
  holder: string | null;
}

// ── Channels (PT21.1, PS15) ────────────────────────────────────────────────

/**
 * `channel c: k { adapter "…"  thread "{f}"  starts A.S [on inbound]  P -> A.X … }` (PS15): an expansion into the
 * conversation `m.c.Conversation` of `std.channels.k`, a spawn in `starts`, sends for `emit c.reply` and `emit
 * c.template`, and the configuration `c`. Each `P -> A.X` binds a Peer action to an action of the application.
 */
export interface Channel extends NodeBase {
  kind: 'Channel';
  name: string;
  channelKind: string;
  adapter: string | null;
  thread: string;
  starts: { machine: string; action: string; onInbound: boolean } | null;
  maps: ChannelMap[];
  /** PS15, PS17.3 (S305): the class of the channel's recipients, when written. */
  audience?: string | null;
  /** PS15.0a (S450): the field of the kind's Sender claims that gives the thread its principal, when written. */
  principalFrom?: string | null;
}
export interface ChannelMap extends NodeBase { kind: 'ChannelMap'; peer: string; machine: string; action: string }

// ── Workflows (PT10, S166) ─────────────────────────────────────────────────

/**
 * `workflow w runs M { input A  key "…" where f matches "…"  tool "kind" -> t target "…" why "…" }` (PT10): a machine
 * whose effects become work orders for an agent's tools. Checked and lowered by poly, and run on poly-runtime under the
 * gate since M8a (S173 to S175).
 */
export interface Workflow extends NodeBase {
  kind: 'Workflow';
  name: string;
  /** The machine of this module the workflow runs. */
  machine: string;
  /** The action a run starts with, given the caller's input as data. */
  input: string;
  /** How a run is named from its input; null when the caller names it. */
  key: WorkflowKey | null;
  tools: WorkflowTool[];
  /** `budget b prices "f" order cap usd 0.05` (PS18.7, M7.5): the budget the workflow's orders reserve on; null when it names none. */
  budget: WorkflowBudget | null;
}

/** The participant's price table and the order cap, in micro-units of a currency (PS18.3): the reservation of each work order. */
export interface WorkflowBudget extends NodeBase { kind: 'WorkflowBudget'; name: string; prices: string; orderCap: { currency: string; amount: number } }

/** `key "{f}…" where f matches "re", …`: the template's fields are parameters of the input action. */
export interface WorkflowKey extends NodeBase { kind: 'WorkflowKey'; template: string; fields: WorkflowKeyField[] }
export interface WorkflowKeyField extends NodeBase { kind: 'WorkflowKeyField'; name: string; pattern: string }

/** `tool "kind" -> t target "x" why "y"`: the agent tool that fulfils an effect kind's work order. */
export interface WorkflowTool extends NodeBase { kind: 'WorkflowTool'; effect: string; tool: string; target: string | null; why: string }

// ── Policies (PT8, PS8) ────────────────────────────────────────────────────

/**
 * `policy p { scope "s" … }` (PT8.1): obligations the gate enforces on the proposals of a trust scope. Its
 * expressions are PX: their inputs are optional, so they have type `Tri` (PT2.3, PS8.0).
 */
export interface Policy extends NodeBase {
  kind: 'Policy';
  name: string;
  scope: string;
  /** S156: `scope "s" requires attribution`: a compensable or irreversible effect needs an origin with claims (PD5.2.3). */
  requiresAttribution?: true;
  vars: PolicyVar[];
  items: PolicyItem[];
}

/** `var n: T = e`: policy state with a finite domain (PT8.1). */
export interface PolicyVar extends NodeBase { kind: 'PolicyVar'; name: string; type: TypeExpr; init: Expr }

export type PolicyItem = RuleObligation | MachineObligation | InvariantObligation | Recalled | Never;

/** `obligation o "text" rule { when W require Q else s on unknown u }` (PS8.2). */
export interface RuleObligation extends NodeBase {
  kind: 'RuleObligation';
  name: string;
  text: string;
  when: Expr | null;
  require: Expr;
  severity: 'deny' | 'warn' | 'escalate';
  /** null when not written: the default of PS8.2. */
  onUnknown: 'escalate' | 'deny' | 'skip' | null;
}

/** `obligation o "text" machine { states … initial … from … deny in … end … }` (PT8.1, PT8.2). */
export interface MachineObligation extends NodeBase {
  kind: 'MachineObligation';
  name: string;
  text: string;
  states: string[];
  initial: string;
  /** `from s1, s2 when e -> t`; `from *` is every state. */
  transitions: { from: string[] | '*'; when: Expr; to: string }[];
  /** `deny in s1, s2 when e reason "r"`. */
  guards: { in: string[]; when: Expr; reason: string }[];
  end: string[];
}

/** `obligation o "text" invariant { e }` over the policy's vars. */
export interface InvariantObligation extends NodeBase { kind: 'InvariantObligation'; name: string; text: string; expr: Expr }

/** `recalled o "text"`: durable text, not enforced. */
export interface Recalled extends NodeBase { kind: 'Recalled'; name: string; text: string }

/** `never n "text": allow when e` (S149): the gate never allows a proposal for which e holds; proved, never lowered. */
export interface Never extends NodeBase { kind: 'Never'; name: string; text: string; when: Expr }

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
  /** PS15.5: the configuration a channel generates, named after it. */
  generated?: 'channel';
  /**
   * PS15.5 (S207): the joint configuration of an application that answers a message from one channel on another, named
   * after the application, with every one of these channels' conversations live.
   */
  joint?: string[];
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
  /** PS8.7, S160: the trust scope the configuration assigns; absent, the scope is the machine's module. */
  scope?: string;
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
  /**
   * PD5.1.2: `claims C { f: T … }`, a record of finite fields (enums, integer ranges, `Principal`) that a verifier
   * outside poly asserts for an action's caller. Absent on a plain record.
   */
  claims?: true;
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

export type TypeExpr = TBool | TInt | TString | TName | TRange | TMap | TRef | TConf;
/** `Conf` (PD1.3): a calibrated confidence, 0..1000 at runtime, compared only with constants. */
export interface TConf extends NodeBase { kind: 'TConf' }
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
  /**
   * PS15.2, PS15.3: set by a channel's expansion: each channel's key c and its conversation's machine. In every handler
   * of the application, c names the address p/c of the child spawned under that key.
   */
  channelKeys?: { key: string; machine: string }[];
}

export interface Field extends NodeBase {
  kind: 'Field';
  name: string;
  type: TypeExpr;
  check: CheckClause | null;
  init: Expr;
  flag: 'internal' | 'derived' | null;
}

export type MachineItem = Terminal | Action | Handler | Guard | Property | NeverEmit | Liveness | EffectDecl | Decision;

/**
 * `never n: emit k(f: v, …) while P` (PS5.2a, S178): the step property `P(pre) implies !emits(k, f: v, …)`. `cond` is
 * null where `while` is left out, which means true.
 */
export interface NeverEmit extends NodeBase {
  kind: 'NeverEmit';
  name: string;
  effect: string;
  fields: EmitsField[];
  cond: Expr | null;
}

/** `f: v` in `emits(k, f: v)` and `never … emit k(f: v)`: a payload field and a constant (PS5.2). */
export interface EmitsField extends NodeBase { kind: 'EmitsField'; name: string; value: Expr }

/**
 * `decision d(params) -> R { … }` (PD1.2, S76): a model call whose answer is a finite typed value. It lowers to an
 * effect of kind `decision.<d>` (PD1.7).
 */
export interface Decision extends NodeBase {
  kind: 'Decision';
  name: string;
  params: Param[];
  result: TypeExpr;
  items: DecisionItem[];
}

export type DecisionItem =
  | (NodeBase & { kind: 'DecProvider'; value: string })
  | (NodeBase & { kind: 'EffLabels'; labels: string[] })
  | (NodeBase & { kind: 'DecTimeout'; value: string })
  /** `band 0.3..0.7` for a Tri result (PD1.2d), in thousandths. */
  | (NodeBase & { kind: 'DecBand'; lo: number; hi: number })
  /** PS17.6 (S304): `cites x`, an Items parameter the answer's citations are a subset of. */
  | (NodeBase & { kind: 'DecCites'; param: string })
  /** `route r` (PT24.1c, PS18.2): the decision's tiers, in place of a provider. */
  | (NodeBase & { kind: 'DecRoute'; route: string })
  /**
   * `prices "f" max input tokens I max tokens N budget b` (PS18.4a, S454): an unrouted decision's price table, token
   * limits and budget, one clause after `provider`. A part left out is null, which the checker refuses (PL1201).
   */
  | (NodeBase & { kind: 'DecBudget'; budget: string | null; prices: string | null; maxInputTokens: number | null; maxTokens: number | null })
  | EffOutcomeItem;

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
  /** PD5.1.2: `on A(…) by c: C`, the claims the action requires, bound to `c`. */
  by?: { name: string; type: string };
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
  /** PS23.4, PT33.1: `idempotent header "H" window 24h` (G2, keyed) or `idempotent by nature "reason"` (G4). */
  | (NodeBase & ({ kind: 'EffIdempotent'; form: 'header'; header: string; window: string } | { kind: 'EffIdempotent'; form: 'nature'; reason: string }))
  | EffTargets
  | EffUses
  | EffRetrieve
  | EffRemember
  | (NodeBase & { kind: 'EffTo'; param: string })
  | (NodeBase & { kind: 'EffAudience'; cls: string })
  /** PS17.3a, S459: `envelope e`, the Content parameter whose envelope gives the recipient and the threading headers. */
  | (NodeBase & { kind: 'EffEnvelope'; param: string })
  /** PS17.4b, S462: `one p`, the Items parameter that holds exactly one item. */
  | (NodeBase & { kind: 'EffOne'; param: string })
  | EffOutcomeItem;

/** PS17.2: `retrieve s [where owner == p [and k == x]] limit n`, the body of a retrieval effect; `p` a Principal parameter, `x` a Key parameter and `k` a key the source declares (S451). */
export type EffRetrieve = NodeBase & { kind: 'EffRetrieve'; source: string; owner: string | null; limit: number; key?: { name: string; param: string }; /** PS17.2, S459: an envelope retrieval, `retrieve s envelope where …`, with no limit (0). */ envelope?: boolean };

/** PS17.5: `remember s as k about p`, which writes the payload's Content to the memory source s, owned by p. */
export type EffRemember = NodeBase & { kind: 'EffRemember'; source: string; provenance: 'observed' | 'derived' | 'verified'; about: string };

/** PT10e: `uses c { s, ... } for p`, the credential an effect runs with, the scopes it needs and its holder parameter. */
export type EffUses = NodeBase & { kind: 'EffUses'; credential: string; scopes: string[]; holder: string | null };

/**
 * One target: a string (a prefix, a secret's name, a command or a table), or an exact egress URL (S455), which the
 * manifest writes as { "exact": "<url>" } among the kind's strings.
 */
export type TargetValue = string | { exact: string };

/** PT6.5, S151: `targets { egress: "<prefix>" | exact "<url>" | [ … ], secrets: [ … ], exec: [ … ], store: [ … ] }`, in source order. */
export type EffTargets = NodeBase & { kind: 'EffTargets'; targets: { key: string; values: TargetValue[] }[] };

/** `ok -> A(args)`, or `ok(r) -> A(p: r.x)`, which binds the handler's result (PD1.2b, PD1.2g, S79). */
export type EffOutcomeItem = NodeBase & { kind: 'EffOutcome'; outcome: 'ok' | 'failed' | 'exhausted'; action: string; args: NamedArg[]; bind?: string };

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
  op: 'emit' | 'after' | 'cancel' | 'spawn' | 'send' | 'signal' | 'decide' | 'adjudicate';
  /** emit/after/send/signal: the action or effect name; spawn: the machine; cancel: the timer key; decide, adjudicate: the decision. */
  target: string;
  args: NamedArg[];
  /** send: the address expression. */
  to: Expr | null;
  /** after: the duration literal; spawn: 'detached' or null; adjudicate: 'Correct' or 'Wrong' (PD2.4, S129). */
  modifier: string | null;
  /** after/spawn/send: the `as` name. */
  as: string | null;
  /** after/spawn: `as k[i]`; cancel: `cancel k[i]`; signal: `signal k[i]`: the index of a key family (S49). */
  index: Expr | null;
  /** signal: the child key; spawn: the creation action ('create', A) and the completion wiring, as written (S43). */
  extra: string[];
  /** PS15: a statement a channel's expansion wrote (the spawn in starts), for the faults that break it. */
  generated?: 'channel';
  /** PS15.1: a send of the instantiated conversation whose Peer action the binding renamed, as the Peer named it. */
  renamedFrom?: string;
}

export interface NamedArg {
  /** null for a positional argument. */
  name: string | null;
  value: Expr;
}

// ── Expressions (PT2.2, PS12) ──────────────────────────────────────────────

export type Expr =
  | IntLit
  | DecimalLit
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
  | Quant
  | Emits;

/** `emits(k, f: v, …)` in a step property (PS5.2, S178): some intent of the step is an effect k with those values. */
export interface Emits extends NodeBase { kind: 'Emits'; effect: string; fields: EmitsField[] }

/** `g[*]` inside an aggregate: every member of a family (S49, PS13.6). */
export interface Star extends NodeBase { kind: 'Star' }
/** `forall i in g: e` and `exists i in g: e` over a family (S49) or a configuration group (PS13.6). */
export interface Quant extends NodeBase { kind: 'Quant'; q: 'forall' | 'exists'; var: string; group: string; body: Expr }

export type Literal = IntLit | BoolLit | StringLit | NameRef;

/** `k spawned` (S48): true iff the attached child k exists; only in a compose invariant. */
export interface Spawned extends NodeBase { kind: 'Spawned'; key: string; /** `f[i] spawned`: a member of a family (S49). */ index: Expr | null }
export interface IntLit extends NodeBase { kind: 'Int'; value: number }
/** `0.8` (S76): legal only as the constant a `Conf` is compared with; its value is in thousandths. */
export interface DecimalLit extends NodeBase { kind: 'Decimal'; value: number }
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

export type AnyNode = Module | Decl | Ctor | PayloadField | TypeExpr | CheckClause | Domain | Field | MachineItem | EffectItem | Param | Stmt | Arm | Pattern | Expr | FairGroup | ConfigInstance | InputRef | ConfigBounds | PolicyVar | PolicyItem;
