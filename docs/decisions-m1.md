# poly · Decisions before M1

*Cognitive Fab · September 2026 · answers section 12 of [`plan-m0.md`](plan-m0.md)*

The owner's rulings on what M1 needs that M0 does not provide. They are settled before M1 starts. PT18 is updated in the same commit as this note. Issue ids continue the M0 series, so the first M1 issue is S23.

| Id | Question | Ruling | Spec change |
|---|---|---|---|
| **M1-1** (settles S7) | An accepted step that only emits looks `unhandled` to SAM, so polyrun derives no effects from it. | **Fixed in the engine, not in the lowering.** `@cognitive-fab/sam-pattern` 2.3.0 adds one classification: a step with no rejection, no mutation and no write, whose acceptor declared its frame explicitly with `unchanged(...)`, is `unchanged`, an accepted step. An empty frame stays `unhandled`. A hidden outbox field in the lowering is **rejected**: 04-semantics has no such field, and it would change every state count, so the evidence numbers would no longer compare one to one. polyrun already treats every classification other than `rejected` and `unhandled` as accepted; a test in polygraph pins that for `unchanged`. `PL2201 SILENT_NOOP` still applies to a handler path with no write, no effect and no rejection. | none (PT4.4 already describes the step; the engine catches up) |
| **M1-2** | Liveness is M2, so the three `OutboxIntent` examples are refused with `PL0901` and their safety results are lost. | **Check what can be checked.** `poly check` accepts liveness properties, checks everything else, and lists each liveness property as not run, with the milestone that runs it. A verdict with a not-run item folds to `INCONCLUSIVE` at best, and to `FINDINGS` if a safety check fails. `PL0901` keeps refusing constructs that are not lowered at all. | PT12.2 (`PL0901` note) |
| **M1-3** | `exactly-once` in the `Delivery` gate is a liveness property, so M1 cannot check it. | **Moved to M2.** M1 reproduces the safety results of the four variants: the state counts, `at-most-once`, `in-order`, and both violation witnesses. M2 reproduces `exactly-once` for the two variants that keep dedupe records, and `settles` for the three `OutboxIntent` forms. The checkout's "every placed order settles" moves to M2 on the same grounds; its "no stuck state" (`PL5402`) is a reachability check and stays in M1. | PT18 M1 and M2 rows |
| **M1-4** | Two of the three follow-up defects found after the M0 review were initial values that the finding 3 fix should have caught. | **A generated test.** For every initial-value shape (scalar, union with and without payload, map key, map value, nested union in a map), generate one value inside its type and one outside. The outside value must be `PL1201` at its line; the inside value must lower and pass strict `validate()`. | none |
| **M1-5** | Line endings are part of a file's hash. | **Already enforced.** `.gitattributes` marks `conformance/field-studies/** -text`, and the field-study test re-hashes each copy against `PROVENANCE.md`. Every corpus M1 adds (the `polyrun-oms` order machine and its traces) is copied under the same rule. | none |
| **M1-6** | `poly check` takes one file; configurations span modules. | **The manifest comes first.** Implement `poly.json` as PT1.2 states it. `poly check` takes a file or a project directory. A field the build needs that PT1.2 does not have is a spec issue, raised before it is used. | none |

## Standing rules carried into M1

Every rule of M0 still holds: the import boundary, no model call on a check path, no silent clean, the evidence scripts as acceptance tests, engines as dependencies, `PL2501` and `PL2001` for toolchain faults only, polygraph findings confirmed by poly-ref, and structured diagnostics. One addition:

- **The effect sequence is part of translation validation.** PS9.2 compares `E` as well as the post-state. From M1, poly-ref and the lowered module (`next.cjs` together with `effects.cjs`) must agree on the effect intents of every transition, in order. A lowering that drops or reorders an effect is a deliberately broken lowering in the explicit list, and it must be caught with `PL2501`.

## Conclusion

M1 starts with its three open questions settled. The emit-only step is fixed where it originates, in the engine. Liveness no longer blocks a safety result. The one gate item that needs liveness moves to the milestone that builds it. The configuration explorer is the main work, and its first targets (the checkout witness and the delivery variants) are already measured by independent scripts.
