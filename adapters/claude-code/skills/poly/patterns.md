# poly patterns: four shapes that come up with irreversible effects

Each pattern comes from an example in this repository, named under its heading. Read the example when you need the whole program. The excerpts below are copied from it.

## An uncertain outcome, and Resolve

**Source:** `examples/concierge/concierge.poly` (the `Desk`), `examples/retry/refund-keyed.poly`.

**The problem.** An effect can end in three ways, not two: it worked, it was refused, or every attempt ended with no answer and nobody knows. A program with only `ok` and `failed` maps the third case to `failed`, tells the customer "declined", and invites a second request. If the first refund did execute, the customer is refunded twice.

**The shape.** Declare `exhausted`, send it to its own action, and keep that outcome out of every path that treats the effect as not done.

```poly
effect refund(amount: 0..500, customer: Principal, order: Items) {
  ...
  idempotent header "Idempotency-Key" window 24h
  ok -> Refunded()
  failed -> RefundFailed()
  exhausted -> RefundUnknown()
}
```

The `Desk` then keeps a ledger field of three values, and only a person moves it out of the uncertain one:

```poly
enum Ledger { None, Unknown, Issued }

on RefundUnknown {
  require phase == Refunding else reject "not-refunding"
  phase' = Answering
  decide reply(question: question, outcome: Checking)
}

on Resolve(done) by op: Operator {
  require refund == Unknown else reject "not-unknown"
  require phase != Refunding else reject "refund-in-flight"
  if done {
    refund' = Issued
  } else {
    refund' = None
  }
}
```

**What to copy.**
- The customer is told `Checking`, never `Declined`. `Declined` is for a definite refusal (below).
- `Resolve` is dispatched by the host, from a person's signed record, and carries the claims type `Operator`. A message from a channel cannot dispatch it. The agent does not resolve a refund on a person's behalf.
- A key makes the retries of one intent safe. It does not stop a second intent, which has a new key. The ledger does (next pattern).

## The ledger and its ghost-field property

**Source:** `examples/concierge/concierge.poly` (`refund: Ledger` and `never no-reissue`); `docs/demo/part4/` (the ghost-field form on a program that kept no ledger); the program is `demo/baseline/runs/poly-kept/tree/src/support.poly`.

**The problem.** A second request for the same order is a second intent with a second key. Nothing in the key or in a lint on the handler sees it. It is a fact about the paths of the machine: after an uncertain end, the machine returns to a state that forms a new refund.

**Shape A: a ledger the machine consults.** The concierge keeps `refund: Ledger` and emits only when it is `None`:

```poly
if refund == None {
  phase' = Refunding
  large' = value > 100
  refund' = Unknown
  emit refund(amount: value, customer: customer, order: cites)
}
...
never no-reissue: emit refund while refund != None
```

**Shape B: a ghost field, when the machine has no ledger yet.** A ghost field is a field that only the property reads. The property needs one field, three updates and one `never` clause per line (8 lines for four lines of an order, `docs/demo/part4/mutation-c.diff`):

```poly
issued   : map<0..3, bool> = [false, false, false, false]

// Confirm sets it:
issued' = [issued[0] || want[0], issued[1] || want[1], issued[2] || want[2], issued[3] || want[3]]
// RefundFailed and Resolve with done false clear it:
issued' = [issued[0] && !want[0], issued[1] && !want[1], issued[2] && !want[2], issued[3] && !want[3]]

never no-reissue-0: emit refund(l0: true) while issued[0]
```

**What the check says** (`docs/demo/part4/*.check.txt`):

| Program | Verdict |
|---|---|
| `poly-kept`: an uncertain end goes to `Review`, a person decides | `CLEAN`, 226 states |
| mutation (c): an uncertain end goes back to `Idle`, shipped properties only | `CLEAN`, 161 states. The shipped properties speak of lines confirmed at Stripe, and an uncertain refund is not confirmed. |
| mutation (c) with the ghost field and `no-reissue` | `FINDINGS`, four `PL3002`, each with a witness of 6 steps |
| `poly-kept` with the same property | `CLEAN`, 226 states |

The witness of `no-reissue-0`, as the checker prints its actions:

```
1. Open(1)
2. RequestAll(true)   emits whatsapp.ticket
3. Confirm()          emits stripe.refund
4. RefundUnknown()    Refunding -> Idle, emits whatsapp.ticket
5. RequestAll(true)   emits whatsapp.ticket
6. Confirm()          emits stripe.refund   (violates no-reissue-0: issued[0] is true)
```

**What to copy.**
- The property has to be written. The shipped properties of the kept build were `CLEAN` on the mutation. Do not assume a clean check covers a path property nobody stated.
- Put the guard where the machine reaches it with the ledger set. A guard in a handler the machine never enters with the ledger set leaves the `never` vacuous, and the check says `vacuous:` and cannot read `CLEAN`.
- The ledger is per machine instance. `Items` is opaque (PS1.4b), so a `Desk` cannot tell which order it cites. One unresolved refund blocks a second on the same thread.

## Definite refusal versus ambiguity

**Source:** `examples/concierge/concierge.poly` (`RefundFailed` and `RefundUnknown`), `examples/concierge/host/refund.mjs` (the handler), `examples/retry/refund-at-most-once.poly`.

**The problem.** `failed` clears the ledger and tells the customer "declined". That is right only if the target did not execute. A handler decides this: it knows whether it was refused.

**The shape in the program:** two outcomes, two actions, two different words to the customer and two different ledger writes (`RefundFailed` sets `refund' = None`; `RefundUnknown` leaves `Unknown`).

**The shape in the handler.** A refusal that the same inputs would repeat is a permanent error. Anything else is a plain error, which is retried with the same key:

```js
const refuse = (message) => Object.assign(new Error(message), { permanent: true });
...
if (res.status !== 200) throw res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 409 ? refuse(`refunds.create answered ${res.status}`) : new Error(`refunds.create answered ${res.status}`);
```

A permanent error ends the effect at once with `failed` (S138). A plain error is retried, and when every attempt ends it is `exhausted`. If the effect declares no `exhausted`, every lost attempt is delivered as `failed`, which is the defect of v1.3.0.

**What to copy.**
- A 409 on a keyed request is not a refusal. It can mean the first request with that key is still running, so it is retried (DF20). A permanent error there would clear the ledger while the first refund executes.
- If the effect cannot be made safe to retry, say so in the program: `retry { attempts 1 }` (`examples/retry/refund-at-most-once.poly`) makes one attempt, and a lost answer ends as `failed` or `exhausted`.
- Do not write the check to pass by turning every non-2xx into a permanent error.

## Cited answers

**Source:** `examples/concierge/concierge.poly` (`source orders`, `effect lookup`, `decision answer`, `decision amount`, `Amounted`).

**The problem.** A model answer that mentions an order the customer does not own, or no order at all, must not reach a customer or an effect.

**The shape.** Retrieve with an owner predicate, hand the item set to a decision with `cites`, and bind `r.cites`:

```poly
effect lookup(customer: Principal) {
  retrieve orders where owner == customer limit 2
  ok(r) -> Found(items: r.items)
  failed -> LookupFailed()
}

decision answer(question: Content, context: Items) -> Content {
  provider "small"
  labels { egress:external, read:private }
  timeout 2s
  cites context
  ok(r) -> Cited(text: r.answer, cites: r.cites)
  failed -> AnswerFailed()
}
```

The runtime refuses an answer that cites an item it was not given, or cites none, with the reserved reason `uncited`. The decision's `failed` outcome is delivered in its place, so `failed` must lead somewhere safe.

An effect that acts on one order says so with `one order`, and the handler reads that item before it acts. The program guards the emit on the count, with an `if`, not a `require`:

```poly
if cites.count == 1 {
  ...
  emit refund(amount: value, customer: customer, order: cites)
} else {
  phase' = Answering
  decide reply(question: question, outcome: Unsure)
}
```

**What to copy.**
- Guard a completion with `if`, not `require`. A rejected completion of the program's own decision leaves the machine waiting for ever, because a decision gives one completion. The machine check cannot see that. The generated configuration can, and reports `PL5409`.
- `Items` is opaque. A machine reads `x.count`, passes it whole to a decision or an effect, and cannot store or compare it (`PL1209`).

## Glossary

- **Ambiguous end:** an effect whose attempts all ended with no answer, so the target may or may not have executed it. The outcome `exhausted`.
- **Definite refusal:** an effect the target refused, so it did not execute. The outcome `failed`, from a permanent error.
- **Ghost field:** a field kept only so a property can read it; no handler decision depends on it.
- **Idempotency key:** the intent id sent as a header on every attempt of one intent, so a provider that honours it executes the request once.
- **Ledger:** a field that remembers what a machine has done with an effect, so a second request can be refused by the program.
- **Operator (claims):** the claims type of `Resolve`; only a person's signed record, verified by the host, can supply it.
- **Path fact:** a fact about sequences of steps, such as a second refund after an uncertain end, which no single line states.
- **Vacuous:** a property whose condition no reachable step meets, so it constrains nothing.
