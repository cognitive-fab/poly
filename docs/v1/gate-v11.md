# The v1.1 gate (M7) · record

**For the reviewer's ruling, before any tag.** The gate ran on 2026-10-12 on `m7` at 19b06670 (cut from `main` at 02ad6d4f; 61 commits, 124 files changed). It is the V10 gate (`docs/v1/gate-v10.md`) applied to M7, with the owner's reviewer's changes of 2026-10-12: `test:e3` is not an item (E3 is not finished and lands in a later release) but a compatibility check, run after the suite on a throwaway merge that is not kept.

## The run

Clean build (every `packages/*/dist`, every `.tsbuildinfo` and every `.poly/test-*` removed first), alone on the machine, JJ holding E3 for the length of it. **The gate was run twice.** The first run (at dad0691e, `.poly/logs/dad0691e-2026-10-12T22-38-37-087Z-gate.log`) had two failures, both mine and both fixed in 19b06670: the normative proposal source I had put under `docs/m7/` is a poly source outside the standing rule's directories (it is now `test/fixtures/m7/proposal-example.poly`), and a test of the seam assumed that a child stopped at its 2-second timeout had logged a start, which under the suite's load it had not. `npm test` stops at the first failing group, so the first run did not reach the after group. The second run is the gate's.

| # | Item | Result |
|---|---|---|
| 1 | The full suite and the after group: no failure | **Met.** `.poly/logs/19b06670-2026-10-12T23-30-39-917Z-gate2.log`: the suite **2,797 tests, 2,791 passed, 0 failed, 2 skipped, 4 waiting** (the same 2 skipped and 4 waiting as at V10); the after group **19 tests, 19 passed**. The audit's tests (`test/audit-m7-promotion.test.mjs`, 7, and `test/refit-synthetic-admission.test.mjs`, 1) ran in the suite and passed. |
| 2 | check-memory | **Met** (the same run): checking one unchanged file 60 times keeps no memory per check. |
| 3 | The measured programs | **Met, with one ruled change.** `docs/v1/verdicts-at-gate-v11.json`: 163 files, 4 checks at a time, 264 s, none crashed or threw, against `verdicts-at-gate.json` (163): **162 are identical** (verdict, diagnostics, state and transition counts, stages, policies). The one difference is `examples/inbox/inbox.poly`: `CLEAN` before and after; the machine `Todo` has 9,130 states and 785,180 transitions where it had 7,294 and 605,402, because of the `Uncertain` status and the `made` flag the draft-once fix added (IT4.4). No verdict changed. |
| 4 | Every example meets its first line, and the concierge and the inbox are `CLEAN` with their policies | **Met** (`test/examples-expected.test.mjs`, the serial group, in the suite; and the measure above, where both are `CLEAN`). |
| 5 | Per-file times against the V10 gate and `docs/m11/gate2-file-times.json` | **Passes by the spot checks below.** |
| 6 | The release notes | **Complete**: `docs/release-notes-v1.1.md` (the commands, the inbox defect and its fix, S526 and S527, `--refine`, the channel sends, the evidence and what it did not show, the limits). |
| 7 | A record | This file, and the section of `docs/history/decisions-m7.md`. |
| E3 | `test:e3`, as a compatibility check, **not a gate item** | **171 of 171 passed**, in 2,794 s (see below). |

## Per-file times

The suite ran 265 files in 2,933 s of wall-clock, against 169 files in 735 s at gate2 and 223 files in 1,919 s at V10; the after group 9 files in 3,001 s, against 1 in 76 s at gate2. Files run together, so a file's time grows with the number of the others. The 97 files new since gate2 are the rulings of v1.0, the examples' tests and M7's; the slowest of them (`ex-inbox-draft-once` 2,686 s, `ex-inbox-drafts` 1,868 s, `ex-inbox-read-grant` 1,429 s, `ex-inbox` 1,426 s, `memory-flow` 1,340 s, `propose` 1,074 s, `mine` 1,052 s) are inbox and polyx or polyness tests that admit or check the inbox or run a separate tool, and their times are contention. The after group's slowest are `ex-inbox-loop` (1,240 s, three checks of the inbox, a promotion at 500 s and a refined promotion at 330 s), `serial-sources` (465 s), `ex-inbox-refit` (318 s, three admissions of the inbox), `ex-trace-export` (313 s) and `ex-inbox-invariant` (242 s).

**Spot checks (the V10 method).** The files that moved most against gate2 among those with a large gate2 time were run alone, one after another, with nothing else running, limit 1.5 times the gate2 time:

| File | gate2 | alone now | ratio | within 1.5 |
|---|---|---|---|---|
| `outbox-intent` | 223 s | 128 s | 0.57 | yes |
| `m3-runner` | 263 s | 121 s | 0.46 | yes |
| `channels-events` | 491 s | 310 s | 0.63 | yes |
| `m4f-recheck` | 289 s | 447 s, then 326 s and 338 s on two more runs | 1.55, then 1.13 and 1.17 | yes (the first reading followed the suite directly and is noise) |

I looked for a cost of M7.5's budget lookup on every intent (it reads one more row per proposed intent) and the repeats say there is none to speak of.

## The compatibility check for E3 (not a gate item)

After the suite, alone, in a throwaway worktree (`../poly-m7-e3compat`, detached at 19b06670): `git merge --no-commit --no-ff e3` merged **without a conflict** (`docs/04-semantics.md` and `package.json` auto-merged); the worktree has its own `node_modules` with the `@poly` links pointed at its own packages; it built; `npm run test:e3` (`test/e3/*.test.mjs`, serial): **171 tests, 171 passed, 0 failed, 0 skipped**, 2,794 s. The worktree is removed and the merge was never committed or kept (`git worktree list` shows no trace, and `m7` has no merge state). No test failed, so there is no finding about M7 changing core behaviour that E3 relies on, and nothing to pass to E3. E3 is at its own head (93b1d8e0 when I read it), unfinished (E3.8 to E3.10 and the live run remain).

## What M7 delivered, against its acceptance

- **M7-AC1** (a mined rule adjudicated real round-trips to an admitted obligation): shop (`test/loop-shop.test.mjs`) and the inbox (`test/after/ex-inbox-loop.test.mjs`), with the conflict case from the shop; the inbox leg on a synthetic amplification, labelled so (accepted 2026-10-11).
- **M7-AC2** (a polyness proposal arrives as poly source and is admitted or refused by the pipeline): `test/propose-ac2.test.mjs`, on synthetic transcripts.
- **M7.4** (verdicts and the refit): accepted 2026-10-12; **M7.5** (work-order budgets): accepted 2026-10-12.
- **A defect in a shipped example, found by the loop and fixed** (the inbox draft, IT4.4), with S526 and S527 recorded.

## Authorship of the tests, for the record

Separate writers wrote, from the specification text, and I corrected: `proposal-admission` (19), `workflow-budget-front` (14), `workflow-budget` (20); the reviewer-accepted M7.1 and M7.2 files are as recorded earlier. **I wrote**, and the audit reads them against the spec: `propose` (20), `propose-ac2` (4), `propose-runs` (5), `promote-refine` (3), `verdict-refit` (11), `ex-inbox-adjudicate` (4), `ex-inbox-draft-once` (6), `boundaries-polyness` (4), `refit-synthetic-admission` (1), and the after tests `ex-inbox-invariant`, `ex-inbox-refit`, and the extension of `ex-inbox-loop`. The independent audit of the adjudication, promotion and admission tests (`docs/m7/promotion-audit.md`): 74 clause sentences, all graded tested after the review, with 7 tests by the auditor and 1 by me.

## Open for the reviewer

- The word on the gate, then the fast-forward of `main` to `m7` and the local tag `v1.1.0` (never pushed).
- `workflow_report`'s optional `usage` (S174 amended) is to be raised with JJ as an upstream change to polyflow.
- Recorded and not changed: S526 (the default retry of an irreversible effect) and the channel sends that can duplicate a message; S527; PS20.6.

## Conclusion

The gate is clean. The suite and the after group have no failure, 162 of the 163 measured programs are identical to their baseline and the 163rd (the inbox) is `CLEAN` with the state count its fix changed, every example meets its first line, the four slowest movers are within 1.5 times their gate2 time when run alone, and E3's 171 tests pass on a throwaway merge with M7.
