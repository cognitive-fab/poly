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

## Rulings after the M0 code review

The review of `714c513..HEAD` returned ten findings. These rulings settle the two spec questions it raised, and the open issues S19 and S20, before any fix.

| Issue | Ruling | Spec change (applied by the agent, one commit, ids cited) |
|---|---|---|
| **S19** A parameter that shares a field's name (handlers) | **Accepted, as one rule for every context.** A bare name resolves to the innermost binding: local, then parameter, then field, as in TypeScript. `pre.f` always names the pre-state field `f`, in handlers as well as properties. | PS2.2, PT2.2, PT5 |
| **S19 extended** (finding 1) Guards and reject properties | **Accepted.** Parameters are visible only where the action is known: in a handler, or where `action == A` narrows it in a guard, step property or reject property. There the S19 rule applies. With no narrowing, no parameter is in scope, and a bare name is the field. The checker, the lowering and poly-ref implement this one rule, and a conformance case covers a colliding name in each of the four contexts. | PS2.2, PS5.2, PS5.3, PT4.3, PT5 |
| **S20** No code for a failed strict `validate()` | **Accepted.** `PL2001 STRICT_VALIDATE`, verdict `REFUSED`, addressed to the toolchain, like `PL2501`. | PT12.2 |
| **S21** (finding 2) A name in a pattern: binder or constructor? | **Accepted, with two additions.** (1) A name that is a constructor of the **expected type** is a literal pattern. (2) A name that is a constructor of **another** type in scope is a type error (`PL1201`), not a binder. (3) Any other name binds. A binder that shadows a constructor in scope is an error. **Additions:** (4) a binder that its arm never reads is an error (`PL1504 UNUSED_BINDER`; write `_` instead), so a misspelled constructor cannot silently become a catch-all; (5) an arm that an earlier arm always covers is an error (`PL1503 UNREACHABLE_ARM`). With (4) and (5), the finding-2 program is refused at the source line instead of passing as `CLEAN`. | PT2 `Pattern`, PT2.4, PT12.2 |
| **S22** (finding 4) A constructor declared in two types | **New ruling.** Constructor names resolve against the expected type. In `a == b`, each side is typed first, and an ambiguous constructor on either side takes the other side's type. The qualified form `Type.C` is always legal. A constructor that stays ambiguous after that is `PL1005 AMBIGUOUS_CONSTRUCTOR`, whose fix is the qualified form. `Open == s` and `s == Open` then mean the same thing. | PT2.4, PT12.2 |

## Standing rules the review adds

- **PL2501 and PL2001 are for toolchain faults only.** A program with a user error must be reported at its source line with a user-facing code. Any user program that reaches `PL2501` or `PL2001` is a checker bug. The test suite fails on any `PL2501` or `PL2001` except the deliberately broken lowering.
- **polygraph's findings are confirmed by poly-ref** (finding 7). Every finding polygraph reports on the lowered module has a witness path, which is replayed through poly-ref. The finding counts only if every state on that path is in the checked instance (PS4.2). If the path leaves the instance, it becomes a bound hit (`INCONCLUSIVE`), not `FINDINGS`. If poly-ref disagrees about a state inside the instance, that is `PL2501`.
- **Diagnostics carry structure** (finding 8). Each diagnostic records its property name, field and state digest as fields, and results are merged on `(code, property or field)`, never on message text. This fix lands before finding 6, which depends on it.

## Order of the fixes

For each finding, first add a regression test that fails, then fix it, and commit the two together.

1. **Finding 2**, under S21.
2. **Finding 1**, under S19 extended.
3. **Finding 3.** Constant-fold and range-check every initial value, reported as `PL1201` at the line.
4. **Finding 7**, by confirming polygraph's witnesses through poly-ref.
5. **Finding 8, then finding 6.**
6. **Finding 4**, under S22.
7. **Finding 5.** The CLI resolves `@cognitive-fab/sam-pattern` from its own install location, for any `--root`.
8. **Findings 9 and 10**, as separate refactoring commits with no change in behaviour. Every test result and state count stays identical.

## Conclusion

Every issue that blocked steps 5 and 8 is resolved. The raft gate now tests what can be true: identity with the controls, not a pass rate no deterministic machine can reach. Unbounded counters are checked up to their bound, and the verdict says so (`INCONCLUSIVE`). Corpus names and arrays are expressible without renaming. The gate reads only data inside the repository.
