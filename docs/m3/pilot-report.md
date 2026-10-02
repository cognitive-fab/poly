# M3 pilot report: P1, one run per arm

The four pilots ran on the practice task P1 (book loans: a base version and one change) with the freeze at `d1cba58` and the gate `experiments/m3/PILOT` (`ab9d2d0`). Their records are in `experiments/m3/pilots/`, scored from a shell without the key. This report gives each pilot's cost, time and tokens, what in the records looks off, and a proposed budget for the 200 runs. FROZEN is not written.

## How they ran

- **Not all at the same time.** Arm 1 ran alone (11:18:15 to 11:19:40 UTC on 2 October 2026) and finished before the others started. Arms 2, 3 and 4 ran concurrently (11:21:37 to 11:26:16).
- **Authentication failures.** Three pilot attempts failed to authenticate, as the operator reported, and were rerun. They are recorded here as authentication failures, not as results (decisions-m3, `aad9a23`). They left no record: the runner deletes a run's directory when the same run starts again, so the folders hold only the reruns. The time each key was created was not given to this session and should be added by the owner.
- **The key.** No file under `experiments/m3/pilots/` contains `sk-ant-`, before or after scoring. Scoring ran in a shell with no key set.
- **The scrub changed the permission mode.** The operator's windows set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, as the commands this session gave said. The CLI then printed, in every turn: "Permission mode forced to default: CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set". The pilots therefore ran in `default` mode, not the `dontAsk` the runner passes. In print mode both deny a tool outside the allowed list without asking, and the journals show only such denials, but the pilots did not run exactly as the frozen runner intends. The scrub is not used for the full runs (`aad9a23`), so they run in `dontAsk`.

## Results

Cost is the CLI's own figure at list price (`costBasis: list`). The CLI reports it cumulatively over a resumed session, so a run's cost is its last turn's figure. Tokens are the CLI's, from the last turn's `modelUsage`. Every pilot completed both turns (exit 0, `terminal_reason: completed`, within budget), delivered both versions, and passed O3 (60 and 90 traces) with no O2 violation. Arms 3 and 4 were admitted on both versions (`poly check` CLEAN, the adapter builds). P1 has no O1 suite and no O1-R entry, so neither ran.

| Pilot | Cost | Turn 0 / turn 1 | Wall time | Input | Output | Cache read | Cache write | Tokens (CLI) | Tokens (runner) |
|---|---|---|---|---|---|---|---|---|---|
| arm 1 | $0.20 | $0.13 / $0.07 | 85 s | 26 | 6,498 | 63,836 | 12,045 | 82,405 | 210,989 |
| arm 2 | $1.13 | $0.81 / $0.32 | 250 s | 66 | 23,421 | 1,545,508 | 70,653 | 1,639,648 | 4,046,257 |
| arm 3 | $0.48 | $0.33 / $0.16 | 117 s | 44 | 8,535 | 535,596 | 40,693 | 584,868 | 1,412,453 |
| arm 4 | $0.47 | $0.35 / $0.13 | 155 s | 42 | 8,963 | 488,954 | 39,117 | 537,076 | 1,384,337 |
| all four | $2.29 | | 607 s | | | | | | |

## What looks off

1. **The runner miscounts tokens.** It adds the `usage` of every `assistant` event in the stream. The CLI emits one such event per content block, each repeating its message's usage, and the output count in them is partial. The runner's totals are 2.4 to 2.6 times the CLI's, with cache reads counted several times and output undercounted by a factor of 10 to 30. This affects the S99 token measure, the four parts in `run.json`, and the budget cut-off, which would stop a run at about 40% of the tokens the cap intends. The CLI's `result` event carries the turn's usage and cost. The fix is to record those and keep the per-event sum only as an estimate for stopping a turn mid-way, deduplicated by message id. It changes the frozen runner, so it needs a ruling and the regeneration of the freeze.
2. **"Diagnostics seen" counts the manual.** For arms 3 and 4, `toolchain.codes` counts every `PL` code in any tool result, including the agent reading the technical spec (arm 3 shows 28 distinct codes and arm 4 shows 17, among them `PL5401 CONFIGURATION_INVARIANT`, which a module of one machine and no configuration cannot raise). It should count only the output of `poly` commands. This changes the scorer.
3. **Denied commands.** Every arm first tried to write files with shell heredocs or the `PowerShell` tool, which the allowed tools refuse (`Bash(node *)` and the like), then used `Write`. Denials per run: arm 1 three, arm 2 six, arm 3 six, arm 4 four. They cost a few turns in every arm alike and are working as designed; the `PowerShell` tool exists only on Windows.
4. **The workspaces' own tests.** Arms 1 and 2 added a `tsconfig.json` and tests outside `src/`; only `src` (and `host.map.json` for arms 3 and 4) is delivered, so they are not scored. This is as designed.

## Proposed budget

P1 has two versions and one machine; a task of the ten has four versions, and five are multi-machine. At P1's difficulty, a run of base plus three changes would cost the base turn plus three change turns: on the pilots' means, $0.40 + 3 × $0.17 = $0.91. Allowing two to three times that for the harder tasks gives about $1.80 to $2.70 per run on average, with arm 2 the costliest (about twice the mean, as on P1).

| | Per run | 200 runs | 120 runs |
|---|---|---|---|
| Expected cost | about $2 to $3 | about $400 to $550 | about $250 to $330 |
| Cap (`--max-budget-usd`) | $15 | $3,000 ceiling | $1,800 ceiling |
| Token cap, counted as the CLI counts | 15,000,000 | | |
| Wall-time cap | 1 hour | | |

The caps are about three times the costliest run these figures predict (arm 2 on a hard task: about $5, 5 million tokens, 15 to 20 minutes), so an ordinary run never meets them, and the ceiling bounds the worst case. The token cap only works as intended once the runner counts tokens as the CLI does (item 1); with the current count it would stop runs at about 6 million real tokens.

## Conclusion

All four pilots completed both turns, delivered, passed O3 and O2, and the poly arms were admitted on both versions, for $2.29 in all and under five minutes each. Three attempts failed to authenticate and were rerun; they are recorded as authentication failures. No pilot record contains a key. Two measurement defects need a ruling before FROZEN: the runner's token count, which is 2.4 to 2.6 times the CLI's and drives the budget cut-off, and the scorer's count of diagnostics seen, which includes the manual. The pilots ran with the permission mode forced to `default` by the scrub; the full runs will not. The proposed budget is $15, 15 million tokens and one hour per run, with an expected total of about $400 to $550 for 200 runs and a ceiling of $3,000.
