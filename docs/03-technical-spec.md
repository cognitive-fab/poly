# poly · Technical specification

*Cognitive Fab · September 2026 · draft v0.1 · specification only, no code*

This document fixes the grammar, the semantics and the formats. It covers the lowering of each construct to the Poly stack artefacts, the integration of the gate with the kernel, the diagnostics, the command surface, the implementation plan and the first experiment.

- Functional requirements are cited as `PF`.
- Architectural principles and decisions are cited as `PA` and `AD`.
- Engine formats are quoted from [`research/primitive-inventory.md`](research/primitive-inventory.md).

## PT1. Source files and modules

- **PT1.1** A module is a file with the extension `.poly`. It starts with `module <name>` and holds any number of `machine`, `policy`, `workflow` and `world` declarations.
- **PT1.2** A project is a directory with a `poly.json` manifest:

  ```json
  { "poly": "1", "name": "orders", "modules": ["src/*.poly"],
    "host": "typescript", "require": { "grade": false },
    "engines": { "polygraph": "^8.3", "polyaxion": "^2", "polytrion": "hosted" } }
  ```

- **PT1.3** Imports are by module name within a project: `use payments.Payment`. Cross-project imports are out of scope for v1 (open question 4 in the architecture).
- **PT1.4** The canonical formatter defines one text per AST. The module digest is the SHA-256 of the RFC 8785 canonical JSON of the AST. This is the same canonicalisation the polyflow platform kernel uses. The digest becomes the `machineVersion` of each machine it contains.
- **PT1.5** Build output goes to `.poly/build/<machine>/`, one directory per machine, in the layout the engines already read (PT17).

## PT2. Grammar

The core grammar in EBNF. Terminals are quoted. `Expr` is the expression sublanguage of PT2.2.

```ebnf
Module      = "module" Ident { Decl } ;
Decl        = Machine | Policy | Workflow | World | Enum | Use ;
Use         = "use" QualIdent ;
Enum        = "enum" Ident "{" Ident { "," Ident } "}" ;

Machine     = "machine" Ident "{" [ Version ] StateBlock { MachineItem } "}" ;
Version     = "version" Int [ "from" Int MigrateBlock ] ;
StateBlock  = "state" "{" { Field } "}" ;
Field       = Ident ":" Type [ "check" Domain ] "=" Expr [ "internal" | "derived" ] ;
MachineItem = Terminal | Action | Handler | Guard | Invariant | Effect | Timer ;
Terminal    = "terminal" Expr ;
Action      = "action" Ident "(" [ Param { "," Param } ] ")" ;
Param       = Ident ":" Type [ "check" Domain ] ;
Handler     = "on" Ident [ "(" Ident { "," Ident } ")" ] Block ;
Guard       = "guard" "all" "when" Expr "reject" String ;
Block       = "{" { Stmt } "}" ;
Stmt        = "require" Expr "else" "reject" String
            | "let" Ident "=" Expr
            | Ident "'" "=" Expr
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

The `Policy`, `Workflow` and `World` productions are in PT8 and PT10.

- **PT2.1** Keywords are reserved. Identifiers follow TypeScript identifier rules. Rejection reasons and effect kinds are string literals, so agents can reuse the names already present in a system.
- **PT2.2** The expression sublanguage (AD-2) is a total, side-effect-free subset of TypeScript expressions:
  - literals, field and parameter names, `pre.` and `post.` (in step invariants), enum members;
  - `== != < <= > >= && || !`, `+ - *`, and integer `/` and `%` (division by zero is a type error);
  - `implies`;
  - `count(kind)` and `before(a, b)` (in emission invariants);
  - `in { … }`.

  It has no loops, no calls to host functions and no string operations beyond equality and membership. Every expression terminates by construction.
- **PT2.3** Inside `policy` declarations the expression language is PX, Polyaxion's three-valued (Kleene) language (PT8). The compiler rejects a PX-only construct in a machine and a machine-only construct in a policy.

## PT3. Types and check domains

- **PT3.1** The types are:
  - `bool`;
  - enums;
  - integer ranges `a..b`;
  - `int`;
  - `string`;
  - `map<E, T>`, where the key type `E` is an enum.
- **PT3.2** Every field and parameter has a finite check domain (PF1.2). Enums, `bool`, ranges and maps over finite value types are finite by construction. `int` and `string` need an explicit `check` clause. Without one, the compiler reports `PL1101 UNBOUNDED_DOMAIN`.
- **PT3.3** A `check` clause narrower than the runtime type is a **disclosed assumption**. It is written to `dataDomain` and to the certificate's `domains`, and it is graded by `poly grade` (polynv).
- **PT3.4** At runtime the value is validated against the type, not the check domain. A value outside the check domain is accepted and journaled with the flag `outsideCheckDomain`. `poly export traces` surfaces these windows as domain-drift evidence for polynv.
- **PT3.5** An assignment that can produce a value outside a field's declared type (for example `items' = items + 1` with `items: 0..3`) is not a compile error. It lowers to an automatic state invariant, `domain:<field>`. The model check then reports the shortest path that overflows (`PL3102 DOMAIN_ESCAPE`) with a witness.

## PT4. Handlers and step semantics

### PT4.1 Handler shape and evaluation order

Each action has at most one handler. A handler lowers to one keyed acceptor in the SAM v2 strict profile. A handler body runs in two phases:

1. **Guard phase.** Every `require` evaluates against the pre-state and the parameters.
   - The compiler enforces that no state write precedes a `require` on any path.
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

`after 30m -> Expire() as expiry` lowers to a built-in `timer` intent with `{ key: "expiry", fireIn, action: "Expire", data }`. `cancel expiry` lowers to `cancelTimer`. The machine handles staleness, not the scheduler: a timer that fires into a state where its action is rejected is a normal rejected step.

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

```poly
policy repo-hygiene {
  scope "claude-code"
  var deploys: 0..5 = 0

  obligation tests-before-deploy "After changing source, run the tests before deploying." machine {
    states clean, dirty, tested
    initial clean
    from * when action.kind == "fs.write" && glob(action.path ?? "", "src/**") -> dirty
    from dirty when action.kind == "process.run" && action.target == "test" -> tested
    deny in dirty when action.kind == "custom.deploy" reason "untested-changes"
    end clean, tested
  }

  obligation no-egress-after-secret "Never send data out after reading a secret." rule {
    when action.effects has "egress:external"
    require !history.any(a => a.effects has "read:private") else deny
  }

  obligation orders-irreversible "No irreversible effect on a cancelled order." rule {
    when effect.class == "irreversible" && machine("orders.Order").status == Cancelled
    require false else deny
  }

  recalled style "Follow the house style: no em dashes, short sentences."
}
```

### PT8.2 Lowering

| poly | `polyaxion.policy.json` |
|---|---|
| `obligation … machine { … }` | `kind: "machine"` with `states`, `initial`, `transitions` (`{from, when, to}`), `guards` (`{in, when, reason}`) and `end` |
| `obligation … rule { … }` | `kind: "rule"`, `when` / `require`; `else deny`, `else warn` and `else escalate` map to `severity` |
| `obligation … invariant { … }` | `kind: "invariant"` over declared `vars` |
| `recalled` | `kind: "recalled"`, compiled into `unenforced[]` |

Closed history predicates are lifted into counters and model-checked by Polyaxion. Open ones must be declared `coverage runtime-only`, exactly as Polyaxion requires.

### PT8.3 Referencing program state

`machine("<module>.<Machine>")` is new. It reads the snapshot of the instance that emitted the effect under decision. The value is unknown (Kleene) when the proposal is not an effect of that machine. It requires the Σ extension in PT9.3.

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
  - **escalate:** the intent is held as `escalated` until a recorded approval (`poly approve <intent> --by <person> --ref <escalation>`) re-proposes it with `approved: { by, ref }`. An unmatched approval is refused with `wrong-participant:polyaxion:approval-unmatched`.
- **PT9.3 Σ extension.** The gate's per-session state gains `instances: { [machine/instance]: snapshot }`. It is updated on each committed step of a machine that a policy in scope references. Only referenced machines are mirrored.
- **PT9.4 Settle.** After the handler returns, the worker calls `SETTLE { observed: { ok, output digest } }`, then dispatches the completion action. Taint only grows, as in Polyaxion today.
- **PT9.5 Unavailability.** If the gate is unreachable, the intent stays pending and is not executed. The failure class is `unavailable`. The runtime never fails open.
- **PT9.6 Budget.** Polyaxion measures a 0.63 ms p50 composite merge with durable writes. The in-process placement (AD-4) targets the same order, and the first implementation reports p50 and p99 for PT9.1 to PT9.4.

## PT10. Workflows and worlds

### PT10.1 Workflows

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

### PT10.2 Worlds

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

## PT11. Versions and migration

```poly
machine Order {
  version 2 from 1 {
    migrate { status' = status; items' = items; paid' = paid; giftWrap' = false }
  }
  state { … giftWrap: bool = false }
}
```

- `migrate` lowers to `migrate.cjs`: a pure `migrate(oldState)`.
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
  "at": { "module": "orders", "machine": "Order", "line": 22, "col": 5 },
  "message": "items can leave 0..3",
  "witness": { "id": "sha256:…", "length": 4,
    "trace": [ { "pre": {"status":"Draft","items":0,"paid":false}, "action": "AddItem", "data": {},
                 "post": {"status":"Draft","items":1,"paid":false} } ] },
  "fixes": [
    { "id": "add-require", "edit": { "after": {"line": 21}, "insert": "require items < 3 else reject \"cart-full\"" } },
    { "id": "widen-range", "edit": { "replace": {"line": 13, "col": 14, "len": 4}, "with": "0..4" } } ] }
```

- Fixes are typed edits to the source, so an agent applies them without reinterpreting prose.
- A fix is a proposal. `poly check` must run again after it is applied.

### PT12.2 Code ranges

| Range | Stage | Examples |
|---|---|---|
| PL0xxx | parse, format | `PL0001 SYNTAX` |
| PL1xxx | types, domains | `PL1101 UNBOUNDED_DOMAIN`, `PL1201 POLICY_ONLY_CONSTRUCT` |
| PL2xxx | lowering, strict validate | `PL2101 WRITE_BEFORE_REQUIRE`, `PL2201 SILENT_NOOP` |
| PL3xxx | model check | `PL3001 INVARIANT_REACHABLE`, `PL3002 REJECTION_INVARIANT`, `PL3102 DOMAIN_ESCAPE`, `PL3901 BOUND_HIT` |
| PL4xxx | emission admission | `PL4001 EMISSION_INVARIANT` |
| PL5xxx | composition | `PL5001 COMPOSE_INVARIANT`, `PL5101 CHILDKEY_COLLISION` |
| PL6xxx | policy admission, labels | `PL6001 NOT_FULLY_MEDIATED`, `PL6301 UNLABELLED_EFFECT` |
| PL7xxx | capability proof | `PL7001 REGION_WITNESS` |
| PL8xxx | version gate | `PL8001 LANE_FAILED`, `PL8101 MIGRATION_HOLE` |
| PL9xxx | replay, world | `PL9001 SPEC_DIVERGENCE`, `PL9101 CONTROL_FAILED`, `PL9501 WORLD_REFUSAL` |

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

## PT13. The first experiment

- **Question.** Does a coding agent writing poly ship fewer escaped defects in stateful features than the same agent writing the host language?
- **Tasks.** Ten stateful features, each with a written brief and a hidden reference machine written by a person, drawn from three families:
  - order and payment lifecycles;
  - workflow status derivation (modelled on the hatchet study);
  - leader election roles (modelled on the raft study).

  The task list and briefs are fixed before any run.
- **Arms.**
  1. TypeScript alone.
  2. TypeScript, then polygraph run after the fact with the agent allowed to fix findings.
  3. poly.

  The same agent and model are used in every arm, with the same budget.
- **Oracle.** For each task:
  - a hidden set of invariants;
  - a hidden trace corpus produced by the reference machine;
  - a seeded-defect list.

  An escaped defect is a hidden invariant violated, or a hidden trace the delivered program does not replay.
- **Evolution.** Each task has three follow-up changes to the brief. The measures are the regressions introduced and the regressions caught before delivery.
- **Measures.**
  - escaped defects;
  - iterations and tokens to delivery;
  - wall time;
  - regressions introduced and caught;
  - for arm 3, diagnostics by code and the share of typed fixes the agent applied unchanged.
- **Controls.** Each reference machine must replay its own corpus at 100%, and a mutated reference must fail. A task whose controls fail is removed before any arm is scored.
- **Reporting rule.** Every arm is reported, including a null or negative result for poly. The raw journals are kept.

## PT14. Command surface

| Command | MCP tool | What it does |
|---|---|---|
| `poly new "<description>" [--into module]` | `poly_new` | Drafts a machine with polygen. The draft is not admitted. |
| `poly fmt` | `poly_fmt` | Canonical formatting. Prints the module digest. |
| `poly check [--since v] [--against traces] [--snapshots dir]` | `poly_check` | Runs the pipeline. Returns verdict, diagnostics, witnesses and notRun. |
| `poly explain <code or witness>` | `poly_explain` | Returns the rule, the witness narrative and the fixes. |
| `poly witness <id> --trace/--test` | `poly_witness` | PT12.4. |
| `poly grade` | `poly_grade` | polynv adequacy. |
| `poly admit` | `poly_admit` | Writes and signs the certificate. |
| `poly accept <finding> --by <person>` | (not exposed over MCP) | Records an accepted exception. People only. |
| `poly deploy [--pin/--migrate/--upgrade]` | `poly_deploy` | Loads a certified version into a runtime, with the version gate against live snapshots. |
| `poly run`, `poly dispatch` | `poly_dispatch` | Development runtime. |
| `poly approve <intent> --by --ref` | (not exposed over MCP) | PT9.2 escalation approval. People only. |
| `poly journal verify/replay/export` | `poly_journal` | Ledger verification and replay (PF8.6). |
| `poly export traces` | `poly_export` | PF10.1. |
| `poly mine` | `poly_mine` | Passes journals to Polyx. Returns proposed obligations. |
| `poly propose` | `poly_propose` | Passes agent journals to polyness. Returns proposed workflows. |
| `poly twin`, `poly simulate` | `poly_simulate` | Polytrion, hosted. |

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

One append-only ledger per runtime uses the polyflow platform event format:

```json
{ "v": 1, "run": { "ns": "orders", "wf": "orders.Order", "run": "ord-81" }, "seq": 14,
  "kind": "verdict", "at": "2026-09-29T18:02:11.412Z",
  "body": { "stage": "gate", "outcome": "denied", "reason": "wrong-state:orders-irreversible", "witness": "sha256:…" },
  "prev": "sha256:…", "hash": "sha256:…" }
```

**Event kinds.** The existing kinds are `admission`, `proposal`, `verdict`, `effect`, `observation` and `closure`. poly adds `step`, which carries the polyrun journal row (`seq`, `action`, `data` digest, `stepKind`, `rejectReason`, pre and post digests), and `advice`, which carries the Polyx verdict with no write path (architecture section 9).

**Signing and verification.** Signed heads are `{ run, seq, hash, keyId, alg: "ed25519", sig }`. Verification runs the four Polyaxion checks: signature, chain, binding and replay.

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
  conformance/               lowering conformance: poly source vs hand-written artefacts
```

The build directory per machine matches the engines' expected layout:

```
.poly/build/orders.Order/
  contract.json  next.cjs  invariants.mjs  effects.cjs  effects.manifest.json
  effect-invariants.mjs  migrate.cjs  polyflow.workflow.json (workflows only)
.poly/build/policies/repo-hygiene/polyaxion.policy.json
.poly/build/worlds/checkout/  topology.json  responders.mjs  drivers.mjs  probes.mjs
.poly/certificate.json
```

## PT18. Implementation plan

Each milestone ends with a gate. A milestone is not started until the previous gate passes. The gates reuse the stack's doctrine: controls first, and a defect becomes a gate.

| Milestone | Scope | Gate |
|---|---|---|
| M0 · Language core | Parser, formatter, AST digest, types and domains, lowering of `state`, `action`, `on`, `guard` and the three invariant kinds | The turnstile, raft-roles and hatchet-status machines, written in poly, replay their existing field-study corpora at 100%. Their negative controls fail. Lowered `next.cjs` passes strict `validate()`. |
| M1 · Effects and composition | `emit`, effect declarations, timers, children, emission and compose invariants | The `polyrun-oms` order machine in poly gives the same `check-effects` and `check-product` results as the hand-written artefacts (acceptance criterion AC1). |
| M2 · Diagnostics | Diagnostic model, verdict fold, witness export to trace and test, typed fixes | For every seeded defect in the conformance suite, the exported test fails before the fix and passes after it (AC3). |
| M3 · Runtime | `poly-runtime`: certificate check, polyrun host, ledger writer, journal verify and replay | Journal replay reproduces every post-state (AC6). A tampered artefact is refused at load. |
| M4 · Governance | Policy lowering, gate hook (PT9), Σ extension, polycheck stage, escalation | AC4. Gate p50 and p99 are reported. The gate never fails open under an injected outage. |
| M5 · Agents | Workflow lowering, MCP server, Claude Code plugin, `poly new` | AC5. A workflow in poly runs through unchanged polyflow tools. |
| M6 · Feedback and worlds | `poly mine`, `poly propose`, world lowering, `poly twin` | A Polyx rule adjudicated `real` round-trips to an admitted obligation. A world lowers and runs on hosted Polytrion. |
| M7 · Experiment | PT13 | Results published with every arm reported. |

## PT19. Limits

- **Bounded checks.** Checks are exhaustive only over declared check domains. A defect that needs a value outside the domain is not found. Domain drift at runtime is recorded (PT3.4), not prevented.
- **Model-code gap.** poly removes the gap between model and code for the machine itself. It does not check host handlers. Handler behaviour is observed only through completion actions and the `SETTLE` record.
- **State explosion.** It is managed by small machines and atomic cascades, not by abstraction. A check that hits its bound reports `INCONCLUSIVE` (`PL3901 BOUND_HIT`).
- **Advice.** Advice is recorded but not enforced until it is promoted, adjudicated and admitted.
- **Worlds.** Worlds need the hosted Polytrion engine. Without it, stage 9 is not run.
- **Language models.** The toolchain calls a language model only in `poly new` and in optional explanation text. No verdict depends on one.

## Conclusion

The technical core of poly is a lowering table and a verdict fold:

- Every construct maps to an artefact an existing engine reads.
- Every engine result maps to a diagnostic with a stable code, a witness and typed fixes.

The new engineering is small and bounded:

- the language front end;
- the gate hook in the outbox worker, with its Σ extension;
- one ledger;
- the certificate that binds what was checked to what runs.

The plan reaches a measurable claim at M7. The experiment tests whether an agent writing poly ships fewer escaped defects than the same agent writing the host language, on tasks and oracles fixed before any run.
