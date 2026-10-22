# poly syntax: one checked example per construct

Every fenced block below that names a file (` ```poly gate.poly `) is a real file. `test/skill-syntax.test.mjs` writes the blocks of each section into a folder, runs `poly check` on the program, and requires `CLEAN` with no diagnostic. A section with a `.policy.poly` block is checked as a project, with the policy signed as a person signs it. A block tagged `json` is a file the program reads, beside it.

Copy a block, then change it. Keep a block's shape and run `poly_check` after each change.

## Machine

A machine has typed state, actions, handlers, and a terminal condition. A field is `name : Type = initial`. A type is `bool`, `int`, `string`, a range `lo..hi`, an enum, a union, `map<K, V>`, `Ref<M>`, `Content`, `Principal`, `Items` or `Conf`.

```poly gate.poly
module gate

enum Phase { Idle, Open, Closed }

type Door = Shut | Ajar { gap: 1..3 }

machine Gate {
  state {
    phase : Phase = Idle
    coins : 0..3  = 0
    door  : Door  = Shut
    seen  : map<Phase, bool> = { Idle: true, Open: false, Closed: false }
  }
  terminal phase == Closed

  action Coin()
  action Push(force: 1..3)
  action Close()

  on Coin {
    require coins < 3 else reject "coin-box-full"
    coins' = coins + 1
    phase' = Open
    seen' = seen with [Open] = true
  }
  on Push(force) {
    require phase == Open else reject "not-open"
    let wide = force > 1
    match door {
      Shut => door' = Ajar { gap: force }
      Ajar { gap: _ } => reject "already-ajar"
    }
    if wide {
      coins' = 0
    }
  }
  on Close {
    require phase == Open else reject "not-open"
    phase' = Closed
  }

  invariant idle-means-empty: phase == Idle implies coins == 0
}
```

- `f'` is the post-state value. It is write-only: reading it is `PL1202`. Write a field once per path (`PL2102`).
- Every `require` comes before the first write (`PL2101`). Every path writes, emits or rejects (`PL2201`).
- A `match` covers every constructor, or ends with `_` (`PL1501`).
- A parameter named like a field shadows it and draws a warning. Rename the parameter.
- The checker tries every value of a declared range. A write that can leave the range is `PL3102`.

## Decision

A decision asks a model. Its answer comes back as a completion action, and `failed` is required (`PL6202`). The machine never reads a model's answer except through those actions.

```poly desk.poly
module desk

enum Branch { Refund, Other }
enum Phase { Idle, Classifying, Done }

machine Desk {
  state {
    phase  : Phase  = Idle
    branch : Branch = Other
  }
  terminal phase == Done

  action Ask(body: Content)
  action Classified(which: Branch)
  action Unclassified()

  on Ask(body) {
    require phase == Idle else reject "busy"
    phase' = Classifying
    decide classify(body: body)
  }
  on Classified(which) {
    require phase == Classifying else reject "not-classifying"
    branch' = which
    phase' = Done
  }
  on Unclassified {
    require phase == Classifying else reject "not-classifying"
    phase' = Done
  }

  decision classify(body: Content) -> Branch {
    provider "small"
    labels { egress:external, read:private }
    timeout 800ms
    ok(r) -> Classified(which: r.answer)
    failed -> Unclassified()
  }
}
```

`r.answer` is the typed answer. `r.conf` and `r.margin` are `Conf` values, passed on as parameters of type `Conf` and compared with a decimal literal such as `conf >= 0.8`. A decision that cites items adds `cites <param>` and reads `r.cites`.

## Effect, retry and idempotency

An effect is a promise about the outside world. It names its kind, its labels, the targets those labels grant, and its class. It maps each outcome to an action: `ok`, `failed`, and `exhausted` (every attempt ended without an answer).

```poly refund.poly
module refund

enum Phase { Idle, Asked, Refunded, Failed, Unknown }

machine Desk {
  state { phase : Phase = Idle }
  terminal phase in { Refunded, Failed, Unknown }

  action Ask(amount: 0..500)
  action Refunded()
  action RefundFailed()
  action RefundUnknown()

  on Ask {
    require phase == Idle else reject "asked"
    phase' = Asked
    emit refund(amount)
  }
  on Refunded {
    require phase == Asked else reject "not-asked"
    phase' = Refunded
  }
  on RefundFailed {
    require phase == Asked else reject "not-asked"
    phase' = Failed
  }
  on RefundUnknown {
    require phase == Asked else reject "not-asked"
    phase' = Unknown
  }

  effect refund(amount: 0..500) {
    kind "payments.refund"
    labels { egress:external }
    targets { egress: "https://api.stripe.com/v1/refunds" }
    class irreversible
    retry { attempts 3, base 200ms, timeout 5s }
    idempotent header "Idempotency-Key" window 24h
    ok -> Refunded()
    failed -> RefundFailed()
    exhausted -> RefundUnknown()
  }
}
```

- An irreversible effect that may be attempted twice must be one of: `retry { attempts 1 }` (at most once), `idempotent header "<name>" window <d>`, or `idempotent by nature "<std name>"`. Otherwise `PL4003`, with a witness in which the target executes twice.
- The idempotency window must be longer than the retry horizon (`PL4004`).
- A target needs a label that grants its kind: `egress` targets need `egress:external` or `egress:public` (`PL6303`).
- The key only proves the request is sent keyed. The check cannot prove the provider honours it. It prints that as assumption K17.

## Route and budget

A route names tiers of models and when to escalate. A budget caps spend. A decision names a route and no provider. Price tables are JSON files beside the source.

```poly triage.poly
module triage

enum Branch { Refund, Other }
enum Phase { Idle, Classifying, Done }

machine Desk {
  state {
    phase  : Phase  = Idle
    branch : Branch = Other
  }
  terminal phase == Done

  action Ask(body: Content)
  action Classified(which: Branch)
  action Unclassified()

  on Ask(body) {
    require phase == Idle else reject "busy"
    phase' = Classifying
    decide classify(body: body)
  }
  on Classified(which) {
    require phase == Classifying else reject "not-classifying"
    branch' = which
    phase' = Done
  }
  on Unclassified {
    require phase == Classifying else reject "not-classifying"
    phase' = Done
  }

  decision classify(body: Content) -> Branch {
    route triage
    labels { egress:external, read:private }
    timeout 800ms
    ok(r) -> Classified(which: r.answer)
    failed -> Unclassified()
  }
}

route triage {
  tier small provider "small" prices "prices/small.json" max input tokens 2000 max tokens 4000
  tier large provider "large" prices "prices/large.json" max input tokens 2000 max tokens 8000
  escalate when failed
  budget spend
}

budget spend {
  cap usd 0.5 per run
  cap usd 20 per day per scope
  on exhausted escalate
}
```

```json prices/small.json
{
  "v": 1,
  "provider": "small",
  "model": "flash-2026-09",
  "currency": "usd",
  "perMillionTokens": { "input": 100000, "output": 400000 },
  "source": "https://example.com/pricing",
  "readOn": "2026-10-07"
}
```

```json prices/large.json
{
  "v": 1,
  "provider": "large",
  "model": "opus-2026-09",
  "currency": "usd",
  "perMillionTokens": { "input": 1000000, "output": 4000000 },
  "source": "https://example.com/pricing",
  "readOn": "2026-10-07"
}
```

- A price table needs the class `input`, an https `source` and a `readOn` date (`PL6843`).
- `escalate when conf < 0.8 or margin < 0.1` needs `calibration "maps/<tier>.json"` on every tier it reads through (`PL6841`). A map is the output of `poly journal fit`. Never write one by hand to pass.
- All tiers and caps use one currency (`PL6844`). A tier whose reservation exceeds a cap can never be called (`PL6845`).
- The tier's model is its price table's `model`. A map fitted for another model is `PL6842`.

## Policy

A policy is a `.policy.poly` file beside the program it governs. It is checked with the program, as one project, and a person signs it before admission. The agent never signs.

```poly refund.poly
module refund

enum Phase { Idle, Asked, Done }

machine Desk {
  state {
    phase : Phase = Idle
    large : bool  = false
  }
  terminal phase == Done

  action Ask(amount: 0..500)
  action Refunded()
  action RefundFailed()

  on Ask {
    require phase == Idle else reject "asked"
    phase' = Asked
    large' = amount > 100
    emit refund(amount)
  }
  on Refunded {
    require phase == Asked else reject "not-asked"
    phase' = Done
  }
  on RefundFailed {
    require phase == Asked else reject "not-asked"
    phase' = Done
  }

  effect refund(amount: 0..500) {
    kind "payments.refund"
    labels { egress:external }
    targets { egress: "https://api.stripe.com/v1/refunds" }
    class irreversible
    retry { attempts 1 }
    ok -> Refunded()
    failed -> RefundFailed()
  }
}
```

```poly refund.policy.poly
module refund_policy

policy refunds {
  scope "refund"
  obligation large-refund-reviewed "A refund above 100 is issued only after a person approves it." rule {
    when proposal.kind == "effect" && effect.kind == "payments.refund" && machine("refund.Desk").large
    require false else escalate
    on unknown escalate
  }
}
```

- A rule is `when <guard> require <expr> else deny | warn | escalate`, then `on unknown escalate | deny | skip`.
- `machine("module.Machine").field` reads program state. Policy expressions are three-valued: an input may be unknown, and `on unknown` says what then happens.
- `escalate` waits for a person's signed approval. Do not write a rule so that the agent can approve its own escalation.

## Workflow

A workflow maps a machine's input action and each effect kind to an agent tool. Its machine needs a path property (`PL6804`) and one tool per effect kind (`PL6803`).

```poly brief.poly
module brief

enum Phase { Idle, Posting, Posted }

machine Brief {
  state { phase : Phase = Idle }
  terminal phase == Posted

  action Start(date: string check { "2026-10-04", "2026-10-05" })
  action Done()

  on Start(date) {
    require phase == Idle else reject "busy"
    phase' = Posting
    emit post(1)
  }
  on Done {
    require phase == Posting else reject "not-posting"
    phase' = Posted
  }

  path property one-post: count("brief.post") <= 1

  effect post(n: 0..1) {
    kind "brief.post"
    labels { egress:external }
    targets { egress: "https://slack.example/api/chat.postMessage" }
    class irreversible
    retry { attempts 1 }
    ok -> Done()
    failed -> Done()
  }
}

workflow customer-brief runs Brief {
  input Start
  key "{date}" where date matches "^\\d{4}-\\d{2}-\\d{2}$"
  tool "brief.post" -> slack_send target "#cs" why "publish the approved brief"
}
```

The key template names fields of the input action. A backslash in a pattern is doubled.

## Properties

A property is what the checker proves or refutes over every reachable state.

```poly ticket.poly
module ticket

enum Phase { Idle, Asked, Done }

machine Desk {
  state {
    phase  : Phase = Idle
    ledger : bool  = false
  }
  terminal phase == Done

  action Ask(amount: 0..500)
  action Refunded()
  action RefundUnknown()

  on Ask {
    require phase == Idle else reject "asked"
    phase' = Asked
    if !ledger {
      ledger' = true
      emit refund(amount)
    }
  }
  on Refunded {
    require phase == Asked else reject "not-asked"
    phase' = Done
  }
  on RefundUnknown {
    require phase == Asked else reject "not-asked"
    phase' = Idle
  }

  effect refund(amount: 0..500) {
    kind "payments.refund"
    labels { egress:external }
    targets { egress: "https://api.stripe.com/v1/refunds" }
    class irreversible
    retry { attempts 1 }
    ok -> Refunded()
    failed -> RefundUnknown()
  }

  invariant done-means-ledger: phase == Done implies ledger
  step property asked-by-ask: (post.phase == Asked && pre.phase != Asked) implies action == Ask
  reject property ask-once: (action == Ask && pre.phase == Asked) implies rejected("asked")
  path property one-refund: count("payments.refund") <= 1
  never refund-twice: emit refund while ledger
  liveness settles: phase == Asked leads to phase == Idle || phase == Done under fair { Refunded, RefundUnknown }
}
```

| Kind | Says | Reads |
|---|---|---|
| `invariant` | true in every reachable state | fields |
| `step property` | true of every accepted step | `pre.f`, `post.f`, `action`, `emits(k, f: v)` |
| `reject property` | a stated step is refused with a stated reason | `pre.f`, `action`, `rejected("reason")` |
| `path property` | true of every run | `count("kind")`, `before("k1", "k2")` |
| `never` | no emit of an effect while a state condition holds | fields |
| `liveness` | a goal is reached, or `p leads to q`, under fairness | fields, `fair { actions }` |

A property no reachable step can exercise is reported as vacuous. Treat a vacuous `never` as a property that guards nothing, and ask what state it should have talked about.

## Compose invariant

A parent that spawns a child can state an invariant over both. It reads the child only where it is known to be spawned.

```poly shop.poly
module shop

enum OrderStatus { Open, Shipping, Done }
enum ShipStatus { Pending, Delivered }

machine Shipment {
  state {
    ship : ShipStatus = Pending
    size : 0..2       = 0
  }
  terminal ship == Delivered

  action Start(units: 0..2)
  action Deliver()

  on Start(units) {
    require ship == Pending else reject "started"
    size' = units
  }
  on Deliver {
    require ship == Pending else reject "delivered"
    ship' = Delivered
  }
}

machine Order {
  state { status : OrderStatus = Open }
  terminal status == Done

  action Checkout()
  action Shipped()

  on Checkout {
    require status == Open else reject "not-open"
    status' = Shipping
    spawn Shipment as box -> Start(units: 1) on complete -> Shipped
  }
  on Shipped {
    require status == Shipping else reject "not-shipping"
    status' = Done
  }

  compose invariant done-means-delivered: parent.status == Done implies (box spawned && children.box.ship == Delivered)
}
```

A read of `children.box.f` without `box spawned` in scope is `PL5103`.

## Configuration invariant

A configuration runs several machines together, with messages between them. `bounds` is required (`PL5303`). A read of a group needs a quantifier or an aggregate (`PL5403`).

```poly checkout.poly
module checkout

service machine Inventory {
  state { onHand : 0..1 = 1 }
  action Query(from: Ref<Order>)
  action Take(from: Ref<Order>)

  on Query(from) {
    send from <- Available(n: onHand)
  }
  on Take(from) {
    if onHand > 0 {
      onHand' = onHand - 1
      send from <- Taken()
    } else {
      send from <- OutOfStock()
    }
  }
}

type OrderState = Idle | Asked | Taking | Done | Refused

machine Order {
  state {
    st  : OrderState = Idle
    inv : Ref<Inventory> = none
  }
  terminal st is Done | Refused

  action Place()
  action Available(n: 0..1)
  action Taken()
  action OutOfStock()

  on Place {
    require st is Idle else reject "not-idle"
    st' = Asked
    send inv <- Query(from: self)
  }
  on Available(n) {
    require st is Asked else reject "not-asked"
    if n > 0 {
      st' = Taking
      send inv <- Take(from: self)
    } else {
      st' = Refused
    }
  }
  on Taken {
    require st is Taking else reject "not-taking"
    st' = Done
  }
  on OutOfStock {
    require st is Taking else reject "not-taking"
    st' = Refused
  }
}

configuration two-buyers {
  inv      : Inventory
  order[2] : Order { inv: inv }
  inputs   { order[*].Place }
  bounds   { transit 4 }
  invariant confirmed-within-stock: count(order[*] is Done) <= init(inv.onHand)
}
```

## Glossary

- **Action**: a named input to a machine, with typed parameters. A handler answers it.
- **Check domain**: the finite set of values the checker tries for a field or parameter. A range is its own domain.
- **Completion**: the action an effect or decision dispatches when it ends (`ok`, `failed`, `exhausted`).
- **Configuration**: several machines checked together with the messages between them.
- **Idempotency key**: a header the runtime sends on every attempt of an effect so a provider that honours it executes the request once.
- **Instance (checked)**: the domains, bounds and state count a verdict was computed over. Every verdict prints it.
- **Project**: a program and the policy beside it, checked as one.
- **Vacuous**: a property whose antecedent no reachable step satisfies, so it constrains nothing.
- **Witness**: the steps by which a property is broken.
