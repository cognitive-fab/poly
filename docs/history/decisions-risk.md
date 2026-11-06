# poly · Decisions: risk and control tags, and the risk report

*Cognitive Fab · November 2026 · rulings on `docs/proposals/risk-tags.md`, on branch `risk-tags`*

## S586 Risk and control tags on policy items, and `poly report risks` (owner, 2026-11-03)

**The plan is accepted** (`docs/proposals/risk-tags.md`, with the owner's answers in its section 10a). The specification is PS8.10 in `04-semantics.md`, and PT8.1, PT8.6 and PT34 in `03-technical-spec.md`, with rows in PT1.2, PT12.2, PT12.3a and PT14. The acceptance criteria are RT1 to RT24 (PT34.6).

**The rulings on the plan's questions.**

| Question | Ruling |
|---|---|
| Q1 Tags on machine actions and machine `never emit` | Not in v1. |
| Q2 A date range | Yes: `--period YYYY-MM` or `YYYY-MM-DD`, UTC, as `poly cost` has it. |
| Q3 Exposure by sector or by role | Later. |
| Q4 The τ²-bench-style example | Not the poly-tau2 translation, whose study materials are available on request only: a small new airline-style example written for the docs. |
| Q5 The report over MCP | Yes: `poly_report_risks`, read-only. |
| Q6 The certificate named in the journal | Only if the policy-set check fails (RT16). |
| Q7 Allows per rule | Not in v1. The report states plainly that allows are counted per scope. |
| Q8 Finding 34 | Fixed first, as its own finding after v1.5.1, with a failing test before the fix (done on branch `finding-escalate-once`: 131239b1, 32c490ca, 94e96062). |
| Q9 The untagged-rule warnings | Only in a project that opts in to risk reporting (it declares an exposure or uses any tag); otherwise no new warning, as RT15 asks. |

**Amendment (owner, 2026-11-04).** On review of the specification: a host-side `escalate-once` denial (finding 34) is counted as an escalation made by the runtime, grouped by its `escalatedBy` cause (RT18); the report and the catalog provenance carry the MIT attribution line with its version and CC BY 4.0 (RT19); the MIT catalog is pinned to Version 4 of 2025-12-04; the PT8.6 example tags `merge-is-never-allowed` with `mit:5.2` (loss of human agency).

**Rulings on the departures of the code (owner, 2026-11-04).** On review of the code at d2f1a5f9:

| Departure | Ruling |
|---|---|
| 1. A step's `machineVersion` is the prefix of its machine's `next.cjs` digest, not a `poly.moduleDigests` value | PT34.4 item 2 names the field actually matched, one form only. |
| 2. Open scopes | Accepted, marked open, and specified (item 2, item 9). |
| 3. JSON fields beyond item 9 | Accepted and specified in item 9, except `store.path`, which depends on the host and breaks item 8: dropped. |
| 4. An escalation on unknown input whose approval, timeout or open end was counted nowhere | Not accepted: it is counted like any other escalation (item 4, RT23). |
| 5. Allows counted per event | Accepted: each `allowed` event counts once. |
| 6. The exit `INCONCLUSIVE` while a gated run is uncounted | Accepted and specified. |
| 7. The smaller choices | Accepted, and the specification amended: ids without the `risk:` prefix in `poly.risk`, the formatter's placement, `catalog-unpinned` as `ERROR`, `policyFault`, `file:` stripped on `--trust`, and no tags on the `.unknown` companions. |

The two clauses not built are built: a `never` item reported with the verdict the certificate records (`poly.risk` carries it), and the person's resolution on each unknown outcome (PT34.4 item 5 defines it). The writer adds the test of `poly.risk`'s read-back with its broken certificate `drop-risk-item`, failing first (RT20), beside RT21 to RT24. The runtime's read of a non-service machine's snapshot, found while the tests were written (`riskdesk.Clerk`), is finding 35, handled after risk-tags with its own failing test.

**Rulings on the open questions (owner, 2026-11-05).** On review of the code at 3a7cb122, after its serial runs passed:

| Question | Ruling |
|---|---|
| A certificate's `file` in the report is the path given with `--certificate`, which depends on the host as `store.path` did | Dropped, from the JSON and the Markdown. A certificate is named by its digest and build id (item 9, RT25). |
| A refusal on unknown input: counted under `refused` as well as `onUnknown`? | Confirmed. `onUnknown` marks the decisions made by the `on unknown` clause, and each is also counted as what it was (item 4, RT23). |
| A `never` item's `vacuous` and `runtime-only` verdicts, which admission never lets into a certificate | Stated: a certified `never` is always `proved`, since admission refuses a check not run or vacuous (PT12.5). poly-ref's read-back refuses any other verdict, and the broken certificate `never-not-proved` is in the faults (RT26). |
| The exits of `poly report risks`, untested | The writer adds the tests: 0 over a kept store fully counted, 2 when a certificate is missing or the ledger key is not trusted (RT27). |

The order is that of rule 7a: this amendment alone, then the writer's tests, failing first, then the code and the kept reports made again.

**The citation.** The literature is cited by its own words: Saeri et al., *Unmitigated? How are the world's largest companies responding to AI risks?*, MIT FutureTech, October 2026, Discussion.

**Numbers used.** S586 is the next free ruling (S584 is on `proposal-extensions`, S585 is the tree guard's retirement). The plan's PT8.7 is PT8.6, since PT8 ended at PT8.5. `PL6506` and `PL6507` are free slots of PL65xx; the plan's `PL6508` was dropped, since a catalog pin is a toolchain fault (`catalog-unpinned`), not a diagnostic.

**Order of work (rule 7a).** This ruling and the specification, committed alone; then the catalogs and their provenance; then the tests, by a separate writer on the session's model who has read only the specification and the catalogs, failing first; then the code. Only the new test files and the files the change touches are run; the full suite only at the owner's word, with nothing else heavy on the machine.

## Conclusion

The tags are metadata that a person signs and the engine ignores, the report counts what each rule did from a verified journal, and what the journal cannot say (which rules let a proposal through, which certificate a run used) is stated rather than inferred. The order of work keeps the specification ahead of the tests and the tests ahead of the code.
