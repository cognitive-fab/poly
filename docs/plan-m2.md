# poly · Plan for milestone M2

*Cognitive Fab · September 2026 · plan, written before any M2 feature code*

This plan covers milestone M2 of PT18, as amended at M1's close (748cd08) and in `handoff-m2.md`: liveness, diagnostics with fixes and witness tests, the embedded surface, the handler lint, detached children, typed decisions (PD1), and a faster test suite. It fixes the packages touched, the order of work, how each gate item is tested, the seeded defect set of AC3, and the spec issues found while reading, which continue at S68. Nothing beyond M2 is built; PD2 to PD4 are not built toward.

## 1. What was read, and what was measured before planning

The documents were read in the order of the handoff: `CLAUDE.md`, the last two sections of `decisions-m1.md`, the model-decisions proposal v0.2 with its review and response, PS6, PS13.2b, PS14.2, PS1.6 and PS13.3 with S57 and S60, PT2.5, PT6.5, PT12.1 to PT12.4, PT14 and PT18's M2 row, and the M1 closing summary (its PD1 list is the plan input for step 9 below). The engines were read where M2 touches them: polyrun's `createRuntime`, its `Workers.tickEffects` and `mapCompletion` (`workers.mjs`), which already resolve `map` paths over `{ result, error }`.

The liveness evidence, run before planning:

| Script | Result |
|---|---|
| `delivery_check.py` | in-order worker, dedupe kept: 1,147 states, 0 fair non-terminal components; parallel worker, dedupe kept: 2,368 states, 0 |
| `outbox_check.py` (v0.3) | 33 states, 40 accepted steps, no deadlock, no fair non-terminal component |
| `outbox_check.py v0.2` | 35 states, deadlocks at `(Allowed, 3, 1, T, F)` and `(Allowed, 3, 2, T, T)`, and one fair component at each |
| `outbox_sum_check.py` (union form) | 17 states, 24 edges, no deadlock, no liveness violation |

The checkout configuration's `settle` has no independent script (S77).

The first commit of M2 (0e1325d) adds the standing rule "every artefact the runtime reads is checked" to `CLAUDE.md`, with what enforces it: poly-ref's read-back of `contract.json`, `effects.manifest.json`, `effect-invariants.mjs` and `invariants.compose.mjs` inside translation validation, and six broken variants of those artefacts in the explicit fault list, each caught.

## 2. Engine changes

None is needed on M2's path.

- **Typed decisions** use polyrun as it is: a decision is an effect of kind `decision.<name>`, and its completion maps the handler's result with `map` paths, which `mapCompletion` already resolves.
- **Detached spawns and sends** need polyrun's `createInstance` and `sendTo`, both on the owner's list. Until they exist, a module that uses either does not run under polyrun, and stages 3 and 4 of such a module are poly-ref's alone and say so (S58, S60). Their configuration checks come from the semantics, as in M1.

## 3. Packages and what changes in each

| Package | M2 additions |
|---|---|
| `poly-core` | AST for `decision`, `decide`, `ok(r)` bindings, decimal literals, `Conf`, `Tri` in machines, liveness quantifiers already exist; the checker for PD1 (`PL1205`, `PL6202`, completion typing, strict-by-default decision completions), detached spawns (S60), structured completion constants (S67); fixes: the catalogue of typed edits and their preconditions; codes `PL0201`, `PL0301`, `PL1205`, `PL3301`, `PL5302` in use, `PL6201`, `PL6202`, `PL6401` |
| `poly-lang` | Grammar and formatter for the PD1 constructs and `spawn detached`; `applyFix` (edit a node, check its digest, reprint) |
| `poly-embed` (new, compiler side) | The embedded TypeScript surface (PT2.5): reads a `.ts` module with the TypeScript compiler API, accepts the PT2.2 subset inside handler and property bodies (`PL0301` otherwise), produces the same AST; ships the combinators' type declarations so the source type-checks with `tsc` |
| `poly-lower` | Decisions as effects of kind `decision.<name>` with `$.result.*` completion maps, and `ok(r)` maps for ordinary effects; the strict range check for `Conf` at dispatch; detached spawns (`createInstance` intent, per S60 and S78); liveness predicates for witness tests (S74) |
| `poly-ref` | Liveness (PS6.4): the component test for `eventually` and `leads to` under weak fairness with `A(*)` groups, in machines and in configurations (delivery fair per value, PS13.2b), with lasso witnesses; the `Conf` interval partition (PD1.4b); `PL6201` by the decision's completion step and its cascade; detached spawns in configurations (fresh addresses, group `M`, `PL5302`); read-back of every new artefact |
| `poly-check` | Liveness stops being listed as not run; `.poly/report.json`; `poly witness <id> --trace/--test`; `poly fix <id>`; `poly lint handlers` (`PL6401`); project mode reads embedded `.ts` modules; the recorded provider adapter for tests only, outside every check path |

The import boundary gains `poly-embed` on the compiler side: poly-ref may not import it, and the boundary check says so. The recorded provider adapter lives under `test/`, and the boundary check refuses any import of it from `packages/`.

## 4. Order of work

Each step ends with a commit; every defect found gets a regression test that fails first.

1. **S67 and the test suite.** Structured constants in completion data (S67, ruled). Then each deliberately broken lowering runs over the smallest sources that exercise its construct, listed beside it in `test/toolchain-faults.mjs`, with one full sweep over every source kept in `npm test`.
2. **Liveness in machines** (PS6): the SCC test of PS6.4 over the graph poly-ref already builds, `A(*)` groups, `leads to` by restriction to the pending part, `PL3301 LIVENESS_LASSO` with a lasso witness (S74). First targets: the outbox and delivery evidence.
3. **Liveness in configurations**: the S56 form, delivery fair per message value (PS13.2b, PS14.2), inputs fair only where named (S73). Target: the checkout `settle`.
4. **Witnesses and fixes** (PT12.1 to PT12.4): witness ids, `.poly/report.json` (S69), `poly witness --trace/--test` (S68), the fix catalogue (S70), `poly fix` with `PL0201 STALE_FIX`. Then the seeded defect set of section 6, and the random-order fix test.
5. **`spawn detached`** (S60, S78): checker, lowering, poly-ref alone, and configurations with `instances n` and `PL5302`.
6. **The embedded surface** (PT2.5, S71): `poly-embed`, the combinator declarations, `PL0301`, and the corpus written in both surfaces.
7. **The handler lint** (PT6.5, S72): `poly lint handlers`, `PL6401`.
8. **Typed decisions** (PD1, S75, S76, S79): syntax, types, the partition, `PL1205`, `PL6201`, `PL6202`, the lowering, the recorded provider, PD1-A1 to PD1-A4.
9. **Record**: measurements in this document, then stop for the code review.

## 5. How each gate item is tested

| Gate item | Test | Pass condition |
|---|---|---|
| AC3 | `test/witness.test.mjs`: for each seeded defect of section 6, `poly check` gives the diagnostic with a witness; `poly witness <id> --test` writes a host test; the test is run against the unfixed and the fixed source | fails on the unfixed program, passes on the fixed one, for every kind |
| Fixes | `test/fixes.test.mjs`: a source with at least ten fixable diagnostics; at least 100 random orders from a recorded seed; after each attempt the source reparses | each fix applies with its precondition true and changes only its target node, or is refused `PL0201`; never misapplied |
| Liveness evidence | `test/liveness.test.mjs`, comparing with the scripts when Python is present | `exactly-once` holds for the two Delivery variants that keep dedupe records; `settles` holds for v0.3 and the union form and fails for v0.2 with a fair cycle at each of its two deadlocked states; checkout `settle` holds for the waiting order |
| Embedded surface | `test/embed.test.mjs`: each source written in both surfaces | same AST digest (PT1.4) and same verdict; at least the turnstile, the orders example, and one machine with effects, timers and children; `tsc --noEmit` passes on the embedded sources |
| Typed decisions | `test/decisions.test.mjs` | PD1-A1 to PD1-A4 of the proposal, with a recorded provider; no model call |
| Standing rule | `test/tv.test.mjs` with the read-back, and the fault list | every artefact the runtime reads is compared; each new artefact has its broken variant, caught |
| No regressions | every M0 and M1 test, unchanged | every gate number of M0 and M1 unchanged |
| One command | `npm test` | exit 0 |

## 6. The seeded defect set (AC3)

One seeded defect per diagnostic kind that has a witness. Each is a pair: the unfixed source and the fixed one, kept in `conformance/m2/seeded/`.

| Kind | Code | Unfixed | Fixed |
|---|---|---|---|
| invariant | `PL3001` | a counter whose handler can pass its invariant's bound | a `require` that keeps it |
| step property | `PL3002` | a step that lowers a total a step property says never falls | the step refused |
| reject property | `PL3003` | an action refused with the wrong reason | the right reason |
| path property | `PL4001` | PT4.5's orders, `Pay` charging twice | the `Charging` status |
| deadlock | `PL3201` | the README turnstile | the turnstile with `Empty` |
| domain escape | `PL3102` | `items` can leave `0..3` | a `require` before the write |
| configuration invariant | `PL5401` | the optimistic checkout | the waiting checkout |
| stuck | `PL5402` | an inventory that never answers `Take` | one that answers |
| liveness | `PL3301` | `OutboxIntent` v0.2 | v0.3 |

`PL4002`, `PL5001` and `PL5404` also carry witnesses; their exported tests are built by the same code and tested once each, outside the gate's nine.

## 7. Spec issues

- **S68. What an exported witness test drives before the runtime API exists.** PT12.4 says the test "drives the runtime API through the witness sequence", and PT15's host runtime API arrives with `poly-runtime` in M4. *Proposal:* in M2 the exported test drives the lowered artefacts through the interface the engines use: the SAM module's actions (`next.cjs`), the effects mapper for path properties and `PL4002`, polyrun's in-memory kernel for attached children, and, for a configuration, a small harness in the test that delivers the witness's messages between the lowered instances (polyrun has no `sendTo`, S58). The test walks the witness; a step the program now rejects ends the walk, and the test passes; after each accepted step it asserts the violated predicate with the lowered property module. A liveness test drives the prefix and one turn of the cycle, and passes if a step is refused, if `P` (or `Q`) holds, or if a fair group is enabled throughout the cycle and never taken. When M4 brings PT15, the exporter targets it instead.
- **S69. Where witnesses and fixes live between `poly check` and `poly witness` or `poly fix`.** *Proposal:* `poly check` writes its JSON report to `.poly/report.json` under the root; `poly witness <id>` and `poly fix <id>` read it (or `--report <path>`). A witness id is `sha256:` of the canonical JSON of its trace, as PT12.1's example shows. A fix id is `<fix name>@<first 12 hex of pre>`, unique in a report; PT12.1's `add-require` is the name.
- **S70. The fix catalogue.** PT12.1 shows two examples. *Proposal:* M2 offers these typed edits, each addressed to a node with the digest of that node as its precondition: `PL3102` (`add-require` before the handler's first write, and `widen-range` to the escaped value), `PL1202` (read the pre-state field), `PL1504` (the binder becomes `_`), `PL1005` (qualify the constructor), `PL1501` (a `_ => reject "unmatched"` arm), `PL2101` (move the `require` before the first write). The edit operations are `replace-node`, `insert-before-first-write` and `move-before-first-write`. The file is reprinted by the canonical formatter, comments kept. Fixes apply to the standalone surface; on an embedded source `poly fix` refuses with a usage error until a TypeScript printer exists.
- **S71. The embedded surface's full mapping.** PT2.5 shows one machine; "the same AST" needs every node to have one embedded form, and `t.enum(...)` inline in a field would create an unnamed type the standalone AST cannot have. *Proposal:* named declarations are exported constants (`export const Status = t.enum('Status', 'Draft', …)`, `t.union`, `t.record`); statements are `require`, `reject`, `set`, `setEntry`, `when(c, then, else)`, `match(x, { C: (b) => … })`, `let_`, `emit`, `after`, `cancel`, `spawn`, `signal`, `send`, `forEach`; properties are `invariant`, `stepProperty`, `rejectProperty`, `pathProperty`, `composeInvariant`, `liveness`; configurations are `configuration(...)`. The appendix of this plan will carry the table once built. A project's `modules` globs may name `.ts` files, which `poly-embed` reads.
- **S72. Which files `poly lint handlers` reads.** PT1.2's manifest has no field for handler modules. *Proposal:* `handlers: ["handlers/**/*.ts"]` in `poly.json`. The lint reads each file with the TypeScript compiler API and reports `PL6401` at each import of `fs`, `net`, `http`, `https`, `tls`, `dgram`, `child_process`, `worker_threads` (with or without `node:`), each use of global `fetch`, `process.env`, a dynamic `import()` and `globalThis`. `poly check <dir>` runs it as a project stage when the field is present.
- **S73. Fairness names in a configuration.** S56 says an input is fair only if the clause names it, and `Fair = Ident [ "(*)" ]` names an action, which may exist in several machines of a configuration. *Proposal:* in a configuration, a fair member is an `InputRef` (`order[*].Place`, `inv.Query`), optionally followed by `(*)` for one group per data value.
- **S74. The lasso witness, and liveness predicates in the lowered artefacts.** PT12.1's witness has a trace only. *Proposal:* a liveness witness is the trace of the prefix followed by the cycle, and `witness.cycle` is the index where the cycle begins. The lowering writes each liveness property's `P` and `Q` as state predicates in `invariants.mjs` under `livenessPredicates`, so an exported test can evaluate them; the read-back compares them on every reachable state.
- **S75. `PL6201` "by reachability".** PD1.4d defines a gated decision by what "its completion step and the cascade after it" can reach. *Proposal:* that reading: for each answer and each confidence and margin interval, poly-ref takes the completion step from every reachable state that accepts it and, for a machine with attached children, its cascade (PS7.2); the decision is gated iff some such step emits no `compensable` or `irreversible` effect. Steps after the cascade are not counted.
- **S76. PD1's grammar.** The proposal gives examples, not productions. *Proposal:* `Decision = "decision" Ident "(" Params ")" "->" Type "{" { "provider" String | "labels" … | "timeout" Duration | "band" Decimal ".." Decimal | Outcome } "}"`; `Outcome = ( "ok" "(" Ident ")" | "ok" | "failed" | "exhausted" ) "->" Ident "(" [ Args ] ")"`; `Stmt |= "decide" Ident "(" [ Args ] ")"`; a decimal literal `0.8` has at most three digits after the point and is legal only as the constant a `Conf` is compared with (`PL1205` elsewhere); `Tri` in machines is the enum `True | False | Unknown`. A `Conf` completion parameter takes no check clause; its explored domain is the partition of PD1.4b and its runtime domain is `0..1000`, which the lowering checks as a range at dispatch.
- **S77. The checkout `settle` has no independent evidence.** The gate asks that `settle` holds for the waiting order, and `config_check.py` checks safety only. *Proposal:* I write `docs/reviews/evidence/config_liveness_check.py`, an exploration of the same configuration with the component test, for you to review before it becomes an acceptance test; until then the result is poly-ref's alone and the plan says so.
- **S78. Where a detached child's address comes from in a lowered handler.** S60 makes the address `<parent address>/<k>` and lets the handler store it. The acceptor has no instance id, as for `self` (S58). *Proposal:* a stored child address lowers to the marker `{ "$ref": "child", "key": "k" }`, resolved by the kernel against the sender when it delivers a `sendTo` (the same polyrun change as S58); alone, the address is one more distinct symbolic address of `Ref<M>` (S57's count grows by one per detached key).
- **S79. The type of `r` in an ordinary effect's `ok(r)` (PD1.2g).** An ordinary effect declares no result type. *Proposal:* `r.x` takes the type of the completion parameter it is bound to, that parameter is strict by default (the handler's result is an unchecked input, as a decision's answer is, PD1.4a), and the lowering writes `map: { p: "$.result.x" }`.

S68 to S80 are ruled in `decisions-m2.md` (24ee306, 1e1b98b), and their spec text is applied (db71051), with S66 and S67 from M1. The rulings accept the proposals, with five changes: witness and fix ids include the module digest (S69); a printer from the AST to the embedded surface, and a surface-equality test over every conformance source (S71); liveness predicates in their own module, `liveness.mjs`, read back (S74); the checkout liveness script written from 04-semantics without reading poly-ref, reproducing `config_check.py` first, and counted only after the owner reviews it (S77); a detached child's address resolved at commit, not at delivery (S78). S80, raised in conversation after the plan, narrows K9 and gate M4d to child completions; PS7.1 is unchanged.

- **S81. `PL6102` still names cancel actions (open).** S52 refuses an action wired as a child's cancel and as an effect completion or timer action, because the runtime would refuse the outside delivery (K9). Since S80, K9 names completions only, so polyrun will accept a cancel action from outside, and that half of `PL6102` refuses programs that would run. *Proposal:* `PL6102` names child completions only; S52's text in PT6.4 follows. Nothing changes until ruled.
- **S82. PS6.4 says "a reachable component", and the prefix must also avoid the goal (open, built as proposed).** A behaviour that meets `P` on its way to a goal-free component satisfies `eventually P`, so a component reachable only through `P`-states is no counterexample. *Proposal:* PS6.4 reads "a component of the states reachable from the initial state through states where `P` does not hold" for `eventually`, as it already restricts `leads to` to "the part after a `P`-state, until `Q`". poly-ref checks it that way; the evidence scripts give the same results on every source they cover.

## 8. Risks

- **Liveness is the most error-prone check poly-ref gains.** Its first tests are the evidence scripts, run before any lowering or export of liveness predicates, as M0 and M1 ran theirs.
- **The embedded surface's "same digest" is strict.** Any difference in how the two front ends fill optional fields (a handler's written parameter list, a qualified constructor) breaks it. The corpus is written in both surfaces from the start, and the digest comparison runs in `npm test`.
- **The random-order fix test can pass vacuously** if few fixes overlap. The source is chosen so that at least a third of the orders refuse some fix as stale, and the test counts both outcomes.
- **Suite length.** Narrowing the fault sweep (step 1) comes first, so the new tests do not push `npm test` past its current length.

## Conclusion

M2 is planned in nine steps. The standing rule is in place and enforced from the first commit. No engine change is on M2's path: decisions reuse polyrun's completion maps, and detached spawns and sends stay semantics-only until the owner's polyrun changes land. Twelve spec issues (S68 to S79) need a ruling; the three that liveness needs first (S73, S74, S77) are small, and the larger ones (the witness target, the fix catalogue, the embedded mapping and PD1's grammar) each come before the step that builds on them.
