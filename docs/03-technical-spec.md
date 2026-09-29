# poly · Technical specification

*Cognitive Fab · September 2026 · draft v0.2 · specification only, no code*

v0.2 answers the review in [`reviews/review-2026-09-29-blunt.md`](reviews/review-2026-09-29-blunt.md). The response, item by item, is in [`reviews/response-2026-09-29.md`](reviews/response-2026-09-29.md).

This document fixes the grammar, the semantics and the formats. It covers the lowering of each construct to the Poly stack artefacts, the integration of the gate with the kernel, the diagnostics, the command surface, the implementation plan and the first experiment.

- Functional requirements are cited as `PF`.
- Architectural principles and decisions are cited as `PA` and `AD`.
- Engine formats are quoted from [`research/primitive-inventory.md`](research/primitive-inventory.md).

## PT1. Source files and modules

- **PT1.1** A module is a file with the extension `.poly`. It starts with `module <name>` and holds `enum`, `machine` and `workflow` declarations.
- **PT1.1a** A policy lives in its own file with the extension `.policy.poly` (PT8). Machines and policies never share a file, so the two expression semantics never share a file either.
- **PT1.1b** Worlds are deferred to v2 (appendix A).
- **PT1.2** A project is a directory with a `poly.json` manifest:

  ```json
  { "poly": "1", "name": "orders", "modules": ["src/*.poly"],
    "host": "typescript", "require": { "grade": false },
    "engines": { "polygraph": "^8.3", "polyaxion": "^2" } }
  ```

- **PT1.3** Imports are by module name within a project: `use payments.Payment`. Cross-project imports are out of scope for v1 (open question 4 in the architecture).
- **PT1.4** The canonical formatter defines one text per AST. The module digest is the SHA-256 of the RFC 8785 canonical JSON of the AST. This is the same canonicalisation the polyflow platform kernel uses. The digest becomes the `machineVersion` of each machine it contains.
- **PT1.4a** Comments and blank lines are trivia. They are kept by the formatter but are not part of the AST, so they do not change the digest. Two sources with the same AST have the same digest, whatever their comments.
- **PT1.5** Build output goes to `.poly/build/<machine>/`, one directory per machine, in the layout the engines already read (PT17).

## PT2. Grammar

The core grammar in EBNF. Terminals are quoted. `Expr` is the expression sublanguage of PT2.2.

```ebnf
Module      = "module" Ident { Decl } ;
Decl        = Machine | Workflow | Enum | Use ;
Use         = "use" QualIdent ;
Enum        = "enum" Ident "{" Ident { "," Ident } "}" ;

Machine     = "machine" Ident "{" [ Version ] StateBlock { MachineItem } "}" ;
Version     = "version" Int [ "from" Int Migrate ] ;
Migrate     = "{" "migrate" "{" { "new" "." Ident "=" Expr } "}" "}" ;
StateBlock  = "state" "{" { Field } "}" ;
Field       = Ident ":" Type [ Check ] "=" Expr [ "internal" | "derived" ] ;
Check       = "check" Domain [ "strict" | "disclosed" ] ;
MachineItem = Terminal | Action | Handler | Guard | Invariant | Effect | Timer ;
Terminal    = "terminal" Expr ;
Action      = "action" Ident "(" [ Param { "," Param } ] ")" ;
Param       = Ident ":" Type [ Check ] ;
Handler     = "on" Ident [ "(" Ident { "," Ident } ")" ] Block ;
Guard       = "guard" "all" "when" Expr "reject" String ;
Block       = "{" { Stmt } "}" ;
Stmt        = "require" Expr "else" "reject" String
            | "let" Ident "=" Expr
            | Ident "'" "=" Expr
            | Ident "'" "=" Ident "with" "[" Expr "]" "=" Expr
            | "if" Expr Block [ "else" Block ]
            | "emit" Ident "(" [ Args ] ")"
            | "after" Duration "->" Ident "(" [ Args ] ")" "as" Ident
            | "cancel" Ident
            | "spawn" QualIdent "as" Ident "(" [ Args ] ")" ChildWiring
            | "signal" Ident "->" Ident "(" [ Args ] ")" ;
ChildWiring = "on" "complete" "->" Ident [ "on" "parent" "terminal" "->" Ident ] ;
Invariant   = [ "step" | "reject" | "emits" | "compose" ] "invariant" Ident ":" Expr ;
Effect      = "effect" Ident "(" [ Param { "," Param } ] ")" "{" { EffectItem } "}" ;
EffectItem  = "kind" String | "labels" "{" Label { "," Label } "}" | "class" Class
            | "retry" "{" "attempts" Int "," "base" Duration "," "timeout" Duration "}"
            | ( "ok" | "failed" | "exhausted" ) "->" Ident "(" [ Args ] ")" ;
Class       = "none" | "reversible" | "compensable" | "irreversible" ;
Type        = "bool" | "int" | "string" | Ident | Int ".." Int
            | "map" "<" Ident "," Type ">" ;
Domain      = "{" Literal { "," Literal } "}" | Int ".." Int ;
```

The `Policy` production is in PT8, in its own file type. The `Workflow` production is in PT10.

- **PT2.1** Keywords are reserved. Identifiers follow TypeScript identifier rules. Rejection reasons and effect kinds are string literals, so agents can reuse the names already present in a system.
- **PT2.2** The expression sublanguage (AD-2) is a total, side-effect-free subset of TypeScript expressions:
  - literals, field and parameter names, `pre.` and `post.` (in step invariants), enum members;
  - `== != < <= > >= && || !`, `+ - *`, and integer `/` and `%` (division by zero is a type error);
  - `implies`;
  - `count(kind)` and `before(a, b)` (in emission invariants);
  - `in { … }`;
  - map indexing `m[k]`, where `k` is a value of the map's key enum; map update is the statement form `m' = m with [k] = v`, which writes one entry and leaves the others unchanged.

  It has no loops, no calls to host functions and no string operations beyond equality and membership. Every expression terminates by construction.
- **PT2.3** Policies use PX, Polyaxion's three-valued (Kleene) language, and they live in `.policy.poly` files (PT1.1a). The difference is visible in the syntax, not only in the checker:
  - policies compare with `is`, `is not` and `in`, and test for a missing value with `unknown(x)`;
  - policies do not accept `==`, `!=` or `!`, and machines do not accept `is`, `is not` or `unknown`.

  A machine-only operator in a policy file is `PL1201 POLICY_ONLY_CONSTRUCT`; the reverse is `PL1202 MACHINE_ONLY_CONSTRUCT`.

## PT3. Types and check domains

- **PT3.1** The types are:
  - `bool`;
  - enums;
  - integer ranges `a..b`;
  - `int`;
  - `string`;
  - `map<E, T>`, where the key type `E` is an enum.
- **PT3.2** Every field and parameter has a finite check domain (PF1.2). Enums, `bool`, ranges and maps over finite value types are finite by construction. `int` and `string` need an explicit `check` clause. Without one, the compiler reports `PL1101 UNBOUNDED_DOMAIN`.
- **PT3.3** A `check` clause narrower than the runtime type is an assumption. It is written to `dataDomain` and to the certificate's `domains`, and it is graded by `poly grade` (polynv).
- **PT3.4** Each `check` clause has a mode, and the mode decides what the runtime does with a value outside the check domain:

  | Mode | Runtime behaviour | Certificate |
  |---|---|---|
  | `strict` | `dispatch` rejects the action with the reason `outside-check-domain` before the handler runs. | The checked domain is the running domain. |
  | `disclosed` | The action is accepted and journaled with the flag `outsideCheckDomain`. `poly export traces` surfaces these windows as domain-drift evidence for polynv. | The field is listed under `disclosedDomains`. |

- **PT3.4a** The default mode is `strict` for every parameter and field whose value can flow into the payload of an `irreversible` or `compensable` effect. The compiler computes this flow from the handlers. It is `disclosed` elsewhere. An explicit `disclosed` on a field that flows into an irreversible effect is `PL1301 DISCLOSED_IRREVERSIBLE_INPUT`, and a person must accept it (PT12.5).
- **PT3.5** An assignment that can produce a value outside a field's declared type (for example `items' = items + 1` with `items: 0..3`) is not a compile error. It lowers to an automatic state invariant, `domain:<field>`. The model check then reports the shortest path that overflows (`PL3102 DOMAIN_ESCAPE`) with a witness.

## PT4. Handlers and step semantics

### PT4.1 Handler shape and evaluation order

Each action has at most one handler. A handler lowers to one keyed acceptor in the SAM v2 strict profile. A handler body runs in two phases:

1. **Guard phase.** Every `require` evaluates against the pre-state and the parameters.
   - The rule is per path. On every control path from the handler entry, every `require` on that path comes before the first write on that path. A `require` inside an `if` branch is legal when no write precedes it on that branch or before the `if`. A violation is `PL2101 WRITE_BEFORE_REQUIRE`, with the offending path.
   - A failing `require` calls `reject(reason)` before any write.
   - Agent-written code therefore cannot raise the `rejectAfterWrite` frame error.
2. **Write phase.** Primed assignments write to `next`. `emit`, `after`, `cancel`, `spawn` and `signal` statements are collected as effect intents (PT6).

### PT4.2 Frame derivation

The compiler computes the set of fields written on each path. It emits `unchanged(...)` for the complement, on that path. The author never writes a frame.

### PT4.3 Cross-cutting vetoes

`guard all when <expr> reject "<reason>"` lowers to a broadcast acceptor. The profile allows it: one acceptor may reject after another has written. Guards run before handlers.

### PT4.4 Step classification

A step is:

- `accepted` when at least one field is written or an effect is emitted;
- `rejected` when a `require` or guard fails;
- `unhandled` when the action has no handler.

A handler that can complete with no write, no effect and no rejection is reported as `PL2201 SILENT_NOOP`. This follows the doctrine "every no-op is observable".

### PT4.4a Terminal states

`terminal <expr>` is a predicate over the state. The compiler requires it to depend only on the primary control field, which is the first field of the `state` block (the polygraph contract rule "the first key is treated as the primary control state"). It lowers to `terminalStates`, the list of values of that field that satisfy the predicate. A terminal predicate that reads any other field is `PL1401 TERMINAL_NOT_ON_CONTROL_FIELD`.

### PT4.5 Example and lowering

```poly
module orders

enum Status { Draft, Placed, Paid, Shipped, Cancelled }
enum Reason { Customer, Fraud }

machine Order {
  version 1
  state {
    status : Status = Draft
    items  : 0..3   = 0
    paid   : bool   = false
  }
  terminal status in { Shipped, Cancelled }

  action AddItem()
  action Place()
  action Pay(amount: int check { 10, 20 })
  action PaymentOk()
  action PaymentFailed(code: string check { "declined", "exhausted", "denied" })
  action Ship()
  action Cancel(reason: Reason)

  on AddItem {
    require status == Draft else reject "not-draft"
    items' = items + 1
  }
  on Place {
    require status == Draft else reject "not-draft"
    require items > 0      else reject "empty-order"
    status' = Placed
  }
  on Pay(amount) {
    require status == Placed else reject "not-placed"
    emit charge(amount)
  }
  on PaymentOk {
    require status == Placed else reject "not-placed"
    status' = Paid
    paid' = true
  }
  on PaymentFailed(code) {
    require status == Placed else reject "not-placed"
    status' = Cancelled
  }
  on Ship {
    require status == Paid else reject "not-paid"
    status' = Shipped
  }
  on Cancel(reason) {
    require status in { Draft, Placed } else reject "too-late"
    status' = Cancelled
  }

  invariant shipped-was-paid: status == Shipped implies paid
  step invariant cancel-is-final: pre.status == Cancelled implies post.status == Cancelled
  reject invariant place-empty: action == Place && pre.items == 0 implies rejected("empty-order")

  effect charge(amount: int) {
    kind "payment.charge"
    labels { egress:external }
    class irreversible
    retry { attempts 3, base 200ms, timeout 5s }
    ok -> PaymentOk()
    failed -> PaymentFailed(code: "declined")
    exhausted -> PaymentFailed(code: "exhausted")
  }
  emits invariant charge-at-most-once: count("payment.charge") <= 1
}
```

This source contains two findings.

1. **Domain escape.** `AddItem` can overflow `items: 0..3`. The model check reports `PL3102 DOMAIN_ESCAPE` with the witness `AddItem, AddItem, AddItem, AddItem`, and offers two typed fixes:
   - add `require items < 3 else reject "cart-full"`;
   - widen the range.
2. **Double charge.** `Pay` accepts while the order is `Placed` but does not change its state, so a second `Pay` emits a second charge. Emission admission reports `PL4001 EMISSION_INVARIANT` for `charge-at-most-once`, with the witness `AddItem, Place, Pay(10), Pay(10)`. The fix is a `Charging` status that `Pay` enters and `PaymentOk` / `PaymentFailed` leave. This is the double-charge sequence the Poly stack was built to find: each call is allowed, and the sequence is not.

`amount` flows into the irreversible `charge`, so its check domain `{ 10, 20 }` is `strict` by default (PT3.4a). A `Pay(15)` is rejected at dispatch with `outside-check-domain`, and the program that runs is the program that was checked.

The first handler of the fixed program lowers to the keyed acceptor below. Its form is the strict-profile form quoted in the inventory.

```js
acceptors: {
  AddItem: model => (proposal, { reject, next, unchanged }) => {
    if (!(model.status === 'Draft')) return reject('not-draft')
    if (!(model.items < 3)) return reject('cart-full')
    next.items = model.items + 1
    unchanged('status', 'paid')
  },
  // ...
}
```

The invariants lower to `invariants.mjs`:

```js
export const stateInvariants = [
  { name: 'shipped-was-paid', pred: s => !(s.status === 'Shipped') || s.paid },
  { name: 'domain:items',     pred: s => s.items >= 0 && s.items <= 3 },
]
export const transitionInvariants = [
  { name: 'cancel-is-final', pred: (pre, action, data, post) =>
      !(pre.status === 'Cancelled') || post.status === 'Cancelled' },
]
export const rejectionInvariants = [
  { name: 'place-empty', pred: (state, action, data, v) =>
      !(action === 'Place' && state.items === 0) || (v && v.rejected && v.reason === 'empty-order') },
]
```

## PT5. Invariants

| poly form | Lowered to | Checked by | Semantics |
|---|---|---|---|
| `invariant n: e` | `stateInvariants` | polygraph BFS, Polytrion monitors | `e` holds in every reachable state |
| `step invariant n: e` | `transitionInvariants` | polygraph BFS | `e` holds over every accepted step `(pre, action, data, post)` |
| `reject invariant n: e` | `rejectionInvariants` | polygraph BFS with step verdicts | `e` holds over every step; `rejected(r)` is true when the step was rejected with reason `r` |
| `emits invariant n: e` | `effect-invariants.mjs` | polyrun `check-effects` | `e` holds over every emission path; `count(k)`, `before(a, b)` and `actions` are available |
| `compose invariant n: e` | `invariants.compose.mjs` | polyrun `check-product` | `e` holds over every joint state of a parent and its children |
| (automatic) `domain:<field>` | `stateInvariants` | polygraph BFS | PT3.5 |

A named invariant is a forbidden region when it carries `region "<name>"`. The name is copied to the Polyaxion `security.json` `forbiddenRegions` entry when the machine is referenced by a policy (PT8.4).

## PT6. Effects, timers and children

### PT6.1 Effects

`emit k(args)` in an accepted step lowers to an entry in `effects.cjs`. The mapper `effects(pre, action, data, post, stepKind)` returns the intents for that `(action, stepKind)` pair. Rejected and unhandled steps emit nothing.

Each `effect` declaration lowers to one manifest kind:

```json
{ "effects": { "payment.charge": {
    "payloadSchema": { "amount": { "type": "number", "required": true } },
    "onSuccess":   { "action": "PaymentOk" },
    "onFailure":   { "action": "PaymentFailed", "data": { "code": "declined" } },
    "onExhausted": { "action": "PaymentFailed", "data": { "code": "exhausted" } },
    "retry": { "maxAttempts": 3, "baseMs": 200, "timeoutMs": 5000 },
    "labels": ["egress:external"], "class": "irreversible" } } }
```

`labels` and `class` are new manifest fields, read by the gate (PT9). M1 confirms whether polyrun's manifest loader tolerates unknown fields. If it does not, the two fields move to a sidecar `effects.labels.json`, and the manifest stays unchanged.

### PT6.2 Labels

Labels come from the closed Polyaxion vocabulary:

- `read:repo`, `read:private`, `read:store`, `read:web`;
- `write:store`, `write:repo`, `write:workspace`;
- `egress:public`, `egress:external`;
- `exec`, `admin`.

An effect with no labels is reported as `PL6301 UNLABELLED_EFFECT` unless the project declares `unlabelled: "report"`. The `unlabelled` setting follows the polyflow platform policy field.

### PT6.3 Timers

`after 30m -> Expire() as expiry` lowers to a built-in `timer` intent with `{ key: "expiry", fireIn, action: "Expire", data }`. `cancel expiry` lowers to `cancelTimer`.

Timer keys are declared by use and scoped to the machine. Arming a key that may already be armed replaces the pending timer: the lowering emits `cancelTimer` then `timer`, in that order, in the same step. Two `after` statements with the same key on one control path are `PL2301 DUPLICATE_TIMER_KEY`. The machine handles staleness, not the scheduler: a timer that fires into a state where its action is rejected is a normal rejected step.

### PT6.4 Children

`spawn payments.Payment as pay(amount: amount) on complete -> Paid on parent terminal -> Abort` lowers to `spawnChild` with:

- `machineId`;
- `childKey: "pay"`;
- `initData`;
- `onComplete: "Paid"`;
- `onParentTerminal: "Abort"`.

`signal pay -> Refund()` lowers to `signalChild`. The child instance id is `hash(parentId, childKey, seq)`, as polyrun defines it.

## PT7. Composition

A machine that spawns children is checked with its children as a product:

- Each cascade is atomic.
- Per-instance dispatch has a single writer.
- `MAX_CASCADE_DEPTH` is 8.

These rules are polyrun's composition semantics, unchanged. The compiler emits `invariants.compose.mjs` from `compose invariant` declarations. Joint state is addressed as `parent.<field>` and `children.<key>.<field>`.

The built-in doctrine findings are surfaced as poly diagnostics in the `PL5xxx` range:

- poison class;
- unhandled cascade delivery;
- unnamed rejects;
- child-key collision.

## PT8. Policies

### PT8.1 Syntax

A policy lowers to `polyaxion.policy.json` version 2. The document fields are `polyaxion`, `id`, `version`, `scope`, `description`, `vars` and `obligations`.

The file is `repo-hygiene.policy.poly`. It uses the policy operators of PT2.3.

```poly
policy repo-hygiene {
  scope "claude-code"
  var deploys: 0..5 = 0

  obligation tests-before-deploy "After changing source, run the tests before deploying." machine {
    states clean, dirty, tested
    initial clean
    from * when action.kind is "fs.write" and glob(action.path, "src/**") -> dirty
    from dirty when action.kind is "process.run" and action.target is "test" -> tested
    deny in dirty when action.kind is "custom.deploy" reason "untested-changes"
    end clean, tested
  }

  obligation no-egress-after-secret "Never send data out after reading a secret." rule {
    when action.effects has "egress:external"
    require not history.any(a => a.effects has "read:private") else deny
  }

  obligation orders-irreversible "No irreversible effect on a cancelled order." rule {
    when effect.class is "irreversible" and machine("orders.Order").status is Cancelled
    require false else deny
  }

  recalled style "Follow the house style: short sentences, no dash asides."
}
```

In PX, `glob(action.path, …)` is unknown when `action.path` is missing, and an unknown value never satisfies a `when`. The v0.1 form `action.path ?? ""` is not needed and is not accepted.

### PT8.2 Lowering

| poly | `polyaxion.policy.json` |
|---|---|
| `obligation … machine { … }` | `kind: "machine"` with `states`, `initial`, `transitions` (`{from, when, to}`), `guards` (`{in, when, reason}`) and `end` |
| `obligation … rule { … }` | `kind: "rule"`, `when` / `require`; `else deny`, `else warn` and `else escalate` map to `severity` |
| `obligation … invariant { … }` | `kind: "invariant"` over declared `vars` |
| `recalled` | `kind: "recalled"`, compiled into `unenforced[]` |

Closed history predicates are lifted into counters and model-checked by Polyaxion. Open ones must be declared `coverage runtime-only`, exactly as Polyaxion requires.

### PT8.3 Referencing program state

`machine("<module>.<Machine>")` is new. It reads the snapshot of the instance that emitted the effect under decision, **as of the step that emitted it** (PT9.3). It never reads a later snapshot. The value is unknown (Kleene) when the proposal is not an effect of that machine.

### PT8.4 Admission

Policy admission runs Polyaxion `compile` and `harden`. Machines with regions or gates must be `fullyMediated`. The coverage grade (`checked` or `runtime-only`) is copied into the certificate. polycheck then runs the regions against the effect labels of every admitted machine and the tool labels of the declared scope. Its result, `PROOF`, `WITNESS` or `INCONCLUSIVE`, maps to `CLEAN`, `FINDINGS` or `INCONCLUSIVE`.

## PT9. The gate in the runtime

This is the only new engine integration (architecture section 7.2).

- **PT9.1 Proposal.** When an outbox worker claims an intent, it calls the gate before the handler with:

  ```json
  { "kind": "effect", "effectKind": "payment.charge", "labels": ["egress:external"],
    "class": "irreversible", "machine": "orders.Order", "instance": "ord-81",
    "seq": 14, "idempotencyKey": "…", "payloadDigest": "sha256:…", "stateDigest": "sha256:…" }
  ```

  The payload body is not sent. Only its digest is, following the polyflow platform ledger rule "only digests are stored".

- **PT9.2 Decisions.**
  - **allow:** the handler runs.
  - **deny:** the worker marks the intent `denied` and dispatches the effect's `failed` action with `{ reason, witnessDigest }` merged into its data. A denied intent is not retried.
  - **escalate:** the intent is held as `escalated` until a recorded approval (`poly approve <intent> --by <person> --ref <escalation>`) re-proposes it with `approved: { by, ref }`. An unmatched approval is refused with `wrong-participant:polyaxion:approval-unmatched`. An escalation that is not approved within `escalation.timeoutMs` is denied (PT9.7).
- **PT9.3 Snapshot semantics.** The gate evaluates a proposal against exactly one snapshot: the post-state of the step that emitted the intent, identified by the `seq` and `stateDigest` the proposal carries (PT9.1).
  - The worker loads that snapshot from the journal by `(instance, seq)` and passes it with the proposal. The gate keeps no mirror of application state, so there is nothing to go stale.
  - A gate decision is therefore a function of three inputs: the policy digest, the gate's session state Σ at proposal, and the snapshot at the emitting `seq`. All three are in the ledger, so replay reproduces every decision (PF8.6).
  - If the snapshot at `seq` cannot be loaded (archived and not restored), the proposal is refused with class `unavailable`, never evaluated against a newer state.
- **PT9.4 Settle.** After the handler returns, the worker calls `SETTLE { observed: { ok, output digest } }`, then dispatches the completion action. Taint only grows, as in Polyaxion today.
- **PT9.5 Unavailability.** If the gate is unreachable, the intent stays pending and is not executed. The failure class is `unavailable`. The runtime never fails open.
- **PT9.6 Budget.** Polyaxion measures a 0.63 ms p50 composite merge with durable writes. The in-process placement (AD-4) targets the same order. The first implementation reports:
  - p50 and p99 latency for PT9.1 to PT9.4;
  - throughput in effects per second on one runtime, with 1, 8 and 64 concurrent instances, so that any serialisation point shows up as a flat line.

- **PT9.7 The outbox intent is a checked machine.** The interleavings of retry, gate decision, handler execution and settle are the most dangerous part of the runtime. They are specified as a poly machine, lowered like any other, and model-checked by polygraph as part of the runtime's own test suite. The runtime's outbox worker is the host of this machine.

  ```poly
  module runtime

  enum IntentStatus { Pending, Proposed, Allowed, Running, Settled, Denied, Escalated, Dead, Done }

  machine OutboxIntent {
    state {
      status    : IntentStatus = Pending
      attempts  : 0..3         = 0
      decisions : 0..2         = 0     // gate decisions taken for this intent
      executed  : bool         = false // the handler may have run (at-least-once)
      approved  : bool         = false
    }
    terminal status in { Done, Denied, Dead }

    action Propose()
    action GateAllow()
    action GateDeny()
    action GateEscalate()
    action Approve()
    action EscalationTimeout()
    action Start()
    action HandlerOk()
    action HandlerFailed()
    action SettleFailed()
    action SettleOk()

    on Propose {
      require status in { Pending } || (status == Escalated && approved) else reject "not-proposable"
      status' = Proposed
      decisions' = decisions + 1
    }
    on GateAllow    { require status == Proposed else reject "no-proposal"   status' = Allowed }
    on GateDeny     { require status == Proposed else reject "no-proposal"
                      require !executed          else reject "deny-after-execution"
                      status' = Denied }
    on GateEscalate { require status == Proposed else reject "no-proposal"
                      require decisions == 1     else reject "escalate-once"
                      status' = Escalated }
    on Approve      { require status == Escalated else reject "not-escalated" approved' = true }
    on EscalationTimeout { require status == Escalated && !approved else reject "not-waiting"
                           status' = Denied }
    on Start        { require status == Allowed  else reject "not-allowed"
                      require attempts < 3       else reject "exhausted"
                      status' = Running
                      attempts' = attempts + 1
                      executed' = true }
    on HandlerOk    { require status == Running  else reject "not-running"   status' = Settled }
    on HandlerFailed { require status == Running else reject "not-running"
                       if attempts < 3 { status' = Allowed } else { status' = Dead } }
    on SettleFailed { require status == Settled  else reject "not-settled"   status' = Allowed }
    on SettleOk     { require status == Settled  else reject "not-settled"   status' = Done }

    invariant one-decision-per-execution: executed implies decisions <= 1 || approved
    step invariant no-reproposal-after-allow:
      pre.status in { Allowed, Running, Settled } implies post.status != Proposed
    step invariant no-deny-after-run: pre.executed implies post.status != Denied
  }
  ```

  Three rules follow from the machine and are normative:

  1. **One decision per execution.** Once the gate allows an intent, a retry after a timeout or a failed settle goes back to `Allowed`, not to `Proposed`. The gate is not asked again for the same idempotency key, so "allowed, executed, then denied" cannot happen.
  2. **Escalation happens once and has a timeout.** An approved re-proposal can be allowed or denied, never escalated again, so an intent takes at most two gate decisions. `escalation.timeoutMs` (the polyflow platform policy field) fires `EscalationTimeout`, which denies the intent.
  3. **Denial is final and only precedes execution.** A deny can only happen from `Proposed`, before any attempt ran.

  The model check of this machine is gate M3b in PT18. Adding a state or a transition to the worker without changing this machine first is `PL2401 RUNTIME_MODEL_DRIFT` in the runtime's own CI.

## PT10. Workflows

```poly
workflow customer-brief runs Brief {
  input Start
  key "{date}" where date matches "^\\d{4}-\\d{2}-\\d{2}$"
  tool "brief.post" -> slack_send target "#cs" why "publish the approved brief"
}
```

This lowers to `polyflow.workflow.json`:

- `name`, `inputAction`;
- `key.template`, `key.fields`;
- `tools: { <effect kind>: { tool, target, why } }`.

It also produces the five machine files. The run key is derived as `agent | instance | workflow | key`, so starting and attaching are one call. Effects become work orders over the existing MCP tools:

- `workflow_start`, `workflow_report`, `workflow_state`, `workflow_signal`, `workflow_journal`, `workflow_list`;
- with polycrew, also `workflow_next` and `workflow_claim`.

## PT11. Versions and migration

```poly
machine Order {
  version 2 from 1 {
    migrate { new.status = old.status  new.items = old.items  new.paid = old.paid  new.giftWrap = false }
  }
  state { … giftWrap: bool = false }
}
```

- `migrate` lowers to `migrate.cjs`: a pure `migrate(oldState)`. Migration uses `old.` and `new.`, never primes, because a migration maps one shape to another and is not a step.
- A new field without a migration expression is scaffolded with a `HOLE()` that throws, as polyvers does today. It is reported as `PL8101 MIGRATION_HOLE`.
- `poly check --since 1` runs the polyvers lanes: semantic, shape, migration, vocabulary and intent. The corpus is `--snapshots` (fleet) or `--synthesize`, and an empty corpus is refused.
- Renaming a rejection reason is a vocabulary break ("deprecate, don't delete").
- The per-instance decision at deploy is `auto-upgrade`, `migrate` or `pin`.

## PT12. Diagnostics, verdicts and witnesses

### PT12.1 Diagnostic format

Every diagnostic has this JSON form (schema `poly.diagnostic/1`):

```json
{ "code": "PL3102", "name": "DOMAIN_ESCAPE", "severity": "finding",
  "stage": "model-check", "engine": "polygraph@8.3.0",
  "at": { "module": "orders", "machine": "Order", "node": "n:4f1c…", "line": 22, "col": 5 },
  "message": "items can leave 0..3",
  "witness": { "id": "sha256:…", "length": 4,
    "trace": [ { "pre": {"status":"Draft","items":0,"paid":false}, "action": "AddItem", "data": {},
                 "post": {"status":"Draft","items":1,"paid":false} } ] },
  "fixes": [
    { "id": "add-require", "pre": "sha256:9a0e…",
      "edit": { "op": "insert-before-first-write", "handler": "n:4f1c…",
                "stmt": "require items < 3 else reject \"cart-full\"" } },
    { "id": "widen-range", "pre": "sha256:77b2…",
      "edit": { "op": "replace-type", "node": "n:0c3a…", "with": "0..4" } } ] }
```

- Fixes are typed edits addressed to AST nodes, not to lines. Node ids are stable across formatting because they derive from the node's path in the AST.
- Each fix carries `pre`, the digest of the target node when the fix was computed. `poly fix <id>` applies it only if the node still has that digest; otherwise it is refused with `PL0201 STALE_FIX`. Applying several fixes in sequence is therefore safe: a fix invalidated by an earlier one is refused, never misapplied.
- Line and column are kept for display only.
- A fix is a proposal. `poly check` must run again after it is applied.

### PT12.2 Code ranges

| Range | Stage | Examples |
|---|---|---|
| PL0xxx | parse, format, fixes | `PL0001 SYNTAX`, `PL0201 STALE_FIX` |
| PL1xxx | types, domains | `PL1101 UNBOUNDED_DOMAIN`, `PL1201 POLICY_ONLY_CONSTRUCT`, `PL1202 MACHINE_ONLY_CONSTRUCT`, `PL1301 DISCLOSED_IRREVERSIBLE_INPUT`, `PL1401 TERMINAL_NOT_ON_CONTROL_FIELD` |
| PL2xxx | lowering, strict validate | `PL2101 WRITE_BEFORE_REQUIRE`, `PL2201 SILENT_NOOP`, `PL2301 DUPLICATE_TIMER_KEY`, `PL2401 RUNTIME_MODEL_DRIFT` |
| PL3xxx | model check | `PL3001 INVARIANT_REACHABLE`, `PL3002 REJECTION_INVARIANT`, `PL3102 DOMAIN_ESCAPE`, `PL3901 BOUND_HIT` |
| PL4xxx | emission admission | `PL4001 EMISSION_INVARIANT` |
| PL5xxx | composition | `PL5001 COMPOSE_INVARIANT`, `PL5101 CHILDKEY_COLLISION` |
| PL6xxx | policy admission, labels | `PL6001 NOT_FULLY_MEDIATED`, `PL6301 UNLABELLED_EFFECT` |
| PL7xxx | capability proof | `PL7001 REGION_WITNESS` |
| PL8xxx | version gate | `PL8001 LANE_FAILED`, `PL8101 MIGRATION_HOLE` |
| PL9xxx | replay | `PL9001 SPEC_DIVERGENCE`, `PL9101 CONTROL_FAILED` |

### PT12.3 Verdicts and exit codes

The verdicts and exit codes follow the polygents codes:

| Verdict | Exit code |
|---|---|
| `CLEAN` | 0 |
| `FINDINGS` | 1 |
| `REFUSED` | 2 |
| `UNDERPOWERED` | 2 |
| `INCONCLUSIVE` | 2 |
| Non-determinism detected by the double pass | 3 |
| Error | 4 |
| Usage | 64 |

### PT12.4 Witness export

`poly witness <id> --trace` writes the witness as `{pre, action, data, post}` windows. `poly witness <id> --test` writes a host test that drives the runtime API through the witness sequence and asserts the violated predicate. The test fails on the unfixed program by construction (acceptance criterion AC3).

### PT12.5 Acceptances and approvals are signed by people

`poly accept` (an accepted finding) and `poly approve` (an escalation approval) write records that must be signed with a key registered in the project's `people` keyring (`poly.json` `people: [{ name, keyId, publicKey }]`).

- `poly check` and the runtime verify the signature and the key's presence in the keyring. An unsigned or agent-signed record has no effect.
- Agent keys (the key an MCP server or a CI job holds) are listed separately under `agents` and are rejected for these two record kinds.
- The enforcement is the signature check, not the transport. Not exposing the commands over MCP is a convenience, not a control. An agent with a shell and a person's private key can sign; keeping person keys out of agent environments is an operational requirement, stated as such.

## PT13. The first experiment

The experiment is milestone M3 (PT18). It runs on the M0 to M2 toolchain and needs no poly runtime: the poly arm's delivered program is lowered and executed on polyrun as it exists today.

- **Questions.**
  1. Can a coding agent reach an admitted poly program for a stateful feature within the same budget as a TypeScript implementation?
  2. Does it ship fewer escaped defects than the same agent writing TypeScript, with or without polygraph after the fact?
  3. At what cost in tokens and wall time?
- **Tasks.** Ten stateful features, fixed before any run, drawn from three families:
  - order and payment lifecycles;
  - workflow status derivation (modelled on the hatchet study);
  - leader election roles (modelled on the raft study).

  Each task has a written brief and a **host interface**: a small TypeScript API (for example `place(order)`, `pay(order, amount)`) that every arm must implement. The poly arm implements it with a thin generated adapter over the runtime API.
- **Arms.**
  1. TypeScript alone.
  2. TypeScript, then polygraph after the fact, with the agent allowed to fix findings.
  3. poly.

  The same agent and model are used in every arm, with the same token budget and wall-time limit per run.
- **Runs.** Five independent runs per task per arm: 150 runs in total.
- **Oracles.** Three, kept separate so the result cannot be an artefact of the formalism:

  | Oracle | Written by | Form | Role |
  |---|---|---|---|
  | O1 · scenario tests | a person who has read the brief and has **not** seen any reference machine | end-to-end tests against the host interface | **primary** |
  | O2 · hidden invariants | the task author | predicates over the host interface's observable state | secondary |
  | O3 · reference traces | the task author's reference machine | traces replayed through the host interface | secondary |

  An escaped defect is a failing O1 test for the primary measure. O2 and O3 findings are reported separately, per arm.
- **Evolution.** Each task has three follow-up changes to the brief, delivered in sequence to the same run. The measures are the regressions introduced and the regressions caught before delivery, scored by O1 after each change.
- **Measures.**
  - **Co-primary:** escaped defects per delivered task (O1), and tokens per delivered task.
  - **Secondary:** wall time; delivery rate within budget; O2 and O3 findings; regressions introduced and caught; for arm 3, diagnostics by code and the share of typed fixes applied unchanged.
- **Analysis, fixed before any run.**
  - Per-task means over the five runs; paired comparisons across the ten tasks (arm 3 against arm 1, arm 3 against arm 2) with the Wilcoxon signed-rank test, Holm-corrected, at 0.05.
  - **A win for poly:** at least a 30% reduction in mean escaped defects against both arms, with tokens per delivered task no more than twice arm 1's.
  - **A stop for poly as specified:** arm 3 delivers an admitted program in fewer than 70% of its runs within budget. M4 and later are then not started; the language surface is revised first.
  - Anything between is reported as it is, with the effect sizes and intervals.
- **Controls.** Each reference machine replays its own corpus at 100%, and a mutated reference fails. Each O1 suite passes on the reference implementation and fails on a mutated one. A task whose controls fail is removed before any arm is scored.
- **Reporting rule.** Every arm and every measure is reported, including a null or negative result for poly. The raw journals, prompts and O1 suites are kept.

## PT14. Command surface

| Command | MCP tool | What it does |
|---|---|---|
| `poly new "<description>" [--into module]` | `poly_new` | Drafts a machine with polygen. The draft is not admitted. |
| `poly fmt` | `poly_fmt` | Canonical formatting. Prints the module digest. |
| `poly check [--since v] [--against traces] [--snapshots dir]` | `poly_check` | Runs the pipeline. Returns verdict, diagnostics, witnesses and notRun. |
| `poly explain <code or witness>` | `poly_explain` | Returns the rule, the witness narrative and the fixes. |
| `poly witness <id> --trace/--test` | `poly_witness` | PT12.4. |
| `poly fix <id>` | `poly_fix` | Applies one typed fix if its precondition digest still holds (PT12.1). |
| `poly grade` | `poly_grade` | polynv adequacy. |
| `poly admit` | `poly_admit` | Writes and signs the certificate. |
| `poly accept <finding> --by <person>` | (not exposed over MCP) | Records an accepted exception, signed with a person key (PT12.5). |
| `poly deploy [--pin/--migrate/--upgrade]` | `poly_deploy` | Loads a certified version into a runtime, with the version gate against live snapshots. |
| `poly run`, `poly dispatch` | `poly_dispatch` | Development runtime. |
| `poly approve <intent> --by --ref` | (not exposed over MCP) | PT9.2 escalation approval, signed with a person key (PT12.5). |
| `poly journal verify/replay/export` | `poly_journal` | Ledger verification and replay (PF8.6). |
| `poly export traces` | `poly_export` | PF10.1. |
| `poly mine` | `poly_mine` | Passes journals to Polyx. Returns proposed obligations. |
| `poly propose` | `poly_propose` | Passes agent journals to polyness. Returns proposed workflows. |

The language server publishes the same diagnostics as `poly check` stages 0 to 2 on every edit. Stages 3 and later run on save or on request, because they explore state spaces.

## PT15. Host runtime API (TypeScript)

```ts
import { load } from '@cognitive-fab/poly'

const rt = await load('./.poly/build', {
  certificate: './.poly/certificate.json',
  store: 'sqlite:./orders.db',          // or 'postgres://…'
  gate: { policy: 'repo-hygiene', mode: 'in-process' },
  ledger: { keyId: 'ops-2026', signer: kms('…') },
})

rt.handle('payment.charge', async (payload, ctx) => {
  // runs only after the gate allows; ctx.idempotencyKey is stable across retries
  return psp.charge(payload.amount, { idempotencyKey: ctx.idempotencyKey })
})

const order = await rt.create('orders.Order')
const r = await rt.dispatch(order.id, 'Place', {}, { actionId: 'req-7781' })
// r: { seq, stepKind: 'accepted' | 'rejected' | 'unhandled', rejectReason?, state }
await rt.startWorkers({ effectConcurrency: 8, timerPollMs: 200 })
```

The API is polyrun's `createRuntime` with three additions:

- certificate verification at load (PF8.1);
- the gate (PT9);
- the ledger writer (PT16).

`rt.getState`, `rt.getStateAt(id, seq)` and `rt.list(machine, filter, status)` are unchanged.

## PT16. The ledger

The ledger uses the polyflow platform event format. It is **chained per run**: each instance (each `run`) has its own hash chain, so the ledger follows polyrun's single writer per instance and adds no runtime-wide serialisation point.

```json
{ "v": 1, "run": { "ns": "orders", "wf": "orders.Order", "run": "ord-81" }, "seq": 14,
  "kind": "verdict", "at": "2026-09-29T18:02:11.412Z",
  "body": { "stage": "gate", "outcome": "denied", "reason": "wrong-state:orders-irreversible", "witness": "sha256:…" },
  "prev": "sha256:…", "hash": "sha256:…" }
```

**Event kinds.** The existing kinds are `admission`, `proposal`, `verdict`, `effect`, `observation` and `closure`. poly adds `step`, which carries the polyrun journal row (`seq`, `action`, `data` digest, `stepKind`, `rejectReason`, pre and post digests), and `advice`, which carries the Polyx verdict with no write path (architecture section 9).

**Signing and verification.** Signed heads are `{ run, seq, hash, keyId, alg: "ed25519", sig }`, one per run. Verification runs the four Polyaxion checks: signature, chain, binding and replay.

**Runtime anchor.** When a runtime-wide statement is needed (for an audit period), the runtime publishes an **anchor**: a Merkle root over the current signed heads of all runs, itself signed. Anchoring is periodic and off the step path. A run's chain can be verified alone; the anchor proves that no run was dropped from the period.

**Trace export.** Export joins `step` events with the snapshots store to produce `{pre, action, data, post}` windows. Bodies are stored by digest, and a separate content store holds bodies under the operator's retention policy.

## PT17. Repository layout

```
poly/
  README.md
  docs/                      01 functional · 02 architecture · 03 technical · research/
  packages/
    poly-lang/               lexer, parser, formatter, AST, types, domains, diagnostics
    poly-lower/              construct → artefact (one module per row of the lowering map)
    poly-check/              pipeline orchestration, verdict fold, certificate
    poly-runtime/            polyrun host with certificate, gate hook, ledger writer
    poly-mcp/                MCP server over the command set
    poly-lsp/                language server
  plugin/                    Claude Code plugin: skill, commands, hooks
  examples/
    orders/                  PT4.5, with its lowered build checked in for review
    turnstile/ raft-roles/ hatchet-status/
  conformance/               lowering conformance, generated from the lowering map (02 §4): one case per row, poly source vs hand-written artefacts
```

The build directory per machine matches the engines' expected layout:

```
.poly/build/orders.Order/
  contract.json  next.cjs  invariants.mjs  effects.cjs  effects.manifest.json
  effect-invariants.mjs  migrate.cjs  polyflow.workflow.json (workflows only)
.poly/build/policies/repo-hygiene/polyaxion.policy.json
.poly/certificate.json
```

## PT18. Implementation plan

Each milestone ends with a gate. A milestone is not started until the previous gate passes. The gates reuse the stack's doctrine: controls first, and a defect becomes a gate. The experiment comes as early as the toolchain allows, and everything after it depends on its result.

| Milestone | Scope | Gate |
|---|---|---|
| M0 · Language core | Parser, formatter, AST digest and node ids, types and domains (with `strict` / `disclosed`), lowering of `state`, `action`, `on`, `guard`, `terminal` and the three invariant kinds | The turnstile, raft-roles and hatchet-status machines, written in poly, replay their existing field-study corpora at 100%. Their negative controls fail. Lowered `next.cjs` passes strict `validate()`. |
| M1 · Effects and composition | `emit`, effect declarations, timers, children, emission and compose invariants, maps | The `polyrun-oms` order machine in poly gives the same `check-effects` and `check-product` results as the hand-written artefacts (AC1). |
| M2 · Diagnostics | Diagnostic model, verdict fold, witness export to trace and test, node-addressed fixes with preconditions, `poly check` CLI | For every seeded defect in the conformance suite, the exported test fails before the fix and passes after it (AC3). Applying every fix in a random order never misapplies one. |
| **M3 · Experiment** | PT13, on the M0 to M2 toolchain and today's polyrun | Results published with every arm reported. **Go / stop decision** for M4 onward, by the rule fixed in PT13. |
| M4 · Runtime | `poly-runtime`: certificate check, polyrun host, per-run ledger, anchor, journal verify and replay; the outbox intent machine of PT9.7 | M4a: journal replay reproduces every post-state and gate decision (AC6); a tampered artefact is refused at load. M4b: the `OutboxIntent` machine is model-checked clean and the worker conforms to it by trace replay. |
| M5 · Governance | `.policy.poly` lowering, gate hook with emitting-step snapshots (PT9.3), polycheck stage, escalation with timeout, person-key signatures (PT12.5) | AC4. Gate latency and throughput are reported (PT9.6). The gate never fails open under an injected outage. |
| M6 · Agents | Workflow lowering, MCP server, language server, Claude Code plugin, `poly new` | AC5. A workflow in poly runs through unchanged polyflow tools. |
| M7 · Feedback | `poly mine`, `poly propose`, `poly export traces` | A Polyx rule adjudicated `real` round-trips to an admitted obligation. A polyness proposal arrives as poly source and is admitted or refused by the pipeline. |

Worlds (appendix A) are planned after M7 and are not part of v1.

## PT19. Limits

- **Bounded checks.** Checks are exhaustive only over declared check domains. A defect that needs a value outside the domain is not found. For `strict` fields, out-of-domain input is rejected at dispatch, so the checked domain is the running domain. For `disclosed` fields, drift is journaled (PT3.4), not prevented.
- **Model-code gap.** poly removes the gap between model and code for the machine itself. It does not check host handlers. Handler behaviour is observed only through completion actions and the `SETTLE` record.
- **State explosion.** It is managed by small machines and atomic cascades, not by abstraction. A check that hits its bound reports `INCONCLUSIVE` (`PL3901 BOUND_HIT`).
- **Advice.** Advice is recorded but not enforced until it is promoted, adjudicated and admitted.
- **Worlds.** Not in v1 (appendix A).
- **Language models.** The toolchain calls a language model only in `poly new` and in optional explanation text. No verdict depends on one.

## Conclusion

The technical core of poly is a lowering table and a verdict fold:

- Every construct maps to an artefact an existing engine reads.
- Every engine result maps to a diagnostic with a stable code, a witness and typed fixes.

The new engineering is a compiler and a runtime integration, not a new engine. Its full extent is in the scope table of the architecture (section 2a):

- the language front end, with node-addressed fixes;
- the gate hook in the outbox worker, evaluated against the emitting step's snapshot;
- the outbox intent as a checked machine;
- a per-run ledger with periodic anchors;
- the certificate that binds what was checked to what runs.

The plan reaches its first measurable claim at M3, before any runtime is built. The experiment tests whether an agent writing poly ships fewer escaped defects than the same agent writing the host language. Its tasks, oracles and decision rule are fixed before any run, and M4 onward depends on its result.

## Appendix A. Worlds (deferred to v2)

Worlds are not in v1. They are not needed to test the two claims the first experiment tests (PT13), and they bring a fourth expression language (distributions). The v0.1 sketch is kept here so the lowering target stays recorded.

```poly
world checkout {
  tick 1ms
  node order[1..50]: orders.Order
  responder "payment.charge": delay lognormal(mean 200ms, sd 80ms) -> ok p 0.97 else failed
  driver arrivals: poisson(rate 2/s) -> AddItem to order[*]
  probe paid-share: share(status == Paid)
}
```

This lowers to `topology.json` (`tickMs`, `nodes`, routes), `responders.mjs`, `drivers.mjs` and `probes.mjs`. The layout follows Polytrion's principle P-1.1: "Responders draw, machines decide, the kernel schedules". Machines are the lowered artefacts, unchanged. Running a world requires the hosted Polytrion (AD-6). Its refusal codes, such as `UNDERPOWERED` and `MONITOR_FINDING`, surface as poly verdicts.
