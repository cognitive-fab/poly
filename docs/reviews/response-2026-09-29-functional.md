# Response to the functional-programming review of draft v0.3

*Cognitive Fab · September 2026 · answers [`review-2026-09-29-functional.md`](review-2026-09-29-functional.md) · produces draft v0.4*

Every requested change was made. The table gives the change and where it lives.

| # | Review item | Change in v0.4 | Where |
|---|---|---|---|
| 1 | One program, three interpreters | The environment is an explicit interface (`offer`, `complete`) with three interpretations: **check** (all inputs, nondeterminism), **simulate** (sampled inputs, probability; v2) and **run** (real inputs, IO). "The checked program is the running program" is now a theorem with a proof sketch. It covers every run path whose inputs lie in the check domains, which `strict` mode guarantees. A Polytrion world is a definition of **simulate**. | 04 PS4.1a to PS4.1c; 02 PA0.0a; 01 G6a; README principle 0a |
| 2 | The state wants to be a sum type | Tagged unions with payloads, exhaustive `match` (`PL1501`), constructor tests with `is`, whole-value writes, and flattening to the SAM sealed shape with an automatic `shape:` invariant. Translation validation compares through the abstraction function. `OutboxIntent` is rewritten: one union field replaces five, and 17 representable states (all reachable) replace 432 combinations (33 reachable). Three invariants and one step property became types. | 04 PS1.4, PS1.5, PS2.2, PS9.1b; 03 PT2, PT2.4, PT3.1, PT9.7; 01 PF1.6 |
| 3 | Labels are claims, not effects | Effects declare targets beside labels. Handlers receive only the capabilities those grant (`egress`, `store`, `secrets`, `exec`), and a lint refuses ambient authority in handler modules (`PL6401`). An opt-in isolation mode runs each effect kind's handlers in an OpenShell sandbox whose policy is generated from the labels and targets, so a wrong label fails closed. The spec states that the lint is a discipline and the sandbox is the enforcement. | 03 PT6.5, PT15; 02 §7.2, AD-11; 01 PF3.4 |
| 4 | Separate the logics by type, not syntax | `Tri` is `Bool` lifted into an option type with Kleene's rules. Policy inputs are optional, so policy expressions have type `Tri`; machine expressions are `Bool`. One operator set serves both, and a `Tri` where a `Bool` is expected is a type error (`PL1203`). The `is` / `is not` policy operators are gone; `is` is now the constructor test. `.policy.poly` stays only as a reading convention. | 04 PS8.0, PS12; 03 PT1.1a, PT2.3, PT8.1; 01 PF4.2 |
| 5 | Try the embedded language before the new one | poly gains an embedded TypeScript surface (`poly-embed`) over a shared core (`poly-core`). It produces the same AST, checks and lowering, and it is built to M2. The experiment gains a fourth arm. A pre-registered rule makes the embedded surface primary if it is not worse on escaped defects and uses fewer tokens, which would take the parser, formatter and language server out of v1. | 03 PT2.5, PT13, PT17, PT18; 02 §2a, AD-10; 01 PF9.4a, §8 |
| 6a | Replay is a fold | A run's state is `foldl δ init journal`, and the replay theorem follows from `δ` being a function. A snapshot that disagrees with the fold is a kernel fault. | 04 PS11.4 |
| 6b | Rx duality | The host API exposes `rt.inputs(id)` and `rt.intents(kind)` as streams for observation. Handlers remain the only way to execute an effect. | 03 PT15 |
| 6c | Hello, world is missing | The README opens with a complete turnstile, the `poly check` output, the one-action fix and three lines of host code. | README |
| 6d | Liveness is a game | Stated: the environment is an adversary constrained by fairness, and the lasso is its winning strategy. | 04 PS6.3a |

## Evidence

Both new examples were checked with short, independent explorations written from 04-semantics:

- **The union-typed `OutboxIntent`** ([`evidence/outbox_sum_check.py`](evidence/outbox_sum_check.py)): 17 reachable states out of 17 representable, 24 accepted transitions, no deadlock, and no fair cycle outside the terminal states.
- **The hello-world turnstile** ([`evidence/turnstile_check.py`](evidence/turnstile_check.py)): 7 reachable states and a deadlock at `Locked/3` with the witness `Coin, Coin, Coin, Push`. With `Empty` added, it has no deadlock and the invariant still holds.

## Conclusion

v0.4 lets the core shape the design. The same step function is checked, simulated and run, and the claim that joins checking to running is now proved rather than asserted. Invalid states are unrepresentable instead of guarded against. Handlers can do only what their labels declare. The two logics are kept apart by the type checker. Whether agents write poly as a new syntax or as TypeScript is now a question the first experiment answers, with the decision rule fixed in advance.
