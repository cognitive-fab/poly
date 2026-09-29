# poly · Decisions on the M0 spec issues

*Cognitive Fab · September 2026 · answers section 6 of [`plan-m0.md`](plan-m0.md)*

The owner's rulings on the issues raised while planning M0. The spec files are updated for S1 to S5 and S17 in the same commit as this note. The other issues are accepted as proposed, and the agent applies them to the spec itself (see the last section).

| Issue | Ruling | Spec change |
|---|---|---|
| **S1** Raft cannot replay at 100% | **Accepted.** The gate is identity with the hand-written controls, **window by window**: turnstile 12/12 and 9/12, raft 54/67 and 44/67, hatchet 19/19 and 18/19. A window the poly version passes and the control fails is also a failure; the gate tests identity, not "at least as good". | PT18 M0 row; AC2; handoff |
| **S2** v0.3 `OutboxIntent` has no deadlock | **Accepted.** Test both forms. v0.3 gives 33 states, 40 accepted steps and no deadlock. v0.2 (AC9's variant) gives 35 states and deadlocks at `(Allowed, 3, 1, T, F)` and `(Allowed, 3, 2, T, T)`. `evidence/outbox_check.py` now takes `v0.3` or `v0.2` and prints both results. | PT18 M0 row; handoff; evidence script |
| **S3** Corpus fields named `state` and `derived` | **Accepted: contextual keywords.** A keyword is reserved only where the grammar uses it, and the parser decides with at most two tokens of lookahead. The external-name clause is **rejected**: it would give one field two names across traces, contracts and diagnostics. Names lower verbatim. | PT2.1 |
| **S4** Hatchet's `taskStatuses` array | **Accepted.** `map<0..n, T>` lowers to a JSON array of length `n + 1`, and an enum-keyed map lowers to a JSON object keyed by constructor name. A range key not starting at 0 is `PL1602`. The map literal `{ k: v, … }` must list every key (`PL1502`), and range-keyed maps also accept `[v0, …, vn]`. | PT2 grammar, PT2.2, PT3.1 |
| **S5** Counters that grow without limit | **Accepted, with one addition.** Leaving a check domain while staying inside the declared type is a bound hit (`PL3901`, naming the field, with the shortest path to the boundary). The post-state is not explored, and the verdict is at best `INCONCLUSIVE`. Leaving a declared type stays `PL3102`, a finding. **Addition:** properties are still checked on every explored state, so a violation inside the bound folds to `FINDINGS`. Your approach of giving polygraph a state cap computed from poly-ref's exploration is accepted. | PS4.2, PS4.2a |
| **S17** Corpora outside the repository | **Accepted, with two additions.** Copy the traces, contracts, invariants and hand-written controls into `conformance/field-studies/<name>/`. `PROVENANCE.md` records the source path and commit, and the SHA-256 of every file. **Additions:** it also records the upstream project whose code produced the traces and that project's licence. The sync script verifies hashes against the local sources, and CI reads only the copies. | PT17 |

## Accepted as proposed: S6 to S16 and S18

S6 (terminal as the first acceptor), S7 (`PL2201` as an error in M0; the classification of emit-only steps is settled in M1), S8 (step properties guarded to accepted steps), S9 (shared payload fields and `PL1601`), S10 (the Rust rule for `{` after an identifier in `if` and `match`), S11 (a `reject` statement), S12 (truncating division and `PL1204`), S13 (the new diagnostic codes, including `PL0901 NOT_IN_MILESTONE`), S14 (optional parameter lists that must repeat the declared names), S15 (what properties may mention), S16 (both SAM versions recorded in the instance line) and S18 (`Ref` parsed and type-checked, refused at lowering until M1) are all accepted.

The agent applies those that change the spec text (S9 to S15, and the `reject` statement of S11) to `03-technical-spec.md` and `04-semantics.md` in one commit before step 5. The commit message cites each issue id. The v0.6 draft number is unchanged; these are clarifications within M0.

## Conclusion

Every issue that blocked steps 5 and 8 is resolved. The raft gate now tests what can be true: identity with the controls, not a pass rate no deterministic machine can reach. Unbounded counters are checked up to their bound, and the verdict says so (`INCONCLUSIVE`). Corpus names and arrays are expressible without renaming. The gate reads only data inside the repository.
