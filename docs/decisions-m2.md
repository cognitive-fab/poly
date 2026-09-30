# poly · Decisions for M2

*Cognitive Fab · September 2026 · answers section 6 of [`plan-m2.md`](plan-m2.md)*

The owner's rulings on the spec issues raised while planning M2. Issue ids continue the series. The agent applies the spec text in one commit citing the ids, before the steps that depend on them.

## Rulings on the M2 plan (S68 to S79)

| Issue | Ruling | Spec change |
|---|---|---|
| **S68** What an exported witness test drives before M4 | **Accepted, with two conditions.** Until the runtime API exists, the test drives the lowered artefacts (the SAM module, the effect mapper, polyrun's kernel for children, and a small harness for configurations). (1) The test pins the build by its module digest and refuses to run against a different build, so a stale build cannot make it pass. (2) When M4's runtime API lands, exported tests are regenerated against it; the M4 plan lists that. | PT12.4 |
| **S69** Report, witness ids and fix ids | **Accepted, with the digests widened.** `poly check` writes `.poly/report.json`. A witness id is the SHA-256 of the RFC 8785 canonical JSON of `{ moduleDigest, property, trace }`, so the same trace in another version of the module is another witness. A fix id is `<name>@<prefix>` of the digest of `{ moduleDigest, nodeId, edit }`, so a fix is tied to the AST it was computed on, and `PL0201 STALE_FIX` follows directly from a digest mismatch or a failed precondition. | PT12.1, PT12.4 |
| **S70** The first fixes | **Accepted.** `PL3102` (add a `require`, or widen the range), `PL1202`, `PL1504`, `PL1005`, `PL1501`, `PL2101`, with three edit operations, on the standalone surface only. Fixes on the embedded surface wait for M3's answer on which surface agents use. | PT12.1 |
| **S71** The embedded surface's mapping | **Accepted, with a printer.** The full mapping, with named type declarations, is written into PT2.5 as a table. Projects may list `.ts` modules. **Addition:** build a printer from the AST to the embedded surface. Then the gate's equality test runs over every conformance source: parse the standalone source, print it as TypeScript, parse that with `poly-embed`, and require the same AST digest and verdict. The three hand-written embedded examples of the handoff stay as well, because a printer cannot catch a mapping both directions get wrong the same way. | PT2.5 |
| **S72** Which handler files are linted | **Accepted.** `poly.json` gains `handlers: [glob, …]`. A project with effects and no `handlers` field lists the lint as not run under the instance line; it is never silently clean. | PT1.2, PT6.5 |
| **S73** Naming inputs in a fairness clause | **Accepted:** the `InputRef` form of S31, with an optional `(*)` for one group per data value. | PT2 |
| **S74** The lasso witness | **Accepted for the witness; the predicates move.** A liveness witness is the trace of the prefix followed by the cycle, with `witness.cycle` the index where the cycle begins. The exported test replays the prefix and the cycle, checks that the cycle returns to its first state, that the goal never holds on it, and that every fair group is either taken or disabled somewhere on it. The liveness predicates are written to **their own module, `liveness.mjs`**, not to `invariants.mjs`, so no engine can mistake them for invariants. The module joins the round-trip checks of the standing rule. | PT5, PT12.4, PT17 |
| **S75** How far `PL6201` looks | **Accepted, with the limitation stated.** `PL6201` considers the decision's completion step and its cascade only. Looking further would reach most irreversible effects through unrelated inputs and make the finding meaningless. The limitation is written into PD1.4d: an answer stored in the state and acted on by a later step is not covered by `PL6201`, and is covered instead by the properties the author writes over that state. | proposal PD1.4d |
| **S76** A grammar for PD1 | **Accepted.** Decimal literals are legal only where a `Conf` is expected (elsewhere `PL1201`). `Tri` is usable in machines with the constructors `True`, `False` and `Unknown`, resolved as S22 resolves any constructor; `Tri.Unknown` is always legal. | PT2, PT3 |
| **S77** Evidence for the checkout's `settle` | **Accepted, with independence required.** Write `config_liveness_check.py` from 04-semantics (PS6, PS13, PS14) without reading poly-ref's source. It must first reproduce `config_check.py`'s results (the six-step witness, 44 states) before its liveness result counts. It becomes an acceptance test only after I have reviewed it. | none |
| **S78** A detached child's address in a lowered handler | **Accepted with a change: resolve at commit, not at delivery.** The marker `{ "$ref": "child", "key": "k" }` is resolved by the kernel when it commits the step that creates it, in the post-state and in every outgoing intent, to the absolute address `<parent>/<k>`. Resolving at delivery against the sender would be wrong as soon as the parent passes the address to a third machine, because the sender is then not the parent. After the creating step, every copy of the address is absolute, and translation validation compares after resolution. Alone, each detached key adds one distinct symbolic address to S57's count. This is part of the polyrun change already on my list for `sendTo` and `createInstance`. | PS1.6, PT6.4, PT7a |
| **S79** `ok(r)` for ordinary effects | **Accepted.** `r.x` takes the type of the completion parameter it is bound to, and that parameter is strict by default. A handler result without `x`, or with `x` outside the domain, is rejected at dispatch and journaled as a rejected step; a machine that can then wait forever is caught by the liveness check. | PT6.1 |

## Ruling on S80: K9 and cancel actions

| Issue | Ruling | Spec change |
|---|---|---|
| **S80** K9 is stricter than PS7.1 | K9 says a child's completion **or cancel** action comes only from the kernel; PS7.1 withholds only the completion, and poly-ref and check-product offer cancel actions from outside. **K9 names completions only; PS7.1 is unchanged.** Offering cancels from outside only adds behaviour, so every verdict stays sound without that half of K9, and the joint state counts of both engines stay as they are. A kernel assumption lists only what a verdict relies on. The polyrun change on my list narrows to match: refuse an outside dispatch of an action wired as a child's completion. Gate M4d is narrowed the same way. | PS10 (K9); PT18 M4 row |

## Rulings at M2's close (S81 to S85), and the review of `config_liveness_check.py` (S77)

| Issue | Ruling | Spec change |
|---|---|---|
| **S81** `PL6102` still names cancel actions | **Accepted.** `PL6102` names child completions only, as K9 does since S80. S52's text in PT6.4 follows. | PT6.4; PT12.2 |
| **S82** The prefix of an `eventually` counterexample | **Accepted.** For `eventually P`, the counterexample is a fair component of the states reachable from the initial state through states where `P` does not hold; this is the standard reading, and it matches the restriction PS6.4 already makes for `leads to`. | PS6.4 |
| **S83** A second spawn of a live detached key | **Accepted.** In a configuration it is `PL5101 CHILDKEY_COLLISION`, with its witness, checked before the instance bound. The interim `ERROR` goes away. | PS13.3; PT6.4 |
| **S84** tsc and equality with an object literal | **Accepted.** A record or map literal used as an operand is written `lit({ … })` in the embedded surface; elsewhere (initial values, arguments) it stays an object literal. The printer and the reader both follow it, and the exemption for `TS2839` in the printed-sources test is removed: every printed source must pass `tsc --noEmit`. | PT2.5 |
| **S85** What PD1.4d's gate quantifies over | **Accepted: PD1.5's reading.** A decision is gated iff, for every answer whose accepted completion can emit a compensable or irreversible effect, some confidence or margin interval keeps every accepted completion with that answer from emitting one. Rejected completions emit nothing, so a `require` that rejects below a threshold is a gate. `require conf >= 0` is not. A decision in a machine with attached children stays `PL0901` until the cascade is followed through the joint machine. | proposal PD1.4d |

**`config_liveness_check.py` is accepted as an acceptance test, with three conditions.** I read it against PS6.4, PS13 and PS14 and ran it:

- It reproduces `config_check.py`: the six-step witness for the optimistic order, and 44 states with the invariant holding for the order that waits. It reports `settle` holding for both orders.
- It is sensitive. I ran two mutants. One removes the inventory's `OutOfStock` reply, so an order can wait in `Taking` forever: `settle` is violated for both orders, with one fair component each. The other ignores fairness: `settle` is violated with 29 components each, so the fairness check is what makes the result hold.
- Its fairness is weak fairness per message value, and a rejected input is a stutter (PS3.3), so a state with nothing in transit and an order still `Asked` counts as a violation, as it should.

Conditions:

1. **The two mutants become built-in controls.** The script runs them first and refuses to report on the real model unless both are violated, as the M0 doctrine requires ("controls first").
2. **A bound hit makes the liveness result inconclusive.** Today the script drops a step that exceeds the transit bound and would still print "holds". It must print `INCONCLUSIVE` for `settle` whenever `bound hit` is true.
3. **Record why the optimistic count differs.** This script explores 47 states for the optimistic order and `config_check.py` reports 30. The gate numbers are unaffected (the witness and the 44), but the plan records which script stops early and why, so the two scripts' counts are not mistaken for a disagreement.

Its independence is limited, as the agent says, because the same agent wrote poly-ref. My reading, the two mutants, and its agreement with `config_check.py` are what it relies on.

## Rulings after the M2 code review (S86, and the refused exports)

| Issue | Ruling | Spec change |
|---|---|---|
| **S86** Two machines with the same defect got the same witness id | **Accepted.** A witness id is the SHA-256 of the RFC 8785 canonical JSON of `{ moduleDigest, subject, property, trace }`, where `subject` is the machine or configuration the witness is about. S69 is amended accordingly. | PT12.4 |
| **Refused exports** (from the review) | **Accepted as the right interim behaviour.** For `PL5001`, `PL5101`, `PL5104` and a configuration's `PL3102`, `poly witness --test` refuses and says why; it never writes a test that passes on a broken program. The report marks these findings "no test export until M4". None is in AC3's seeded set, so the M2 gate is unaffected. M4's plan lists them: its runtime API drives children and configurations directly, and each gets an exported test there. | PT12.4 |

M2 is closed.

## Conclusion

The plan can proceed as written, with five changes: witness and fix ids that include the module digest (S69), an AST printer that turns the surface-equality test into a test over every conformance source (S71), liveness predicates in their own module (S74), an independently written evidence script for the checkout's `settle` (S77), and detached addresses resolved at commit rather than at delivery (S78).
