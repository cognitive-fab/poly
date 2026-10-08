# Experiment: strict by default, and the M3 range trap

Status: ruled by the owner's reviewer (2026-10-07). Ids: `SR`. Runs after the M10 and M11 merge, before the v1 release. It feeds the research article.

M3 found one trap behind most poly defects (decisions-m3, M3-7 and the M3 close): a check domain on a parameter reads like a constraint, but PT3.4a makes it one only when the value reaches an irreversible or compensable effect. Four T3 runs and one T7 run accepted out-of-range commands. This experiment makes `strict` the default everywhere and measures whether the trap closes.

## SR1. The language change (S400)

- **S400, ruled.** PT3.4a is amended: the default mode is `strict` for every action parameter and field that has a check domain. `disclosed` applies only where written. `PL1301` (an explicit `disclosed` on a value that flows into an irreversible or compensable effect) stays, and still needs a person's acceptance.
- PS and PT text first (rule 7a). An implicit `strict` on an action with no handler raises no `PL1302`; only an explicit one does.
- The 159 measured files are run before and after. Any verdict that changes is listed with the reason. Such a change is expected only where a program relied on the old default, and it is a reason to stop and bring the list.
- The manual gets one paragraph: domains refuse by default; write `disclosed` to accept values outside the domain and only report them.

## SR2. Part 1: the counterfactual, no model call

- The five defective M3 deliveries (T3-arm3-run2, T3-arm3-run4, T3-arm4-run2, T3-arm4-run5, T7-arm4-run1) are recompiled with the M3 frozen toolchain (b8a8cfb) plus the S400 patch, and nothing else changed, so the default is the only difference.
- O1 and O1-R are run on each, as frozen.
- **Expected:** the range tests that failed now pass, because the commands are refused at dispatch. Any test still failing is reported with its cause.
- All 45 other poly deliveries of T3 and T7 are rerun the same way: none may lose a passing test.

## SR3. Part 2: the live rerun

| | |
|---|---|
| Cells | T3 and T7, arms 3 and 4, five runs each: 20 runs |
| Runner, model, caps, oracles | as frozen for M3 (claude-opus-5-5 through the claude CLI on the subscription; 15,000,000 tokens and 3,600 s per run; O1 primary) |
| Toolchain | M3 frozen toolchain plus the S400 patch, and the manual with the SR1 paragraph |
| Primary measure | runs with at least one escaped O1 defect |
| Comparison | the same 20 cells in M3, which had 5 such runs (T3: arm 3 two, arm 4 two; T7: arm 4 one) |
| Test | one-sided Fisher exact test on runs with defects, 0.05. Zero of 20 against 5 of 20 gives p = 0.024; one of 20 gives p = 0.09, which is reported as not significant |
| Also reported | escaped defects per delivered task, admitted runs, tokens per delivered task, beside M3's values for the same cells |

This is a follow-up to M3, pre-registered here before it runs, and outside M3's freeze. M3's verdict is not reopened.

## SR4. Acceptance

| Id | Criterion |
|---|---|
| SR-AC1 | S400 is in PS/PT before the code, and the measured verdicts are compared before and after. |
| SR-AC2 | Part 1 reports, for each of the five deliveries, every O1 and O1-R test before and after. No test of the other 45 deliveries goes from pass to fail. |
| SR-AC3 | Part 2's 20 runs are recorded and scored like M3's, with the analysis as a script beside M3's and its command and output hash in a report. |

## Conclusion

The trap that explains most of M3's poly defects is a default, and a default can be changed. Part 1 shows, with no model call, whether the change alone would have stopped those defects. Part 2 shows whether agents writing under the new default still leave them.

## Glossary

- **Disclosed:** a check mode in which values outside the domain are accepted at run time and reported.
- **Escaped defect:** a failing O1 test in a delivered program.
- **Strict:** a check mode in which values outside the domain are refused at dispatch, so the checked domain is the running domain.
