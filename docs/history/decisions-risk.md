# poly · Decisions: risk and control tags, and the risk report

*Cognitive Fab · November 2026 · rulings on `docs/proposals/risk-tags.md`, on branch `risk-tags`*

## S586 Risk and control tags on policy items, and `poly report risks` (owner, 2026-11-03)

**The plan is accepted** (`docs/proposals/risk-tags.md`, with the owner's answers in its section 10a). The specification is PS8.10 in `04-semantics.md`, and PT8.1, PT8.6 and PT34 in `03-technical-spec.md`, with rows in PT1.2, PT12.2, PT12.3a and PT14. The acceptance criteria are RT1 to RT17 (PT34.6).

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

**The citation.** The literature is cited by its own words: Saeri et al., *Unmitigated? How are the world's largest companies responding to AI risks?*, MIT FutureTech, October 2026, Discussion.

**Numbers used.** S586 is the next free ruling (S584 is on `proposal-extensions`, S585 is the tree guard's retirement). The plan's PT8.7 is PT8.6, since PT8 ended at PT8.5. `PL6506` and `PL6507` are free slots of PL65xx; the plan's `PL6508` was dropped, since a catalog pin is a toolchain fault (`catalog-unpinned`), not a diagnostic.

**Order of work (rule 7a).** This ruling and the specification, committed alone; then the catalogs and their provenance; then the tests, by a separate writer on the session's model who has read only the specification and the catalogs, failing first; then the code. Only the new test files and the files the change touches are run; the full suite only at the owner's word, with nothing else heavy on the machine.

## Conclusion

The tags are metadata that a person signs and the engine ignores, the report counts what each rule did from a verified journal, and what the journal cannot say (which rules let a proposal through, which certificate a run used) is stated rather than inferred. The order of work keeps the specification ahead of the tests and the tests ahead of the code.
