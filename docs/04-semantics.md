# poly · Semantics

*Cognitive Fab · September 2026 · draft v0.3 · specification only, no code*

This document defines what a poly program means. The functional (`PF`), architecture (`PA`) and technical (`PT`) specifications defer to it. Where they disagree with it, this document is right and they are wrong. Requirement ids here are `PS`.

The definitions are mathematical and short. They are written so that a reference interpreter can be built directly from them, with no code shared with the compiler (PS9).

## PS1. Machines and states

- **PS1.1** A machine `M` is a tuple `(F, init, A, H, G, term)`:
  - `F` is a finite, ordered set of fields. Each field `f` has a type `T(f)` and a check domain `D(f) ⊆ T(f)`. The first field is the **control field**.
  - `init` is the initial state.
  - `A` is a finite set of actions. Each action `a` has a parameter record type `T(a)` and a check domain `D(a) ⊆ T(a)`, the product of its parameters' check domains.
  - `H` maps each handled action to its handler.
  - `G` is the ordered list of guards (`guard all when … reject …`).
  - `term` is the terminal predicate.
- **PS1.2** A **state** is a function `s` from `F` to values with `s(f) ∈ T(f)` for every field. `S` is the set of states. The state contains the declared fields and nothing else: no verdict, no pending effects, no timers.
- **PS1.3** `term(s)` depends only on `s(control field)` (PT4.4a).

## PS2. Handlers denote functions

- **PS2.1** A handler for action `a` denotes a function

  ```
  h_a : S × T(a) → Verdict
  Verdict = accept(w, E) | reject(r)
  ```

  where:
  - `w` is a partial function from fields to values: the writes;
  - `E` is a finite sequence of effect intents (effects, timer sets and cancels, spawns, signals), in statement order;
  - `r` is a reason, a string literal from the handler's text.
- **PS2.2** A handler body is evaluated against the pre-state `s` and the data `d` as follows:
  1. **Guards.** The guards in `G` are evaluated in declaration order. The first guard whose condition holds yields `reject(r)` with its reason.
  2. **Body.** Statements are evaluated in order:
     - `require c else reject r` yields `reject(r)` if `c` is false and continues otherwise;
     - `let x = e` binds `x`;
     - `if c B1 else B2` evaluates the chosen branch;
     - `f' = e` adds `f ↦ value(e)` to `w`;
     - `f' = f with [k] = v` adds `f ↦ s(f)[k := v]` to `w`;
     - `emit`, `after`, `cancel`, `spawn` and `signal` append an intent to `E`.
  3. **End.** If the body completes without a rejection, the result is `accept(w, E)`.
- **PS2.3** **Expressions read the pre-state only.** A primed field is write-only. Reading `f'` is a syntax error. So the order of assignments within a handler does not change the result.
- **PS2.4** A field written twice on one control path is `PL2102 DOUBLE_WRITE`. Therefore `w` is well defined.
- **PS2.5** All expressions are total (PT2.2), so `h_a` is a total function. **A machine is deterministic in its inputs**: for each state and each input there is exactly one verdict.

## PS3. Steps and the transition relation

- **PS3.1** A **label** is a triple `(a, d, v)` of an action, its data and a verdict kind:
  - `v = accepted(E)`;
  - `v = rejected(r)`;
  - `v = unhandled`.
- **PS3.2** The transition relation `R_M ⊆ S × Label × S` contains exactly these triples `(s, (a, d, v), s')`, for every `s ∈ S`, `a ∈ A` and `d ∈ T(a)`:

  | Condition | Verdict `v` | Next state `s'` |
  |---|---|---|
  | `term(s)` | `rejected("terminal")` | `s` |
  | `d` violates a `strict` check domain of `a` (PT3.4) | `rejected("outside-check-domain")` | `s` |
  | `a ∉ dom(H)` | `unhandled` | `s` |
  | `h_a(s, d) = reject(r)` | `rejected(r)` | `s` |
  | `h_a(s, d) = accept(w, E)` | `accepted(E)` | `s ⊕ w` |

  `(s ⊕ w)(f) = w(f)` if `f ∈ dom(w)`, and `s(f)` otherwise. This is the **frame**: every field not written is unchanged.
- **PS3.3** **Rejected and unhandled steps are steps.** They are transitions whose next state equals their current state, and they carry their verdict in the label, not in the state. They are journaled, they appear in traces, and properties over labels see them (PS5). Properties over states cannot distinguish them from not taking a step at all. This is the answer to the question "is a rejected step a step?": it is a labelled stuttering step.
- **PS3.4** An accepted step may leave the state unchanged (for example `Pay` in PT4.5, which only emits). It is still accepted, and its label carries its effects.

## PS4. Behaviours and the checked instance

- **PS4.1** The **environment** chooses each action and its data. A **path** is a finite sequence `s0 l0 s1 l1 … sn` with `s0 = init` and `(si, li, si+1) ∈ R_M` for every `i`. A **behaviour** is an infinite such sequence. The environment is unconstrained: every action, with every data value, may be offered in every state.
- **PS4.2** The **checked instance** `I` is the restriction to inputs in the check domains: every `d ∈ D(a)`. `Reach(I)` is the set of states on paths of `I`. It is finite, because every field type in a checked machine is finite or restricted to a finite check domain (PT3.2).
- **PS4.3** **Every verdict is about `I`.** A `CLEAN` result states that a property holds on `Reach(I)` and on all paths of `I`. The instance is printed with the verdict (PT12.3a).
- **PS4.4** **Completion actions are ordinary actions.** In `I`, a completion such as `PaymentOk` can be offered in any state, whether or not a charge was emitted. So `I` over-approximates the real system: every real behaviour is a behaviour of `I`, but not every behaviour of `I` is real. For safety properties this is sound: a clean result holds for the real system. A witness may be infeasible if it uses a completion with no matching intent. Such a witness is marked `environment: unconstrained`, and the matching path property check (PS5.4) is the place to rule it out.

## PS5. Properties

There are five kinds of property. Each has its own keyword (PT5), and none is called an invariant unless it is one.

- **PS5.1** An **invariant** is a predicate `P` on states. `M ⊨ invariant P` iff `P(s)` holds for every `s ∈ Reach(I)`. The automatic `domain:<field>` properties (PT3.5) are invariants.
- **PS5.2** A **step property** is a predicate `Q(s, a, d, s')`. It holds iff `Q` holds for every **accepted** transition from a state in `Reach(I)`.
- **PS5.3** A **reject property** is a predicate `J(s, a, d, v)`. It holds iff `J` holds for **every** transition from a state in `Reach(I)`, whatever its verdict. `rejected(r)` in `J` is true iff `v = rejected(r)`.
- **PS5.4** A **path property** is a predicate `Φ(π)` on finite paths. It is evaluated through `emitted(π)`, the concatenation of the intent sequences of the accepted labels of `π`, and `actions(π)`, the sequence of actions. It holds iff `Φ(π)` holds for every path `π` of `I`. Path properties must be **prefix-closed**: if `Φ` holds of a path, it holds of every prefix. The compiler accepts only forms that are prefix-closed by construction (`count(k) <= n`, `before(a, b)`, and their conjunctions). So a path property is a safety property and has a finite witness.
- **PS5.5** A **liveness property** has one of two forms:
  - `eventually P`: every fair behaviour of `I` reaches a state satisfying `P`;
  - `P leads to Q`: in every fair behaviour, every state satisfying `P` is followed by a state satisfying `Q`.

  Fairness is defined in PS6. A liveness property is not a safety property and has no finite witness. Its counterexample is a **lasso**: a path to a cycle that can repeat forever.
- **PS5.6** **Deadlock.** A state `s ∈ Reach(I)` is a **deadlock** iff `¬term(s)` and no action accepts in `s`: for every `a` and every `d ∈ D(a)`, the verdict is not `accepted`. Deadlock freedom is checked for every machine, whether or not it declares a liveness property (`PL3201 DEADLOCK`, with the path to the state).

## PS6. Fairness

- **PS6.1** An action group `g` is a set of actions (written `A | B`). `g` is **enabled** in `s` iff some `a ∈ g` and some `d ∈ D(a)` give an accepted transition from `s`.
- **PS6.2** A behaviour is **weakly fair for `g`**, written `WF(g)`, iff `g` is not enabled continuously from some point on without an accepted step of `g` being taken infinitely often. In words: an action group that stays enabled is eventually taken.
- **PS6.3** A liveness property is always stated with its fairness assumption: `liveness n: eventually P under fair { g1, g2, … }`. It is checked only over behaviours that are weakly fair for every listed group. Actions not listed carry no assumption: the environment may never offer them. A person's approval, for example, is not listed.
- **PS6.4** **Check.** Over the finite graph of `Reach(I)`, `eventually P` fails iff there is a reachable strongly connected component `C` with all of the following properties:
  1. `C` contains no `P`-state.
  2. `C` contains at least one edge, where rejected and unhandled steps count as edges.
  3. For every listed group `g`, either some edge of `C` is an accepted step of `g`, or `g` is disabled in some state of `C`.

  This is the standard component test for weak fairness on a finite graph. `P leads to Q` is checked by the same test on the graph restricted to the part after a `P`-state, until `Q`. The counterexample is the path to `C` followed by a cycle through `C` that visits every edge the third condition names.

## PS7. Composition

- **PS7.1** A parent machine `P` with children forms a **joint machine**. Its state is `(s_P, {k ↦ s_k})`, over the children spawned so far. The joint label is the **stimulus**: `(target, a, d)`, where the target is the parent or a child key.
- **PS7.2** A joint step is the **cascade** of a stimulus: the stimulus's own transition, followed by every transition it causes, applied in order. These are completions to the parent, parent-terminal actions to children and signals, up to depth 8. The joint step is accepted iff the stimulus transition is accepted. A cascade that exceeds depth 8 is `PL5201 CASCADE_DEPTH`.
- **PS7.3** A **compose invariant** is an invariant (PS5.1) of the joint machine.
- **PS7.4** The joint semantics is a model of the runtime only under kernel assumptions K1 to K3 (PS10). Every composition guarantee cites them.

## PS8. Policies

- **PS8.1** Policy expressions take values in `{T, F, U}`, where `U` is unknown.
  - `not`, `and` and `or` follow Kleene's strong three-valued logic: `not U = U`; `F and U = F`; `T and U = U`; `T or U = T`; `F or U = U`.
  - A comparison with an unknown operand is `U`.
  - `unknown(x)` is `T` or `F`, never `U`.
- **PS8.2** A `rule` obligation `when W require Q else s on unknown u` is evaluated for a proposal as follows. The severity `s` is `deny`, `warn` or `escalate`. The unknown handling `u` is `escalate`, `deny` or `skip`.

  | `W` | `Q` | Outcome |
  |---|---|---|
  | `F` | any | not applicable |
  | `T` | `T` | satisfied |
  | `T` | `F` or `U` | `s` (an unknown value never satisfies a requirement) |
  | `U` | any | `u` |

  **The default for `u`:**
  - For `s = deny`, the default is `escalate`. A deny rule whose condition cannot be evaluated never passes silently.
  - For `s = warn`, the default is `warn`.
  - `skip` must be written explicitly. It is listed in the certificate under `skippedOnUnknown`.
- **PS8.3** **Combination.** The gate's decision for a proposal is:
  - `deny` if any obligation's outcome is `deny`;
  - otherwise `escalate` if any outcome is `escalate`;
  - otherwise `allow`.

  Warnings are recorded with an `allow`.
- **PS8.4** **Labels.** In a scope where any obligation mentions `effects`, `labels` or `class`, an effect or tool with no labels is **refused at admission** (`PL6302 UNLABELLED_IN_LABELLED_SCOPE`, verdict `REFUSED`). An unlabelled effect cannot make a label-based rule's `when` unknown at runtime.
- **PS8.5** `machine("<module>.<Machine>").f` is the value of `f` in the post-state of the step that emitted the effect under decision (PT9.3). It is `U` for a proposal that is not an effect of that machine.

## PS9. Lowering correctness

- **PS9.1** Let `L(M)` be the lowered module. Let `R_L` be its transition relation under the SAM v2 strict profile. For each `(s, a, d)`:
  - an acceptor rejecting with `r` gives `rejected(r)`;
  - writes to `next`, with the declared `unchanged`, give the next state;
  - the effects mapper applied to the step gives `E`.
- **PS9.1a** The first two rows of the table in PS3.2 (terminal states and strict check domains) are applied by the runtime before it calls the module. `R_L` is therefore the module's relation with those two rules applied first, exactly as the runtime applies them.
- **PS9.2** **The lowering is correct for `M` on `I`** iff `R_L` and `R_M` agree on every `(s, a, d)` with `s ∈ Reach(I)` and `d ∈ D(a)`. They must give the same verdict kind, the same reason, the same next state and the same intent sequence. The lowered property modules must also agree with PS5 on every reachable state and transition.
- **PS9.3** **Translation validation on every check.** `poly check` runs a reference interpreter, `poly-ref`, written directly from this document and sharing no code with the compiler. It explores `I` and compares every transition with the lowered module's. A difference is `PL2501 LOWERING_MISMATCH`. The verdict is `REFUSED`, and the diagnostic is addressed to the toolchain, not to the author. This makes the lowering's correctness a checked fact for each program, not a claim about the compiler.

## PS10. Kernel assumptions

The guarantees about running programs hold under these assumptions about the runtime. Each guarantee in PT and 02 cites the assumptions it uses. Each assumption names its evidence.

| Id | Assumption | Evidence |
|---|---|---|
| K1 | **Atomic step.** Snapshot, journal entry, outbox, timers and dedupe key commit in one transaction. | polyrun specification FR on dispatch; polyrun store tests |
| K2 | **Single writer.** At most one step per instance is in flight. | polyrun specification; composition semantics document |
| K3 | **Atomic cascade**, depth at most 8. | polyrun composition semantics |
| K4 | **Idempotent dispatch.** A repeated `actionId` returns the recorded result and takes no step. | polyrun dedupe table (`UNIQUE(instance_id, action_id)`) |
| K5 | **Worker and timer fairness.** While the runtime is up, every pending outbox intent is eventually taken by a worker, and every due timer eventually fires. | none yet; stated as an operational requirement and monitored (queue age alarms) |
| K6 | **Gate function.** The gate's decision is a function of the policy digest, the session state Σ, the emitting-step snapshot and the proposal. | Polyaxion's replay check; to be stated as an engine requirement |
| K7 | **Profile fidelity.** The SAM v2 strict runtime executes a lowered module as PS9.1 describes. | sam-lib strict-profile tests; PS9.3 checks the rest per program |

## PS11. The gate and replay

- **PS11.1** Each gate session has a **session sequence** `sseq`. The gate assigns it on receipt of every proposal and every settle. Each ledger event carries its `sseq` and the digest of Σ before the event.
- **PS11.2** **Replay of a session** re-applies its events in `sseq` order. It must reproduce every decision and every Σ digest. By K6, this reproduces the gate's behaviour exactly.
- **PS11.3** **Replay of a run** reproduces every post-state from the run's own chain (K1, PS2.5). It reproduces gate decisions when the sessions the run touched are replayed with it.

## PS12. Expression syntax: precedence

From tightest to loosest binding:

| Level | Operators | Associativity |
|---|---|---|
| 1 | field access, indexing `m[k]`, calls `count(…)`, `before(…)` | left |
| 2 | `!` `-` (unary) | right |
| 3 | `*` `/` `%` | left |
| 4 | `+` `-` | left |
| 5 | `<` `<=` `>` `>=` `in` | none |
| 6 | `==` `!=` | none |
| 7 | `&&` | left |
| 8 | `\|\|` | left |
| 9 | `implies` | right |

The canonical formatter inserts parentheses whenever `implies` is mixed with `&&` or `||` in one expression. So `executed implies (decisions <= 1 || approved)` is the only printed form of that invariant, and neither the author nor a reader has to remember level 9. Policy operators (`is`, `is not`, `and`, `or`, `not`) follow levels 6, 7, 8 and 2 respectively.

## Conclusion

A poly program denotes a deterministic, labelled transition relation over a finite checked instance. Rejections are labelled stuttering steps. Properties come in five kinds with distinct meanings. Liveness is stated only with its fairness assumptions. Policies have a total three-valued evaluation in which an unknown deny condition escalates. The lowering is correct when its transition relation equals this one, and every `poly check` verifies that for the program at hand. Every guarantee about a running program names the kernel assumptions it depends on.
