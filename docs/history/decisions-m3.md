# poly · Decisions before M3

*Cognitive Fab · September 2026 · the first experiment (PT13)*

M2 is closed. These rulings settle what the experiment needs before any run. PT13 is amended in the same commit.

| Id | Question | Ruling | Spec change |
|---|---|---|---|
| **M3-1** | PT13 has the primary oracle (O1) written by a person who has read the brief and not seen any reference machine. Who writes it? | **An independent agent session.** A separate Claude session receives only the ten briefs and their host interfaces, with no access to the poly repository, the reference machines, O2, O3 or any arm's output, and writes the O1 scenario suites. Its prompt and its inputs are kept with the results. The report states that O1 was written by an agent of the same model family as the arms, as a limitation. | PT13 (Oracles) |
| **M3-2** | Three tasks must involve machines that talk, and a poly module that sends cannot run under polyrun. | **The `sendTo` change lands first.** It is made in polygraph (polyrun), approved here: the `sendTo` intent; the `{ "$ref": "self" }` marker resolved to the sender's instance id; child addresses resolved at commit (S78). The K9 refusal of an outside dispatch of a child's completion is made in the same change. `createInstance` is made only if a task uses detached children; the task set says so. Then polygraph is re-vendored with its provenance, as for S36. | PT18 M3 row (prerequisite) |
| **M3-3** | Typed fixes exist only on the standalone surface (S70), which would favour arm 3 over arm 4. | **Fixes on the embedded surface first.** The six fixes of S70 apply to embedded modules too, with the same preconditions and the same random-order test. Both poly arms then get the same help, and the surface decision compares the surfaces, not the tooling. | PT12.1 |
| **M3-4** | PT13's poly arms implement the host interface "with a thin generated adapter over the runtime API", which arrives in M4. | **An adapter over polyrun's kernel.** For M3, the generated adapter drives polyrun's kernel directly, as the S68 harness does, and the report says so. M4 regenerates it over the runtime API. | PT13 (Tasks) |
| **M3-5** | When is the experiment fixed? | **Before any run, by digest.** The briefs, host interfaces, reference machines, O1 to O3, the controls, the runner, the prompts, the budgets and the analysis script are committed, and their digests are recorded in `docs/history/plan-m3.md`. Any change after that is reported as a deviation. No arm runs until I have approved the frozen set and the budget. | PT13 (Analysis) |

## Rulings on the M3 plan (S87 to S93)

| Issue | Ruling | Spec change |
|---|---|---|
| **S87** My uncommitted work in the polygraph checkout | **Accepted.** Make the polyrun change in a separate worktree, on a branch `m3-sendto` cut from `583b82c`. Bump the patch version there, vendor from that branch's commit, and record the branch and commit in `PROVENANCE.md`. Merging into polygraph's main is mine. My working tree is not touched. | none |
| **S88** How K9's refusal behaves | **Accepted, with an audit record.** An outside dispatch of an action wired as a child's completion is refused before any step, with no journal row, because PS7.1 does not offer that stimulus and no step exists. The refusal returns an error to the caller naming K9, and it is written to polyrun's audit log, so a refused attempt is observable without being a step. | PS10 (K9) |
| **S89** How polyrun delivers a message | **Accepted.** An outbox row keyed `<sender>:<seq>:<position>` is PS13.2's message identity, and the receiver's dedupe on it for the life of the instance is K4. There is no fixed delivery order: unordered is the default of PT9.8, and `fifo` needs the in-order worker. A send to an unknown instance goes to the dead-letter list and is journaled on the sender's run. Tests and the adapter may deliver one message at a time. | PT7a; PT9.8 |
| **S90** A `host.map.json` for the generated adapter | **Accepted, with one change: the agent writes it.** In the poly arms, `host.map.json` is part of the delivered solution: the agent decides which machine and action each host method drives, as the TypeScript arms decide how to implement the same interface. The adapter generator validates it, and a map that names a machine or action that does not exist is a failed build. Providing it to the poly arms would give them a design the TypeScript arms must make themselves. | PT13 (Tasks) |
| **S91** A network API in multi-machine host interfaces | **Accepted, for every arm.** A multi-machine task's host interface includes `inFlight()`, `deliver(id)` and `deliverAll()`, in the brief, for all four arms. O1 tests arrival orders only through it. The TypeScript arms must implement messages that can be held and delivered in any order; the poly arms' adapter implements it over polyrun's outbox (S89). Without it, the defect class the configuration check targets could not be observed in arms 1 and 2, and the comparison would be unfair to them. | PT13 (Tasks) |
| **S92** Oracles for each evolution change | **Accepted.** Each of the three changes of each task gets its own brief delta, reference machine, mutant, O2 and O3. Its O1 comes from the same independent session (M3-1), which receives the change briefs in order, never the references. | PT13 (Evolution) |
| **S93** PT18 after M3-2 | **Accepted.** PT18's M3 row lists the polyrun change (`sendTo`, address resolution at commit, the K9 refusal) as a prerequisite. The M5 row keeps what remains of `sendTo delivery in polyrun`: the gate proposing cross-scope sends and `SendDenied` (PS8.7, PT9.9). | PT18 |

Steps 1 and 2 can start. The task set starts after S90 to S92 are reflected in the task template.

## Rulings on the frozen set (S94 to S99), and the next steps

| Issue | Ruling |
|---|---|
| **S94** Multi-machine briefs name their messages and effects | **Accepted.** Every arm gets the same brief, so naming the messages helps all four equally. |
| **S95** Effects and timers | **Accepted as applied.** T1 (`payment.charge`) and T3 (`card.authorize`) have effects, through the effect port every arm shares (`pendingEffects`, `completeEffect`). Timers stay out of the task set, for the reason the plan gives; the report lists it as a limitation. |
| **S96** What a win requires | **Accepted.** Both the 30% reduction and a Holm-corrected p below 0.05 against arms 1 and 2. A reduction without significance is reported as it is, never as a win. |
| **S97** Reference traces | **Accepted.** One trace per transition in every version, and every mutant re-verified against them. |
| **S98** T9 limited to one election round | **Accepted,** as the brief states. |
| **S99** Tokens | **Accepted.** Input, output, cache-read and cache-write tokens are recorded separately; their sum is the primary measure, and cost at list price is secondary. |

**An observation for the report, not a change to the frozen set.** T10's defect (a revocation overtaking its grant, leaving a client holding an expired lease) was found by O2, not by poly. A configuration invariant cannot express it. A liveness property such as "a revoked lease leads to the client not holding it" could have, and T2's references carry liveness properties while T10's do not. The report records that poly's checks find what the properties written for them say, and this case is listed with T2 and T7 as one where checking the reference changed the design. A `quiescent` predicate for configuration invariants ("no message in transit") is a candidate for after M3.

**Order of the next steps.**

1. The O1 session (mine), then control 4. Nothing else runs until control 4 passes on all 40 versions.
2. The four pilot runs on P1 (`experiments/m3/PILOT`), one per arm. They replace the cost assumptions with measured token counts and set the per-run budget.
3. The budget decision, from the pilots' numbers: the per-run token cap, the wall-time limit and the total spend. If the total is too high, the first lever is three runs per task per arm instead of five (120 runs); the model is not changed, because the question is about the model agents use.
4. `experiments/m3/FROZEN`, after `freeze.mjs --check` reports no change.

**S100 The toolchain is not in the freeze (found on review).** `freeze.mjs` digests the tasks, the O1 kit, the controls, the adapter, the runner, the prompts and the analysis. It does not digest the poly toolchain (`packages/`), the vendored engines (`vendor/`) or `package-lock.json`. Arms 2 to 4 run that toolchain, so a change to it after the freeze would change three arms without changing any digest. **Ruling:** add a part `toolchain` covering `packages/` (sources only, no build output), `vendor/` and `package-lock.json`, and record the git commit in `freeze.json`. Until M3's runs are finished, nothing under `packages/` or `vendor/` changes. Work that does not touch them (proposals, reviews, evidence scripts under `docs/`) may continue. Step 4 above waits on this part.

**S114 The manual is not in the freeze (found by Claude Code).** The poly arms receive `README.md`, `docs/03-technical-spec.md` and `docs/04-semantics.md` as poly's manual, and no part covers them. Commits 3ad3b52 and a5ccf4b changed the spec after the freeze, so the arms would read about `PL1207` and vacuous verdicts that their frozen toolchain does not enforce. **Ruling:** add a part `manual`. Snapshot the three files **as of the freeze commit 04c62e8** (`git show 04c62e8:<path>`), not as of today, into `experiments/m3/manual/`, and have the runner copy from the snapshot only. The manual then describes exactly the toolchain the arms run. Also list every file the runner copies into any arm's workspace, and confirm each one is in a part; a file outside every part is a defect of the freeze. A regression test fails first: a changed byte in a snapshot file changes the `manual` part, and a change to `docs/` changes no part. This touches `experiments/` only. JJ's step 4 (FROZEN) waits on it.

**S114 done (3b6106c).** Accepted as built: the manual snapshotted at 04c62e8, the three new parts (examples, toolchain build, arm 2 polygraph), `.tsbuildinfo` left out, and the copy list in `plan-m3.md`. Freezing the new groups in place rather than snapshotting them is accepted.

**S115 The manual carries worked examples of task families.** The runner leaves out the examples that model a task family, but the manual itself does not. The spec given to arms 3 and 4 holds a `machine Order` lifecycle (PT4 and PT10) and the `checkout` configuration of PT7a, an order and an inventory talking by messages, with the optimistic race and its fix. These are close to T1, T2 and T4. Arms 1 and 2 get nothing comparable. **Ruling:** the manual is not edited. It is poly's documentation, and every user of poly gets it. Instead:
1. List every worked example in the material each arm receives (the manual for arms 3 and 4, the polygraph archive for arm 2), and map each to the tasks whose family it models. Record the list in `plan-m3.md`.
2. Pre-register a sensitivity analysis in `analyse.mjs`: the primary comparison over all ten tasks, and the same comparison over the tasks no arm's material models. Both are reported. A win that holds only with the modelled tasks is reported as such, never as a win.
3. Test it on synthetic records where the two answers differ.

**S116 The environment is not recorded.** The freeze pins files but not the Node version, the `claude` CLI version, the model id or the operating system. Every arm shares them, so they do not bias a comparison, but a run cannot be reproduced without them, and a CLI update between runs would change all arms mid-experiment. **Ruling:** `freeze.json` records them, and the runner refuses a run (pilots included) when any of them differs from the record. The model id is the exact id passed to the CLI, never an alias.

JJ's step 4 (FROZEN) waits on S115 and S116.

**S115 and S116 done (a13d48f).** Accepted as built. The mapping of T3 and T6 as modelled is accepted: counting a doubtful task as modelled is the conservative side for the poly arms. The environment record is accepted; the model id `claude-opus-5-5` is the owner's to confirm before FROZEN.

**S117 The sensitivity gate of S115 can never pass (my error).** Over five tasks, the smallest exact two-sided p of the signed-rank test is 2/32 = 0.0625, and with Holm over five comparisons a win needs at least eight tasks. As written, S115 makes every win impossible. **Ruling:** the sensitivity analysis is an effect check, not a second significance test.
1. Significance is decided once, by the primary comparison over all ten tasks, as S96 states: the 30% reduction and a Holm-corrected p below 0.05.
2. A primary win stands only if, on the unmodelled tasks (T5, T7, T8, T9, T10), the arm's mean escaped defects per delivered task is also at least 30% below the comparator's. Otherwise it is reported as "win only with the modelled tasks".
3. The subset's p-value is computed and reported as descriptive, never as a gate, with a note that five tasks cannot reach 0.05.
4. Tests on synthetic records: a win that holds on both, a win carried by the modelled tasks only, and a subset reduction just under 30%. The existing test recording the minimum p stays, as documentation.

JJ's step 4 (FROZEN) waits on S117.

**Control 4 (first run, after O1 was committed in bb929b2).** `o1-check.mjs` passes on all 40 suites. Control 4 passes on 32 versions and fails on 8: all of T3 and all of T6, where the suite fails on the reference. Every failing test sends a value outside a range the brief states and expects a refusal; the reference accepts it, because the range is declared only as a parameter type, which PT3.4a makes `disclosed` unless the value reaches an irreversible or compensable effect. O3 explores only in-range values, so controls 1 to 3 could not see it. The defect is in the references, not in O1. These rulings are numbered M3-6 to M3-9 so that the S-series stays with M4 (M4-0).

**M3-6 T3: the references refuse out-of-range amounts.** The brief is explicit: capture and refund take "1 or 2 units" (capture "1 to 3" from change 1) and are "Refused otherwise". Change 1 widens capture only, so a refund of 3 is refused in v1 to v3. **Ruling:** in every T3 reference, mark the amount parameters of capture and refund `strict`, so the runtime refuses an out-of-range amount before the handler (`outside-check-domain`). Keep each domain exactly as the brief of that version states it. Regenerate O3 for T3 and rerun controls 1 to 4 on its four versions. If a mutant stops failing, report it.

**M3-7 T6: a stated input range is a constraint, and the brief says so.** The T6 brief gives "(1 to 3)" for `maxTries` without "Refused otherwise". O1 reads the range as a constraint, which is the reading an engineer would make, and the reading this experiment adopts: a range the brief states for an input is the set of accepted values. **Ruling:** amend the T6 brief to make it explicit: "`submit(job, maxTries)`: creates the job, **queued**, allowed `maxTries` tries (1 to 3). Refused if `maxTries` is outside 1 to 3, or if a job with that id exists." O1 already tests this reading and stays valid. Mark `maxTries` `strict` in every T6 reference, regenerate O3 and rerun controls 1 to 4 on T6. The amendment is made before FROZEN, so it is part of the frozen set, not a deviation.

**M3-8 Audit every reference and brief for the same gap.** No other O1 test exposed one, but O1 may simply not have probed it. **Ruling:** list every action parameter, in every reference of every version, whose brief states a range or a set of values. For each: (a) if the brief says out-of-range is refused, the reference must refuse it (`strict` or a `require`); (b) if the brief states a range without saying what happens outside it, amend the brief as in M3-7. Report the list, the briefs amended and the references changed, with controls 1 to 4 rerun on every changed version.

**An observation for the report, not a change to the frozen toolchain.** The defect was written by the reference author, with the spec at hand: a type range on a parameter reads like a constraint, and PT3.4a makes it one only when the value reaches an irreversible or compensable effect. The poly arms will meet the same trap. The report must say so, and an escaped defect caused by a disclosed range is counted like any other. Making action parameters `strict` by default, or warning when a disclosed range guards nothing, is a candidate language change after M3.

**M3-9 O1 enters the freeze, and o1-check's parser is fixed.**
1. Add a part `O1` covering every file under `experiments/m3/o1/`. A changed byte in a suite changes only that part (test fails first).
2. `o1-check.mjs` lists LEAKS.md's two preamble paragraphs as flags. Fix the parser so it lists only the flags under each task and version, with a test that fails first on the current file.
3. Accepted: e4f936c (the model listed when a freeze has no environment record). Both polywatch findings on this run that you marked false are agreed false.
4. The T9 suites run up to about 3.5 minutes. Confirm that the scorer's timeout for O1 is at least twice the longest suite's reference time, and say what it is.

FROZEN waits on M3-6 to M3-9 and a clean control 4 on all 40 versions.

**M3-10 Closing M3-6 to M3-9 (from the progress report).**
1. **Accepted:** the M3-8 list (14 entries), `strict` on the listed parameters in references and mutants alike, the seven amended briefs, O3 unchanged in bytes, the O1 part, the o1-check parser, and the scorer's 30-minute O1 timeout.
2. **The adapter changed, so every version reruns.** The adapter generator is shared by all 40 versions and by both poly arms. Controls 1 to 4 rerun on all 40 versions after the adapter fix, not control 4 alone. The report states that removing the empty instance left by a refused creating command is the adapter's job, not the agent's, and that it applies equally to arms 3 and 4.
3. **O1 stays as written; the new range refusals get a separate, labeled check.** O1 was written from the briefs before M3-7 and M3-8 amended them, and its author removed out-of-range tests where the brief was silent (T2, T3 authorize). Its independence matters more than its completeness, so O1 is not edited or rewritten. The out-of-range refusals the amended briefs now state are checked by **O1-R**, generated mechanically from the M3-8 list through the host interface, the same in every arm. O1-R is reported as a secondary measure, beside O1, and never added into the primary count of escaped defects pre-registered in S96. The analysis script reports it separately, with a test.
4. **The environment rule is narrowed.** The runner keeps refusing a run when the Node version, the `claude` CLI version or the model id differs from the record. A change of operating system release is recorded in the run's record and reported, not refused: an OS patch does not change what the agent sees. Before FROZEN, the owner disables the CLI's automatic updates and pauses operating system updates for the duration of the runs; the freeze is then regenerated once, recording the pinned versions.

## M3-10 accepted, and the steps to FROZEN

**M3-10 is accepted** (3d0f877, be30381). Controls 1 to 4 pass on all 40 versions (160 of 160) with the adapter at 7378c3d, and no mutant stopped failing. O1-R is secondary as ruled: built mechanically from the M3-8 range list, the same in every arm, outside every workspace, feeding no rule, no verdict and no S96 count. A refused setup step skips the O1-R test rather than failing it, because reaching the starting state is O1's to measure. A version passes the controls only when all four are present and passed. A change of OS release is recorded, not refused.

**Removing the empty instance a refused creating command leaves is the adapter's job**, for arms 3 and 4 alike, and the report says so.

**Steps to FROZEN, in order.**
1. Pin the CLI: `"env": {"DISABLE_AUTOUPDATER": "1"}` in `%USERPROFILE%\.claude\settings.json`; `claude doctor` shows auto-updates disabled by that variable; record `claude --version`. Pause Windows updates for the run window.
2. Regenerate `freeze.json` once, with `--model claude-opus-5-5`; `freeze.mjs --check` then reports no change.
3. Pilots on P1 (`experiments/m3/PILOT`), then the budget, then FROZEN, then the runs.

**Authentication for the pilots and the runs: an API key.** The arms keep `--bare`, and the runner and the freeze (d1cba58) are unchanged. `--bare` accepts only `ANTHROPIC_API_KEY`, so every pilot and every run authenticates the same way, and the CLI reports each run's cost directly. The key is set by JJ in the environment of the shell that runs the commands. It is never written to a file in the repository, a settings file or a run record, and the M3 session never handles it. Dropping `--bare` for a logged-in configuration directory is rejected: it changes the frozen runner, and the cost would have to be reconstructed from token counts.

**The pilots (ab9d2d0).** The four P1 pilots run concurrently, each capped at 30M tokens, 3 hours and $60, and the pilot report states that they ran concurrently. Every key used for M3 is short-lived (3 hours), so no scrub of the arms' environment is required and the runner is not changed for it. The report records the time each key was created. A run that ends on an expired key is recorded as an authentication failure, never as a wall-clock timeout, and is rerun with a fresh key; it is not scored as a result.

## The pilot report (cf51a08), and the steps to FROZEN

**Accepted.** All four P1 pilots completed both turns for $2.29, with no key in any folder.

1. **Token count.** The runner's count is wrong and must be fixed before FROZEN. The recorded measure per turn is the usage and cost of the CLI's final result event. During a turn, the cut-off uses a running count that takes each message's usage once (by message id), not once per streamed part; at the end of each turn the running count must equal the result event's, or the run record says so. The test that fails first replays the four pilot journals and requires the recount to equal the CLI's figures.
2. **Permission mode.** The scrub is dropped (aad9a23), so the full runs use `dontAsk`. The report states that the pilots ran in default mode, and why it made no difference here.
3. **Diagnostics seen.** The scorer counts only codes in poly command output, never codes the agent read in the manual. A test that fails first uses arm 3's pilot journal (`PL5401` must disappear).
4. **Denied heredocs.** As designed; recorded, no change.

**Caps per run:** $6 (`--max-budget-usd`), 6,000,000 tokens (counted as in point 1) and 1 hour of wall time. A run stopped by a cap is recorded as stopped, never rerun with a higher cap. **The total is capped by the owner** with a spend limit on the M3 workspace in the Anthropic Console; the per-run caps are not a budget. The number of runs stays as the frozen plan states unless the owner's total requires fewer, which is decided before FROZEN.

**Concurrency.** The full runs go in blocks of four: one run of each arm, same task and run number, started together, so load on the machine falls equally on every arm. A block starts only on a key created for it.

**Order.** Fix points 1 and 3, each with its failing test; regenerate the freeze once; rerun the four P1 pilots as one block to confirm the counts; report. FROZEN is written only after that report is ruled.

## The full runs use the owner's subscription, not an API key

The owner's budget is $100 a month, so the runs use the owner's Claude subscription (Max 20x). This supersedes the API-key ruling (7c5d7e7) for the full runs and the confirming pilots.

1. **Isolation without `--bare`.** The runner starts each arm without `--bare`, with `CLAUDE_CONFIG_DIR` set to a dedicated folder outside the repository that holds only the login and a `settings.json` with `DISABLE_AUTOUPDATER=1`: no `CLAUDE.md`, memory, hooks, plugins, MCP servers or skills. Before each run the runner checks that the folder holds nothing else and refuses to start if it does. A test that fails first shows that an arm sees none of the owner's own setup: a marker placed in the owner's user `CLAUDE.md`, settings and skills never reaches the arm.
2. **No API billing by accident.** The runner refuses to start if `ANTHROPIC_API_KEY` is set or an `apiKeyHelper` is configured, so a run can never bill an API key.
3. **Cost.** Each run's cost is reported at list price from the token counts of the CLI's result events (as fixed in the previous ruling). Nothing is billed per token.
4. **Caps.** 6,000,000 tokens and 1 hour of wall time per run. The dollar cap is kept only if the CLI enforces it under a subscription; otherwise the token cap is the cut-off, and the report says so.
5. **Usage limits.** A run interrupted by the subscription's usage limit is recorded as `limited`, not scored, and rerun from the start, like an authentication failure: its wall time includes waiting and measures nothing. Blocks of four continue, so a limit slows every arm alike.

These changes join the token-count and scorer fixes in the one regeneration of the freeze. The four P1 pilots are then rerun as one block, on the subscription, to confirm isolation and the counts. FROZEN waits for that report.

**Runner fixes accepted (3110ae1, freeze f65bbef).** `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` are part of the arm's environment: the config folder alone let the owner's `CLAUDE.md` through, and the marker test proves the pair keeps it out. This holds only if no arm's own material is delivered through a `CLAUDE.md`; the report confirms that. The skill check rests on two facts, both asserted by the test: slash commands are off, and the `Skill` tool is in no arm's allowed tools. One call at a fraction of a cent settles whether the CLI enforces `--max-budget-usd` under a subscription.

## The subscription pilots (f227e86), the caps, and FROZEN

**Accepted.** All four P1 pilots on the subscription completed both turns, recorded counts equal the CLI's, and no part of the owner's setup reached any arm.

**Caps are raised so they do not bind.** On the subscription a cap is no longer a spending limit, and a cap that binds on one arm more than the others censors that arm's result. The caps per run are 15,000,000 tokens, $15 at list price and 1 hour of wall time. A run stopped by a cap is still recorded as stopped and never rerun; the report states, per arm, how many runs a cap stopped and which cap.

**Before FROZEN:** the folder check runs after every run as well as before, and a run during which anything was synced is unscored and rerun (test fails first). The caps above go into the plan. The freeze is regenerated once with both. No further pilots are needed: when `freeze.mjs --check` reports no change after that regeneration, FROZEN may be written, and the runs start in blocks of four as ruled.

## Hold after block 2: a sync into the arms' folder

The arms' folder gained `plugins/synced`, `skills/synced` and a new `.claude.json` at 21:25:52 UTC, two seconds after T2 arm 2 finished (21:25:50). No T2 run is marked unscored, so the after-run check either ran before the sync or did not see it.

**The runs stop until this is explained.** Block 3 does not start. The M3 session:
1. Keeps the synced folders as evidence (a listing with hashes in the run record), and leaves them in place until step 3 is done.
2. Finds which process wrote them, and when, from the journals and file times.
3. Checks, for every turn of every T1 and T2 run, the CLI's init event: whether any synced plugin, skill or MCP server appeared in what the model saw. A run whose model saw any is unscored and rerun.
4. Proposes a fix. A fix that changes the frozen runner or the arms' environment is a deviation, ruled before any further block and reported.
5. Then removes the synced folders, and the folder check passes before block 3.

**Hold lifted.** The sync came from a stray interactive session started at 21:25:51 UTC in the owner's login window, which still had `CLAUDE_CONFIG_DIR` set; it began after every block-2 run had finished and passed its check. No run is affected, and blocks 1 and 2 stand. The runner is not changed: its before-check refuses the folder, which is the protection. Before block 3 the stray session is closed, the variable cleared, the synced folders removed (their listing kept as evidence), and the folder check passes. The batch starts from a fresh window.

## After block 39: leftover processes and the overlap flags (2541bad)

**The runner fix is accepted as a reported deviation.** Arm 2's commands moved to the background by the CLI, and processes under `claude.exe` at a cap, outlive the run. They load the machine into later blocks and crashed the cleanup twice. From block 40, the runner tracks every process started under the arm's `claude.exe`, kills any still running with its whole tree when the run ends (never between turns, so what an arm sees within a run is unchanged), deletes the workspace with retries, records a failed cleanup instead of crashing, and lists the killed processes as `leftovers` in run.json. Built with a test that fails first; the freeze is regenerated once; the report states that blocks 1 to 39 ran without it and blocks 40 to 50 with it.

**For blocks 1 to 39**, the report reconstructs from the journals which backgrounded commands outlived their run and which later blocks they overlapped, and says whether those blocks' wall times differ.

**Arm 2's backgrounded commands** (21, against none in the other arms) are a behavioural result and go in the report.

**Overlap flags are reclassified, not cleared.** Each flag of blocks 4 to 39 keeps its raw record and gains a classification: `arm-own (command line)` when the command is a workspace's own test script, with the evidence; `unclassified` for anything not identified, including the `node --use-largepages=off` processes until they are identified. Blocks 1, 2 and 22 stay `genuine`. Wall-time results are reported with and without the blocks that carry a genuine or unclassified flag.

**Order before block 40:** finish scoring the 148 runs (so scoring does not overlap a block), build the runner fix, regenerate the freeze, then the batch resumes at block 40.

**M3 closed (2026-10-04).** The final report is `docs/m3/report.md` at `2ccb75c`. Verdict under PT13: between. Escaped defects per task were 0, 0, 1.04 and 1.08 for arms 1 to 4, and no comparison was significant. Arms 1 and 2 were at the floor. Poly arms used about 3.5 times arm 1's tokens and fewer than arm 2's. The stop rule was not triggered: 50 of 50 poly runs were admitted. Section 4 is post hoc and outside the freeze. Follow-ups:

- a proposal to make strict the default, starting from the T3 disclosed-range trap;
- checking the refund amount against PT3.4a;
- a possible second pre-registered experiment with harder tasks.

## Freeze after close (2026-10-04)

M3 is closed. Its results are reproduced from the freeze commit b8a8cfb and the analysis commands in the report, not from `main`.

- **Expected to change:** `examples`, `toolchain` and `toolchain build`. Later milestones change them.
- **Evidence, which must not change:** every other part: the runs, the scored data, the analysis script and `freeze.json`.

**Standing rule.** From now on, a merge into `main` requires `freeze.mjs --check` to report no change for every evidence part. Changes to the three expected parts are listed, not treated as failures. `freeze.mjs` and `freeze.json` are not changed to encode this. The first merge under it, `m4` into `main` at 34305c8, listed `examples`, `toolchain` and `toolchain build` and no evidence part.

**Line endings.** In the M3 tree (`C:\Users\jjdub\code\poly`), two files of the `toolchain` part, `packages/poly-core/package.json` and `packages/poly-check/tsconfig.json`, were checked out with CRLF, and `freeze.json` hashed those bytes; the committed bytes are LF, so a fresh checkout reports the `toolchain` part changed even at `main` before the merge. Both are in an expected part, not evidence. A checkout on Windows already gives the committed bytes: `.gitattributes` has pinned every text file to `eol=lf` since 2d91ba1, before the freeze, and no file's content was changed. `test/m3-freeze-eol.test.mjs` checks the rule in a fresh checkout with `core.autocrlf=true`: every evidence part reports no change. It could not fail first, since the pin was already there, so it is a confirmation test with a seeded control: with `eol=lf` removed from the checkout's `.gitattributes` and the experiment checked out again, the evidence parts change.

## Conclusion

The experiment runs on equal terms: both poly arms have the same tooling, the multi-machine tasks really run on polyrun, and the primary oracle is written without seeing any answer. Everything is frozen by digest before the first run, and the runs start only after the frozen set and the budget are approved.
