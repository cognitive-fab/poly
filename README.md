# poly

**A programming language and runtime for the stateful core of software written by coding agents.**

A poly program is a set of declared state machines. Each machine carries its contract, its invariants, its effects and the obligations that govern it. The compiler checks the program exhaustively over declared finite domains before it may run. The runtime executes the same program durably, gates every effect, and writes a ledger that replays exactly.

poly adds no new checking, simulation or governance engine. It is a compiler, a toolchain and one runtime integration over the Poly stack. Every construct lowers to an artefact an existing engine already reads:

| Stage | Engines |
|---|---|
| Model and check | SAM v2, polygraph, polyrun, polyvers, polynv |
| Govern | Polyaxion, polycheck |
| Workflows | polyflow, polycrew |
| Learn | Polyx, polyness |
| Simulate (v2) | Polytrion |

> Status: v1.7.0, released on 2026-11-08. What changed is in [the release notes](docs/release-notes-v1.7.md).

## Before and after

A customer asks for a refund, it is paid, and the customer writes again. A desk that keeps a ledger and does not read it before paying pays the order twice. [Refund twice](examples/refund-twice/README.md) shows that one mistake in TypeScript, where the desk's own tests pass, and in poly, where the rule `never no-reissue: emit refund while refund != None` is written once and `poly check` refuses the same mistake with the two steps that pay twice. The TypeScript was written by hand to show the mistake; it measures nothing.

## Using poly with a coding agent

`poly guide` prints a guide written for a coding agent: the loop, the verdicts, where the rules live and what never to do. Put these lines in a project's `AGENTS.md` or `CLAUDE.md`:

- Run `poly guide` to learn poly before writing any.
- Keep the rules that must always hold in poly: invariants, `never` statements and signed policies.
- Run `poly check` before committing; only `CLEAN` is done.
- Never edit a signed policy or accept a finding: those are the owner's.

No command writes them for you. Over MCP the guide is the tool `poly_guide`.

## Hello, world

A turnstile. Put a coin in, it unlocks; push it, it locks.

```poly
module hello

type Mode = Locked | Unlocked

machine Gate {
  state {
    mode  : Mode = Locked
    coins : 0..3 = 0
  }
  action Coin()
  action Push()

  on Coin {
    require coins < 3 else reject "coin-box-full"
    coins' = coins + 1
    mode' = Unlocked
  }
  on Push {
    require mode is Unlocked else reject "locked"
    mode' = Locked
  }

  invariant locked-when-empty: coins == 0 implies mode is Locked
}
```

```
$ poly check hello.poly
hello.poly:5  PL3201 DEADLOCK  Gate
  no action is accepted in a reachable non-terminal state
  witness (4 steps):
    Coin()   Locked/0   -> Unlocked/1
    Coin()   Unlocked/1 -> Unlocked/2
    Coin()   Unlocked/2 -> Unlocked/3
    Push()   Unlocked/3 -> Locked/3      then Coin: coin-box-full, Push: locked
verdict: FINDINGS (exit 1)  over coins ∈ 0..3; 7 states
```

The invariant holds. What `poly check` finds is that a full coin box locks the turnstile forever. Add an operator action and it is clean:

```poly
  action Empty()
  on Empty {
    require mode is Locked else reject "unlocked"
    coins' = 0
  }
```

Running it from TypeScript takes three lines:

```ts
const rt = await load('./.poly/build')
const gate = await rt.create('hello.Gate')
await rt.dispatch(gate.id, 'Coin', {}, { actionId: 'coin-1' })   // { stepKind: 'accepted', state: { mode: 'Unlocked', coins: 1 } }
```

Handlers are pure functions of the pre-state: a primed field is written, never read. That is why the order of lines inside a handler cannot change what it does. The same machine can also be written as TypeScript with the embedded surface (technical specification, PT2.5).

## A second look: the double charge

```poly
machine Order {
  state {
    status : Status = Draft
    items  : 0..3   = 0
    paid   : bool   = false
  }
  action AddItem()
  action Place()
  action Pay(amount: int check { 10, 20 })

  on Place {
    require status == Draft else reject "not-draft"
    require items > 0      else reject "empty-order"
    status' = Placed
  }
  on Pay(amount) {
    require status == Placed else reject "not-placed"
    emit charge(amount)
  }

  invariant shipped-was-paid: status == Shipped implies paid
  path property charge-at-most-once: count("payment.charge") <= 1

  effect charge(amount: int) {
    kind "payment.charge"
    labels { egress:external }
    class irreversible
    ok -> PaymentOk()
    failed -> PaymentFailed(code: "declined")
  }
}
```

`poly check` finds that two `Pay` calls emit two charges, and says why they can:

```
orders.poly:17  PL4001 PATH_PROPERTY  charge-at-most-once
  witness (4 steps):
    AddItem()      Draft/0  -> Draft/1
    Place()        Draft/1  -> Placed/1
    Pay(10)        Placed/1 -> Placed/1   emits payment.charge
    Pay(10)        Placed/1 -> Placed/1   emits payment.charge   <- count = 2
  test:  poly witness sha256:3be1… --test   (fails on this program)
  fixes: [enter-charging-status]  add status Charging, entered by Pay, left by PaymentOk / PaymentFailed
orders.poly:16  PL4002 EMIT_WITHOUT_STATE_CHANGE  Pay
  Pay emits payment.charge and leaves the state unchanged, so it can repeat its effect without limit
  witness (4 steps):
    AddItem()      Draft/0  -> Draft/1
    Place()        Draft/1  -> Placed/1
    Pay(10)        Placed/1 -> Placed/1   emits payment.charge
    Pay(10)        Placed/1 -> Placed/1   emits payment.charge
  fixes: [enter-charging-status]  record the emission in the state
verdict: FINDINGS (exit 1)  over items ∈ 0..3, amount ∈ {10, 20}
```

Each call is allowed; the sequence is not. The second finding names the cause: a step that emits and changes nothing can always be taken again. That is the bug the Poly stack was built to find, reported before the program can run. The snippet is abridged; the full example is in the technical specification, PT4.5.



## A third look: machines that talk

Machines hold addresses, not each other's state, and talk only by `send`. A **configuration** checks several of them together, with messages arriving in any order. In the checkout example (technical specification, PT7a), an inventory and each order are safe on their own. If the order confirms as soon as it hears "available", two orders can both be confirmed against the last unit:

```
checkout.poly:33  PL5401 CONFIGURATION_INVARIANT  confirmed-within-stock
  witness: Place@order[0], Place@order[1], Query(order[0]) -> inv, Query(order[1]) -> inv,
           Available(1) -> order[0], Available(1) -> order[1]
```

No per-machine check can see this. The defect lives in the arrival order between machines.

## Checking a large program

A program of many machines is checked after every change, and a host used to check the same machine many times over: once for each configuration it checked apart, once for each copy that added a probe, once for each copy that seeded a defect. `poly check` now keeps each machine's result and each configuration's result in a cache, under a key of what the result depends on, and reads back whatever nothing changed (technical specification, PT14a).

```
poly check app.poly                                  # every machine, then every configuration; fills .poly/cache
poly check app.poly                                  # the same again: everything is read back
poly check app.poly --config order-flow,order-parts  # these two configurations; the others are listed as not run
poly check app.poly --goals goals.json               # each goal reached with its path, or PL5410 GOAL_UNREACHED
poly check app.poly --defects defects.json           # each seeded defect applied in memory: found or NOT FOUND
poly check app.poly --no-cache                       # neither reads nor writes the cache
```

A **goal** names a path a configuration is meant to cover, written like an invariant that the path breaks: `{ "configuration": "order-short", "name": "split", "expr": "!(order.path == ViaSplit && order.st == Picking)" }`. A `CLEAN` configuration says nothing about a path no input reaches; a reached goal shows the path is there. A **seeded defect** is a list of find-and-replace edits with the finding it must produce. A defect the check no longer finds means a property no longer sees the fault it was written for.

The verdict never depends on the cache: with it, without it, cold or warm, a program gets the same findings. Only the command line reads a cache: `poly admit` never does, and the test suite turns the command line's default off. A stage read back from the cache says so in its note.

**Checks side by side.** No check package starts a process or a thread, so a host that wants its seeded defects or its configurations checked in parallel starts several `poly check` processes that share one cache. One process checks every machine and fills the cache; then the others each read the machines back and check only what they are given:

```
poly check app.poly --cache /shared/cache --root /tmp/all                                      # first, alone
poly check app.poly --defects defects.json --only a,b --cache /shared/cache --root /tmp/d1 &   # then side by side
poly check app.poly --defects defects.json --only c,d --cache /shared/cache --root /tmp/d2 &
poly check app.poly --config order-parts --cache /shared/cache --root /tmp/c1 &
```

Give each process its own `--root`. Two processes that meet the same new key both check it and write the same entry, and neither reads a half-written one. A check of a large machine can hold several gigabytes, so start as many processes as the memory holds, not as many as there are processors.

## Documents

| Document | What it covers |
|---|---|
| [`docs/01-functional-spec.md`](docs/01-functional-spec.md) | The problem, users, goals, non-goals, functional requirements (`PF`), acceptance criteria and risks |
| [`docs/02-architecture.md`](docs/02-architecture.md) | Layers, the lowering map, the check pipeline, the certificate, the runtime and the gate, one ledger, the agent interface and architectural decisions (`PA`, `AD`) |
| [`docs/04-semantics.md`](docs/04-semantics.md) | What a poly program means: states, steps, rejected steps, behaviours, the five kinds of property, fairness and liveness, composition, three-valued policies, lowering correctness, kernel assumptions and operator precedence (`PS`). The other documents defer to it. |
| [`docs/03-technical-spec.md`](docs/03-technical-spec.md) | Grammar, types and domains, step semantics, invariants, effects, policies, the gate integration, diagnostics, commands, host API, ledger, layout, implementation plan and the first experiment (`PT`) |
| [`docs/research/primitive-inventory.md`](docs/research/primitive-inventory.md) | The design-time and runtime primitives of every engine, read from source |
| [`docs/reviews/review-2026-09-29-blunt.md`](docs/reviews/review-2026-09-29-blunt.md) | The v0.1 peer review |
| [`docs/reviews/response-2026-09-29.md`](docs/reviews/response-2026-09-29.md) | The response to the review, item by item, and what changed in v0.2 |
| [`docs/reviews/review-2026-09-29-formal.md`](docs/reviews/review-2026-09-29-formal.md) | The v0.2 formal review |
| [`docs/reviews/response-2026-09-29-formal.md`](docs/reviews/response-2026-09-29-formal.md) | The response to the formal review, and what changed in v0.3 |
| [`docs/reviews/review-2026-09-29-functional.md`](docs/reviews/review-2026-09-29-functional.md), [`response`](docs/reviews/response-2026-09-29-functional.md) | The v0.3 functional-programming review and its response (v0.4) |
| [`docs/reviews/review-2026-09-29-actors.md`](docs/reviews/review-2026-09-29-actors.md), [`response`](docs/reviews/response-2026-09-29-actors.md) | The v0.4 actor-model review and its response (v0.5) |
| [`docs/reviews/review-2026-09-29-final.md`](docs/reviews/review-2026-09-29-final.md), [`response`](docs/reviews/response-2026-09-29-final.md) | The final formal review of v0.5 and its response (v0.6) |
| [`docs/reviews/evidence/`](docs/reviews/evidence/) | Independent explorations of every example model; the first acceptance tests of poly-ref |
| [`docs/research/landscape-2026-09.md`](docs/research/landscape-2026-09.md) | The current landscape: model-checkable languages, verification languages, languages for agents, durable runtimes, agent governance, and evidence on how coding agents fail |

## Principles

0. **The semantics is the definition.** 04-semantics says what a program means; every `poly check` validates the lowering against it.
0a. **One program, three interpreters.** The same machine is checked (all inputs), simulated (sampled inputs, v2) and run (real inputs). Only the environment changes.
0b. **Machines talk only by messages.** Addresses are values, `send` is the only way to affect a peer, and interacting machines are checked together as configurations.
1. **The engines check single machines; poly checks how machines relate.** Safety, governance, simulation and mining stay in the engines. poly's own model checker, poly-ref, checks the lowering, deadlock, liveness and configurations.
2. **The checked program is the running program, over its check domains.** A certificate binds the source, the artefacts and the check results by digest. Out-of-domain inputs are rejected (`strict`) or journaled as drift (`disclosed`).

   **Domains refuse by default (S400, PT3.4a).** A check domain on an action's parameter is a constraint: an integer range, an enum, a `bool` or a `check { … }` clause refuses a value outside it at dispatch, with the reason `outside-check-domain`, before the handler runs. Write `disclosed` after a `check` clause (`amount: int check { 1, 2 } disclosed`) to accept values outside the domain and only report them; such a value is then outside what was checked.
3. **One source per machine.** Every engine artefact is derived.
4. **No silent clean.** Every check reports clean, findings, refused, underpowered or inconclusive.
5. **No model call on a check or decision path.**
6. **The journal is the corpus.** Runtime journals feed replay, versioning, mining and simulation unchanged.

## Conclusion

The Poly stack already holds the primitives a coding agent needs to write stateful code that holds. poly makes them one language. The first milestone is a lowering that reproduces the field-study results from poly source. The third is an experiment, run before any runtime is built, that measures escaped defects and cost against the host language alone. The runtime work depends on its result.

## Glossary

| Term | Meaning |
|---|---|
| **SAM** | State-Action-Model. The pattern every poly machine lowers to, in its v2 strict profile. |
| **Machine** | A sealed state, a set of actions and one handler per action. The unit of checking and of execution. |
| **Handler** | `on Action { … }`. Requires first, then writes. It either accepts or rejects with a named reason. |
| **Check domain** | The finite set of values a field or parameter takes during checking. Narrower than the runtime type when declared so, and strict unless written disclosed (S400). |
| **Invariant** | A predicate on states that holds in every reachable state. |
| **Step property** | A predicate on every accepted step `(pre, action, data, post)`. |
| **Reject property** | A predicate on every step, whatever its verdict. |
| **Path property** | A prefix-closed predicate on the effects emitted along a path, such as `count(k) <= 1`. |
| **Liveness** | A property that something eventually happens, stated with the weak-fairness assumption it needs; its counterexample is a lasso. |
| **Deadlock** | A reachable non-terminal state in which no action is accepted. Checked for every machine. |
| **Checked instance** | The finite set of inputs and states a verdict covers. Every verdict is printed with it. |
| **poly-ref** | poly's model checker: a reference interpreter written from 04-semantics, used for translation validation, deadlock, liveness, configurations and obligation consistency. |
| **Possibility property** | A property that a good path exists (such as a mandate being dischargeable), as opposed to a property of all behaviours. |
| **Trust scope** | The governance scope an instance belongs to. Messages that cross a trust scope pass the gate. |
| **Tagged union** | A type whose values are one of several constructors, each with its own payload. Makes invalid states unrepresentable. |
| **Tri** | The three-valued truth type of policy expressions (true, false, unknown). Machine expressions are `Bool`. |
| **Capability** | An object passed to a handler that grants exactly the authority its effect's labels and targets declare. |
| **Interpretation** | One of three ways to feed the same machine: check (all inputs), simulate (sampled inputs) or run (real inputs). |
| **Embedded surface** | poly written as valid TypeScript with the `poly/embed` combinators; it produces the same AST as the standalone syntax. |
| **Ref** | The address of an instance (`Ref<M>`). It can be stored and passed in messages, but not dereferenced. |
| **Configuration** | A finite set of instances checked together, with messages in transit delivered in any order within a declared bound. |
| **Attached / detached child** | An attached child shares its parent's atomic cascade and kernel shard. A detached child is a separate actor that communicates by messages. |
| **Delivery guarantee** | Every message sent is eventually received: part of the semantics, implemented by the runtime (obligation R1). |
| **Dischargeable** | A mandate is dischargeable when some path reaches its discharge state without a deny under all obligations together. |
| **Kernel assumption** | A property of the runtime (K1 to K8) that a guarantee about running programs depends on. |
| **Witness** | The shortest concrete sequence that violates an invariant or reaches a forbidden region. It can be exported as a trace and as a test. |
| **Effect** | A declared side effect emitted by an accepted step. It carries labels and a class, and passes the gate before it runs. |
| **Label** | A term from a closed vocabulary (for example `egress:external`) that describes what an effect touches. |
| **Obligation** | A rule, machine, invariant or recalled text inside a `policy`, enforced by the Polyaxion gate. |
| **Effect gate** | The Polyaxion guarded merge that decides allow, deny or escalate before an effect or tool call executes. Distinct from the polycheck runtime guard and the polygents gate. |
| **Strict / disclosed** | The two modes of a check domain. `strict` rejects out-of-domain input at dispatch; `disclosed` accepts it and journals it as drift. |
| **Admission** | Passing the check pipeline. Only admitted programs load. |
| **Certificate** | The signed record of what was checked: source digest, artefact digests, check results, domains, stages not run and accepted exceptions. |
| **Ledger** | The signed record of steps, proposals, verdicts, effects, observations and advice, hash-chained per run. |
| **Anchor** | A signed Merkle root over the heads of all runs, published periodically, proving no run was dropped from a period. |
| **Work order** | An effect of a workflow machine, handed to an agent or a person to claim, run and report. |
| **World** | A set of machines, responders and drivers that Polytrion runs against a virtual clock. Deferred to v2. |
| **Lowering** | Compiling a poly construct into the artefact an existing engine reads. |
| **Cache key** | The SHA-256 of everything a machine's or a configuration's check result depends on: the toolchain's bytes, the lowered artefacts, the machine or configuration in full, the rest of the program, the options. Equal keys read the stored result back (PT14a). |
| **Goal** | A predicate on a configuration's global states, written like an invariant and expected to fail: a path the configuration is meant to cover (a witness goal). Reached, or `PL5410 GOAL_UNREACHED` (PS13.10). |
| **Defect patch** | The find-and-replace edits that seed one fault into a program, with the finding the check must then report. `--defects` applies each in memory and says whether it is found (PT14a). |
