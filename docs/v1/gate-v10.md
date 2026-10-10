# The V10 gate · checklist

Written by the release session on 2026-10-10, against `plan-v1.md` ("V10. The v1 gate"), on `v1` at 0be8ef61. It marks what is met on the release branch now, what waits on the examples branch (E1, the concierge; E2, the inbox), and what only the gate run itself can give. The gate runs from a clean build, on a quiet machine, after both branches are merged into m4 (release first, examples rebased on it). Nothing here is the gate. It is the list the gate run will be checked against.

## Before the gate

| Condition | State | Evidence or what waits |
|---|---|---|
| V1 to V9 accepted | **Met** | decisions-v1.md, "V1 to V9 accepted" (fec4337f..3f539a47). |
| The rulings after V9 built and accepted | **Met on v1**, the last record awaiting acceptance | The S450 to S455 round, F4, F3, the work-order key, S456, S457, the S454 embedded form, the one-value rule, S458, S459 with its five choices, the examples' harness, (a), S460, (c) and the `Items` type check are all built and recorded. The last record, 0be8ef61, has its two choices accepted. |
| E1, the concierge (AC15, AC18, AC22, AC27, AC30) | **Waits on E1** | On `ex` the module checks `CLEAN` at `0..500` in 6 min 27 s, and the release session's probe 7 checked it in 69 s. Still to come: its check with the policy, its move to `examples/concierge/` (the harness fix, c6c6b9fe, allows it), its after-suite run in the serial group (c7af49be), and AC27's replay. |
| E2, the inbox (IAC1 to IAC9) | **Waits on E2** | On `ex`: IAC1 and IAC4 pass, and IAC3, IAC5 to IAC8 and IAC9's check are next. It needed S459 (drafts), S460 (the read grant, or the host vault of Q-EX8) and (a) (one source per retrieval kind), all now on `v1`. |
| The examples branch rebased on v1 | **Waits on ex** | `ex` is rebasing on 0be8ef61 and running its suite, as ordered on 2026-10-10. |
| Both branches merged into m4 | **Waits** | Release first, then the examples rebased on it. |

## The gate (plan-v1.md, V10)

| # | Item | State on v1 now | At the gate |
|---|---|---|---|
| 1 | The full suite and the after-suite: no failure | **Met on v1.** At c0e99891 there were 2,292 tests and 7 in the after group, all passed but 2 skipped and 4 waiting, with no failure (`.poly/logs/c0e99891-2026-10-10T12-31-21-167Z-w8.log`). The 4 waiting tests wait on engine fixes, among them polyrun's tombstones at archive (S124). | Run again from a clean build after the merge, alone on the machine, with the examples and their serial group included. |
| 2 | check-memory passes | **Met on v1** (the same run). | Run again with item 1. |
| 3 | The measured programs: every verdict identical to the one recorded after V1, or changed with a ruled cause | **Met up to S458.** The baseline is `docs/v1/verdicts-after-rulings.json`; it differs from `verdicts-after-v1.json` only in 3 transition counts, caused by b6318b4c and ruled. It was measured identical after S456 and after S458. **Not measured since S459**: S459, S460, (a), (c) and the `Items` type check have no heavy run allowed now. | Measure the 160 files and compare with `verdicts-after-rulings.json`, then list any change with its ruled cause. Add the concierge and the inbox as new entries, with no baseline. |
| 4 | Every example checked `CLEAN` and its journal replayed | **Ruled (see below); met for the 20 files on `v1`.** Each states its expected verdict on its first line, and each verdict matches it (`test/examples-expected.test.mjs`): 9 are `CLEAN`, and 11 are teaching variants or field studies whose findings or bounds they state. | The concierge and the inbox checked `CLEAN` with their policies, and their journals replayed (AC27). |
| 5 | Per-file times compared with `docs/m11/gate2-file-times.json` | **Waits on the gate run.** The last suites show the slowest file near its usual time: the staff-documents test took 410 s in w7 and 525 s in w8. | Compare `.poly/file-times.json` and `.poly/file-times-after.json` of the gate run with `gate2-file-times.json`, and name each file that moved by more than its usual spread. The serial group's concierge files are new. |
| 6 | The release notes complete | **Complete for the release branch, in both pages.** `docs/release-notes-v1.md` and `docs/release-notes.md` carry every ruling to the provider's revocation, with its limits and the After v1 list. E1's entry holds what is known: the module and both configurations `CLEAN` at the reported counts. E2's entry waits. | Complete E1 with its policy check, its serial-group run and its replay; fill in E2. |
| 7 | A record in `decisions-v1.md` | **Waits on the gate run.** | The gate's record: commits, suite, measured verdicts, file times and the examples. |

Then main is fast-forwarded to m4 and tagged `v1.0.0` locally (Q-V1). The owner pushes and publishes.

## Item 4, as ruled (owner's reviewer, 2026-10-10)

The release session's reading is accepted. The concierge and the inbox are each `CLEAN` with their policy, and their journals replay. Every other example's verdict equals its recorded one, under item 3.

**Added:** every file in `examples/` begins with `// expected: CLEAN | FINDING <code> | INCONCLUSIVE <reason>`, and the gate compares each verdict with that line, so nobody has to know which files are teaching variants. `test/examples-expected.test.mjs` does it for the parallel suite, and `test/after/serial-sources.test.mjs` for the serial group's examples. `examples/README.md` states the line.

## Conclusion

On the release branch, items 1 and 2 are met, item 3 is met up to S458, and item 6 is drafted. Items 3, 5 and 7 need the gate run itself, after the merge. Item 4 is ruled and met for the files on `v1`; it waits on E1 and E2 for the two release examples. Nothing on the release branch is known to block the gate: what remains is the examples branch's two examples, then one gate run alone on the machine.
