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

> Status: specification, draft v0.2 (after review). No code yet.

## A first look

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
  emits invariant charge-at-most-once: count("payment.charge") <= 1

  effect charge(amount: int) {
    kind "payment.charge"
    labels { egress:external }
    class irreversible
    ok -> PaymentOk()
    failed -> PaymentFailed(code: "declined")
  }
}
```

`poly check` finds that two `Pay` calls emit two charges:

```
orders.poly:17  PL4001 EMISSION_INVARIANT  charge-at-most-once
  witness (4 steps):
    AddItem()      Draft/0  -> Draft/1
    Place()        Draft/1  -> Placed/1
    Pay(10)        Placed/1 -> Placed/1   emits payment.charge
    Pay(10)        Placed/1 -> Placed/1   emits payment.charge   <- count = 2
  test:  poly witness sha256:3be1… --test   (fails on this program)
  fixes: [enter-charging-status]  add status Charging, entered by Pay, left by PaymentOk / PaymentFailed
verdict: FINDINGS (exit 1)
```

Each call is allowed; the sequence is not. That is the bug the Poly stack was built to find, reported before the program can run. The snippet is abridged; the full example is in the technical specification, PT4.5.



## Documents

| Document | What it covers |
|---|---|
| [`docs/01-functional-spec.md`](docs/01-functional-spec.md) | The problem, users, goals, non-goals, functional requirements (`PF`), acceptance criteria and risks |
| [`docs/02-architecture.md`](docs/02-architecture.md) | Layers, the lowering map, the check pipeline, the certificate, the runtime and the gate, one ledger, the agent interface and architectural decisions (`PA`, `AD`) |
| [`docs/03-technical-spec.md`](docs/03-technical-spec.md) | Grammar, types and domains, step semantics, invariants, effects, policies, the gate integration, diagnostics, commands, host API, ledger, layout, implementation plan and the first experiment (`PT`) |
| [`docs/research/primitive-inventory.md`](docs/research/primitive-inventory.md) | The design-time and runtime primitives of every engine, read from source |
| [`docs/reviews/review-2026-09-29-blunt.md`](docs/reviews/review-2026-09-29-blunt.md) | The v0.1 peer review |
| [`docs/reviews/response-2026-09-29.md`](docs/reviews/response-2026-09-29.md) | The response to the review, item by item, and what changed in v0.2 |
| [`docs/research/landscape-2026-09.md`](docs/research/landscape-2026-09.md) | The current landscape: model-checkable languages, verification languages, languages for agents, durable runtimes, agent governance, and evidence on how coding agents fail |

## Principles

1. **Lower, never reimplement.** poly has no checker, gate, simulator or miner of its own.
2. **The checked program is the running program, over its check domains.** A certificate binds the source, the artefacts and the check results by digest. Out-of-domain inputs are rejected (`strict`) or journaled as drift (`disclosed`).
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
| **Check domain** | The finite set of values a field or parameter takes during checking. Narrower than the runtime type when declared so, and then disclosed. |
| **Invariant** | A predicate that must hold: over states, steps, rejections, emissions or a parent with its children. |
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
