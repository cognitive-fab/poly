# M3 report (draft): the first experiment

M3 ran the experiment PT13 fixes: ten stateful tasks, four arms, five runs per task and arm, 200 runs in all. All 200 runs are recorded and scored. This draft gives the pre-registered analysis as `experiments/m3/analysis/analyse.mjs` computes it, unchanged since the freeze (`freeze.mjs --check` reports no change at `ef28969`), then the deviations and the observations already recorded, each in its own section. Its output is in `docs/m3/analysis.json`. It was run without a prices file, as frozen, so cost per delivered task is not computed.

## 1. What ran

| | |
|---|---|
| Tasks | T1 to T10, each a base version and three changes delivered in sequence to the same run |
| Arms | 1: TypeScript alone; 2: TypeScript, then polygraph, fixes allowed; 3: poly, standalone syntax; 4: poly, embedded TypeScript surface |
| Runs | 50 blocks, each the four arms of one task and run number started together; 200 runs |
| Model | `claude-opus-5-5` in every arm, through the claude CLI on a subscription (S116) |
| Caps per run | 15,000,000 tokens, 3,600 s wall time, $15 (the CLI's own cap) |
| Freeze | blocks 1 to 39 at `84d905e`; blocks 40 to 50 at `b8a8cfb` (section 3.1) |
| Oracles | O1 scenario tests from an independent session (primary); O2 hidden invariants and O3 reference traces (secondary); O1-R range refusals (secondary, M3-10) |

## 2. The pre-registered analysis, as computed

### 2.1 Primary result

The verdict is **between**: neither poly arm wins, and the stop rule does not fire. The reported verdict (S115, S117) is the same: between, arm 3 no win, arm 4 no win.

| Measure (mean over the ten tasks of the per-task means) | Arm 1 | Arm 2 | Arm 3 | Arm 4 |
|---|---|---|---|---|
| Escaped defects per delivered task (O1) | 0.00 | 0.00 | 1.04 | 1.08 |
| Tokens per delivered task | 496,146 | 4,267,380 | 1,746,467 | 1,737,013 |
| Runs delivered within budget | 50 of 50 | 47 of 50 | 50 of 50 | 50 of 50 |
| Admitted (delivered, `poly check` CLEAN) | | | 100% | 100% |

Every escaped defect of arms 3 and 4 is in T3 or T7. Per task, arm 3's mean is 10.4 on T3 (two runs of five with 26 failing O1 tests each) and 0 elsewhere; arm 4's is 10.4 on T3 (two runs) and 0.4 on T7 (one run with 2), and 0 elsewhere. Arms 1 and 2 have no failing O1 test in any delivered run.

**The win rule (PT13, S96).** A win needs a poly arm to reduce mean escaped defects by at least 30% against both arms 1 and 2, with tokens per delivered task at most twice arm 1's, and both Holm-corrected comparisons below 0.05. For arm 3 and arm 4 the effect is `false`, the significance is `false`, and the win is `false`. Arms 1 and 2 have a mean of 0, and the rule requires the comparator's mean to be above 0, so no reduction can be counted against them.

**The surface rule.** The script returns `embedded`: arm 4's mean escaped defects (1.08) are within 10% of arm 3's (1.04, difference 0.04 against a margin of 0.104), and arm 4's tokens per delivered task (1,737,013) are below arm 3's (1,746,467). The token difference is 0.5%; the comparison of the two (section 2.2) has Holm p 0.92.

**The stop rule.** A stop needs neither poly arm to deliver an admitted program in 70% of its runs within budget. Arm 3 and arm 4 each delivered an admitted program in 50 of 50 runs (100%). Stop: `false`.

### 2.2 The Holm-corrected comparisons

Exact two-sided Wilcoxon signed-rank test over the ten tasks, Holm-corrected over the five comparisons of each family at 0.05. `n` is the number of tasks with a nonzero difference.

**Escaped defects per delivered task (the primary family).**

| Comparison | Means | n | W+ | p | Holm p | Significant |
|---|---|---|---|---|---|---|
| arm 3 vs arm 1 | 1.04 vs 0.00 | 1 | 1 | 1.0000 | 1.0000 | no |
| arm 3 vs arm 2 | 1.04 vs 0.00 | 1 | 1 | 1.0000 | 1.0000 | no |
| arm 4 vs arm 1 | 1.08 vs 0.00 | 2 | 3 | 0.5000 | 1.0000 | no |
| arm 4 vs arm 2 | 1.08 vs 0.00 | 2 | 3 | 0.5000 | 1.0000 | no |
| arm 4 vs arm 3 | 1.08 vs 1.04 | 1 | 1 | 1.0000 | 1.0000 | no |

**Tokens per delivered task (the second family).**

| Comparison | Means | n | W+ | p | Holm p | Significant |
|---|---|---|---|---|---|---|
| arm 3 vs arm 1 | 1,746,467 vs 496,146 | 10 | 55 | 0.0020 | 0.0098 | yes |
| arm 3 vs arm 2 | 1,746,467 vs 4,267,380 | 10 | 0 | 0.0020 | 0.0098 | yes |
| arm 4 vs arm 1 | 1,737,013 vs 496,146 | 10 | 55 | 0.0020 | 0.0098 | yes |
| arm 4 vs arm 2 | 1,737,013 vs 4,267,380 | 10 | 0 | 0.0020 | 0.0098 | yes |
| arm 4 vs arm 3 | 1,737,013 vs 1,746,467 | 10 | 26 | 0.9219 | 0.9219 | no |

Both poly arms use more tokens per delivered task than arm 1 on every task and fewer than arm 2 on every task. Arm 3's tokens are 3.5 times arm 1's and arm 4's 3.5 times, above the win rule's limit of twice arm 1's.

**O1-R failures (secondary, M3-10, in no rule).** Arm 3 0.64 and arm 4 0.72 per delivered task, arms 1 and 2 0.00. p is 1.0000 for arm 3 against arms 1 and 2, 0.5000 for arm 4 against arms 1 and 2, and 1.0000 for arm 4 against arm 3. All of them are T3 and T7 runs, the same runs as the escaped defects.

PT13 asks for effect sizes and intervals for a result between the rules. The frozen script computes the means and the tests above and no interval, so none is reported here.

### 2.3 The S117 effect check

The sensitivity analysis drops the five tasks whose family a worked example in an arm's material models (S115: T1, T2, T3, T4 and T6) and keeps T5, T7, T8, T9 and T10. Over five tasks the smallest exact two-sided p is 0.0625, so its comparisons are descriptive only (S117).

| Over T5, T7, T8, T9, T10 | Arm 1 | Arm 2 | Arm 3 | Arm 4 |
|---|---|---|---|---|
| Escaped defects per delivered task | 0.00 | 0.00 | 0.00 | 0.08 |
| Tokens per delivered task | 552,594 | 4,527,308 | 1,866,149 | 1,890,017 |

At least 30% below arms 1 and 2: arm 3 `false`, arm 4 `false`. The five descriptive comparisons all have p 1.0000.

### 2.4 Secondary measures

Means over the ten tasks of the per-task means, as the script's table gives them.

| Measure | Arm 1 | Arm 2 | Arm 3 | Arm 4 |
|---|---|---|---|---|
| Wall time per run | 169 s | 1,212 s | 263 s | 292 s |
| O2 properties violated per delivered run | 0.00 | 0.00 | 0.00 | 0.00 |
| O3 traces failed per delivered run | 11.8 | 11.8 | 33.4 | 33.4 |
| Regressions introduced per delivered run (O1 tests) | 0.00 | 0.00 | 0.04 | 0.04 |
| Regressions caught per delivered run (O1 tests) | 25.82 | 43.55 | 4.70 | 4.22 |
| Runs stopped by a cap | 0 | 3 (wall) | 0 | 0 |

The O3 counts are T10 version 3 in every arm (118 traces) and T1 in arms 3 and 4 (216 traces); section 4 records both. A regression is counted in O1 tests: one introduced is a test of an unchanged rule that passed at version n-1 and fails at delivery n; one caught failed on a snapshot during a change and passes at delivery.

The per-run score tables (O1, O1-R, O2, O3, wall time and tokens per arm, one per run number) were sent with each report and are computed from the same records.

## 3. Deviations

These are the departures from the plan as frozen. None changes the analysis script, and each is in `docs/plan-m3.md`.

### 3.1 The runner's cleanup, from block 40

Blocks 1 to 39 ran without it and blocks 40 to 50 with it (ruling after block 39, `37beede`; built in `c08f9ca`, frozen in `b8a8cfb`). Each run's processes are held in a Windows job object. What still runs when the run ends, on its own or at a cap, is listed in `run.json` as leftovers and ended with its tree, never between turns; the workspace is then deleted with retries, and a failed deletion is recorded instead of crashing the runner. In blocks 40 to 50, two runs had leftovers, both stopped by the wall cap: T2-arm2-run5 (14 processes, arm 2's checks on mutants among them) and T4-arm2-run5 (8, polygraph's checker among them). Every workspace was deleted at the first attempt. In blocks 1 to 39, the runner crashed twice deleting a workspace after writing a complete `run.json` (T9-arm2-run2 and T9-arm2-run4), and one backgrounded command outlived its run into the next block (section 4.4).

### 3.2 The scorer's timeout

A suite stopped by the scorer's 30-minute timeout is now recorded as not scored (timeout) and scored again, never as a failed test (ruling after block 39; `runner/score.mjs` is in the frozen runner part). Scoring ran 4 runs at a time. No suite hit the timeout in any of the 200 runs: no run was scored again for that reason, and the 79 runs first scored 12 at a time under the old scorer came out byte-identical under the new one. Ten runs scored again to test determinism came out byte-identical.

### 3.3 The overlap flags

Each block records the processes outside it that looked like tests or a review, sampled every 30 seconds, and each flag carries a classification, its raw record kept. Nine blocks are `genuine`: blocks 1 and 2 (the M5b worktree's commits, flagged by hand), block 22 (another session's polywatch review), and blocks 40, 42, 43, 45, 46 and 47 (polywatch reviews: in blocks 40 and 45 of this session's own commits, otherwise of other sessions of the owner). The other flagged blocks are `arm-own`: the arms' own test runs, which the earlier check could not tell apart. No block is dropped (ruling after block 39).

| Wall time per run | Arm 1 | Arm 2 | Arm 3 | Arm 4 |
|---|---|---|---|---|
| All 50 blocks, mean (median) | 169 s (165) | 1,212 s (670) | 263 s (251) | 292 s (270) |
| Without the 9 genuine blocks, mean (median) | 164 s (162) | 1,181 s (693) | 254 s (235) | 281 s (264) |

Mean tokens per run change by at most 0.01 million in any arm without the genuine blocks.

### 3.4 The runs stopped by a cap

| Arm | Stopped | Which |
|---|---|---|
| 1 | 0 of 50 | |
| 2 | 3 of 50, all by the wall cap | T9-arm2-run4 (block 39), T2-arm2-run5 (block 42), T4-arm2-run5 (block 44) |
| 3 | 0 of 50 | |
| 4 | 0 of 50 | |

Each stopped during its last change (version 3), stays recorded as stopped and is never rerun. Its version 3 is not delivered within budget, so the run counts as not delivered. No run reached the token or dollar cap.

## 4. Observations already recorded

These were recorded in `docs/plan-m3.md` as the runs were scored. They are reported here as observed and are not part of any rule.

### 4.1 T3: range refusals

Three poly runs fail 26 O1 tests and 16 O1-R tests each, the same tests in all three: arm 3 in runs 2 and 4, and arm 4 in runs 2 and 5. A capture or a refund of 0 or of a negative amount is accepted, a refund of 3 units is accepted when 3 were captured, and some random command sequences break the brief's money limits. These are T3's escaped defects in section 2.1. The one escaped defect elsewhere is T7-arm4-run1: `taskTimeout` is not refused for a task other than 0 or 1 (versions 2 and 3, 2 O1 and 4 O1-R tests).

### 4.2 T1: the refund that needs no answer

In every T1 run of arms 3 and 4, O3 fails 216 traces (24, 54, 60 and 78 over the four versions). Both arms emit the refund of a cancelled paid order as an effect that stays pending at the effect port, where the brief says the refund "is counted, and needs no answer"; the reference and the TypeScript arms only count it. O1 has no test of it, so it is no escaped defect. Poly can declare an effect with no completion, but through the effect port every emitted effect stays pending until it is completed, and the frozen manual shows no effect without completions.

### 4.3 T10 version 3: the brief says two things

In every T10 run of every arm, O3 fails the same 118 of 164,502 traces of version 3. A client that cancelled its request receives a grant whose token was already revoked. The base brief says such a client becomes idle; change 3 says an abandoning client that receives a grant gives the lease straight back. The reference follows the first rule and every arm the second. The service ignores the release and answers `Released`, after which the client is idle as in the reference. O1 and O2 pass, so it is no escaped defect.

### 4.4 Arm 2's backgrounded commands and wall times

Arm 2 alone moved shell commands to the background after its Bash timeout: 31 commands in its 50 runs (21 in blocks 1 to 39, 10 in blocks 40 to 50); arms 1, 3 and 4 moved none. Its long commands were polygraph's checker and exhaustive tests. One outlived its run: T9-arm2-run2's `npm test` (block 19) wrote until 614 s after the run ended and overlapped block 20; from block 40 the runner ends such commands at the end of the run. Arm 2's wall time per run is the longest and the most spread (mean 1,212 s, median 670 s, against 169, 263 and 292 s for the other arms), its three cap stops are all on the wall cap, and its T2 runs 2 and 3 ended within 225 s of it (3,378 and 3,386 s).

## Conclusion

All 200 runs of M3 are recorded and scored, and the pre-registered analysis, run as frozen, returns **between**. Neither poly arm reduces escaped defects against arms 1 and 2, which had none in any delivered run; arm 3 had escaped defects in two runs and arm 4 in three, on T3 and T7, and no comparison of escaped defects is significant. Both poly arms delivered an admitted program in every run, so the stop rule does not fire. Both used significantly more tokens per delivered task than arm 1 (3.5 times) and significantly fewer than arm 2, and they did not differ from each other. The surface rule returns embedded, on a token difference of 0.5% between arms 4 and 3 that is not significant. The S117 effect check holds for neither poly arm. The deviations (the runner's cleanup from block 40, the scorer's timeout, nine genuine overlap blocks, three wall-cap stops in arm 2) are reported beside the result; none changes the analysis script. The observations on T1, T3 and T10 and on arm 2's commands are reported as observed.

## Glossary

- **Admitted:** a delivered poly program whose `poly check` verdict is CLEAN.
- **Arm:** one of the four ways the agent works (TypeScript alone, TypeScript then polygraph, poly standalone, poly embedded).
- **Block:** the four arms of one task and run number, started together.
- **Cap:** a per-run limit on tokens, wall time or dollars; a run a cap stops is recorded as stopped and never rerun.
- **Delivered within budget:** every version of the run built an implementation and no cap stopped it.
- **Escaped defect:** a failing O1 test at delivery, the primary measure.
- **Freeze:** the SHA-256 of every file of the experiment in `experiments/m3/freeze.json`; a change after it is a deviation.
- **Genuine (overlap):** a process outside the block that no arm started, such as another session's review.
- **Holm correction:** the step-down correction of p-values over the five comparisons of a family.
- **Job object:** the Windows object that holds a run's processes so that they can be listed and ended together.
- **Modelled task:** a task whose family a worked example in an arm's material models (S115).
- **O1, O1-R, O2, O3:** the scenario tests (primary), the range-refusal tests (secondary), the hidden invariants and the reference traces.
- **Regression introduced or caught:** an O1 test of an unchanged rule that fails at delivery, or that failed on a snapshot during a change and passes at delivery.
- **Wilcoxon signed-rank test:** the paired test over the ten tasks, exact and two-sided.
