# Example application 2: a checked agent harness

Status: proposed, for the owner's ruling. Built after the inbox assistant. Ids: functional `HF`, technical `HT`, acceptance `HAC`.

A harness is the loop around a model that turns it into an agent: it sends the context, runs the tools, handles their output and decides when to compact. SoL-Pi (NVIDIA and MIT, arXiv 2609.20519) found four harness mechanisms that cut token cost: Action Fusion, Online Context Compact, ObservationPack and the Evidence-Preserving Reducer. Liu and Han (arXiv 2610.04433) found that a harness barely moves pass rate but sets the bill, up to three times on the same model, and that every harness effect they could measure is a way to lose a task. VERA (NVIDIA, arXiv 2610.05923) scores long tasks stage by stage and accepts a harness change only when paired reruns with the model frozen show a gain and no regression. Each one is a rule the harness must not break, and SoL-Pi tests these rules on benchmarks. This example writes the harness's control loop in poly, so the rules are proved for every run.

# Part A. Functional specification

## HF1. The problem

A harness tuned for cost can lose correctness without anyone seeing it: a compaction in the middle of a step drops what the next action needs; a summary of a log hides the failing line; a large output replaced by a handle can no longer be retrieved. SoL-Pi's results show the trade: lower cost per solved task, and fewer tasks solved on two of its benchmarks. The harness should keep the savings and lose nothing the agent needs.

## HF2. What the harness does

- **HF2.1 The loop.** Send the context to the main model, run the tool calls it asks for, add their results, and repeat until the task's plan is complete or a bound is reached.
- **HF2.2 Action Fusion.** An edit and its planned follow-up command (a test, a build) run in one tool call, and their results come back together. A command that must inspect the edit first stays separate.
- **HF2.3 Compaction at finished steps.** The agent keeps a plan. When a plan step completes, the harness compacts the context only if the projected saving exceeds the cost of rewriting the cached prefix, and always near the context limit.
- **HF2.4 Large outputs by handle.** A tool result over a threshold (10 KiB by default) is archived and sent in full for two requests, then replaced by a handle, its size and a head-and-tail excerpt. The agent can fetch any exact range through the handle.
- **HF2.5 Logs read by a cheaper model, with evidence.** A build or test log over a threshold (4 KiB) is read by a cheaper model, which writes a receipt: status, exact quotes, source hash. A deterministic verifier checks the receipt against the original. The agent sees the receipt only if it passes; otherwise it sees the original log.
- **HF2.6 Budget.** Each task has a cost budget; the harness stops at it with the reason shown.
- **HF2.7 Stage scores.** Each plan step is a stage with its own checks. A run reports a score per stage, and the failing stage is the state where the journal shows the first failed check, read from the journal, not guessed by a model.
- **HF2.8 One change at a time.** A change to the harness (a skill, a prompt, a threshold) is measured with the model frozen, on the same tasks, with and without the change. It is accepted only if its target stage improves and no stage regresses. A run of the model is measured with the harness frozen.
- **HF2.9 A stage is up to N turns (amendment A1, owner, 2026-10-12).** A plan step is a stage, and the agent works on a stage in turns: one model call, the tool calls it asks for, and their results added to the context of the next turn. N is declared in the module (8). A stage ends at the first of: an explicit `done` from the agent, the N-th turn, or the end of the budget. The stage's check runs once, at that end, and never before. A failed check is recorded as that stage's failure and the trial goes on to the next stage (HF2.7: the stages after the first failure are still scored). When the budget ends a stage, the check still runs once, and the trial then ends with the reason Budget; the stages after it are not reached. The results of a turn's tools reach the next turn through the context, which the Context machine measures before each request. The first version of the module had one turn per stage, which a live agent cannot work in (it cannot read a file and then edit it); this amendment is the repair, and it is made inside the checked machine and not around it.
- **HF2.10 A live run uses the real clock (amendment A2, owner, 2026-10-13, S571).** A run that calls a live model loads the harness with the real clock, so that the period of a budget (the month's) is the real one: the month's budget instance of a live run is keyed to the month in which it runs, and its cap holds across the whole month, not across a period of a fixed test date. A recorded run, which calls no model and spends nothing, may load with a fixed clock. The first live run (2026-10-13) was loaded with the loader's test clock and its month budget is labelled 2026-09; its cap held, but the label was wrong.

## HF3. What the harness must never do

- **HF3.1** Compact in the middle of a plan step, except at the context limit.
- **HF3.2** Show the agent a receipt the verifier did not pass, or a receipt over a log that may contain a credential.
- **HF3.3** Issue a handle it cannot resolve: an archived output stays available while any context refers to it.
- **HF3.4** Fuse a command that needs to inspect the edit's result.
- **HF3.5** Put a credential into the model's context.
- **HF3.6** Exceed a task's budget.
- **HF3.7** End a step on an output cutoff without re-prompting the model to continue (the largest measured harness loss in Liu and Han, arXiv 2610.04433).
- **HF3.8** End a trial on a context overflow without one compaction attempt first.
- **HF3.9** End a trial at the step cap or the wall clock without saving the work on disk and reporting the cap as the reason.
- **HF3.10** Depend on a tool that needs the network when the run is offline: every tool the harness offers declares whether it needs the network, and an offline run offers none that do.
- **HF3.11** Let a harness change touch the rules of HF3 or the gate policy. Skills and prompts can evolve; the rules and the signed policy (S194) cannot be changed by the loop they govern.
- **HF3.12** Run a stage's check before the stage has ended (before `done`, the N-th turn or the end of the budget), or run it more than once in a stage (amendment A1).
- **HF3.13** Run more than N turns in a stage (amendment A1).

## HF4. Acceptance criteria

| Id | Criterion |
|---|---|
| HAC1 | Each rule of HF3 has a seeded variant that breaks it, and `poly check` gives a witness for each. |
| HAC2 | Over a recorded set of tasks, the harness reproduces SoL-Pi's four mechanisms: each fires where the paper says it should, measured by trigger rate. |
| HAC3 | Over the same recorded set, completion is at least the base harness's, and token traffic and cost are reported beside it. A cheaper run that completes fewer tasks fails this criterion. The comparison is paired per task (McNemar's exact test), each configuration is run at least twice so its rerun spread is reported as the noise floor, the smallest gap the task set can detect at 80% power is stated, and every run is offline. |
| HAC6 | The cost of each call is reported as the preamble (system prompt and tool schemas), the transcript and the output, and the step count per trial, so a cost change can be traced to the term that moved it. |
| HAC7 | Each run reports a score per stage and names the failing stage from the journal; a seeded fault in stage k is reported as a failure of stage k. |
| HAC8 | A harness change is accepted only by the paired rule of HF2.8, with the test of HAC3; a seeded change that improves one stage and regresses another is refused. |
| HAC9 | Each rule of HF3.12 and HF3.13 has a seeded variant that breaks it, with a witness. The scorer reports, for each stage, the number of turns it took and what ended it (`done`, the bound or the budget), read from the journal; a stage that ran N turns with no `done` is reported as ended by the bound. |
| HAC4 | A receipt whose quote is not in the original log is rejected and the original is shown, journaled. |
| HAC5 | The journal replays every compaction decision, every handle, every receipt check and every tier choice. |

# Part B. Technical specification

## HT1. Machines

| Machine | Holds |
|---|---|
| `Session` | the task, the plan's steps and the current step, the context size, the budget reservation, the state (`thinking`, `acting`, `observing`, `compacting`, `done`, `stopped`) |
| `Observation` | one tool result: size, archive handle, the number of requests it was sent in full, state (`full`, `handled`) |
| `Receipt` | one log reading: source hash, status, quotes (as `Content`), verifier result, state (`pending`, `verified`, `rejected`) |
| `Archive` | handles and their reference counts |

Model calls are decisions under `route` (M11): the main tier for the agent, the cheap tier for receipts. The budget is a `Budget` machine (M11).

## HT2. The rules as properties

| Rule | Form |
|---|---|
| Compaction only at a finished step or the limit | `never emit compact while step.state != finished and context < limit` |
| Compaction only when it pays | the compaction gate is a typed decision over measured numbers (projected saving, rewrite cost), never a model's opinion |
| Only verified receipts reach the agent | `never emit showReceipt while receipt.state != verified` |
| Credentials never in context | a log flagged by the credential scan always takes the original-log path through redaction, and the canary test of M9 covers the context |
| Handles always resolve | an invariant: every handle in any context has a positive reference count in `Archive` |
| Full output exactly twice | an `Observation` moves to `handled` on its third send, and only then |
| Fusion only for commands that need no inspection | the fusable commands are a declared set; fusion outside it is refused |
| Budget | reservations before each model call (PT24.3) |
| A stage is up to N turns, checked once at its end | `Trial` counts the turns of the stage; the check is emitted only in the step that ends it, with the reason recorded (`step property` over the pre and post state); the bound is an invariant (amendment A1) |
| Output cutoff recovers | `never emit endStep while lastCall.stop == length and reprompts < 1` |
| Overflow compacts first | `never emit endTrial(overflow) while compactions == 0` |
| Caps are reported | every trial ending at a cap carries the cap as its reason, and the working tree is kept |
| Stage scores come from the journal | a stage's score is computed from the checks journaled in that state; the failing stage is the first state with a failed check |
| Rules stay out of reach | the set of editable harness parts is declared (skills, prompts, thresholds); a change outside it, or to the policy, is refused |
| Offline means offline | an offline run's tool set contains no tool declared as needing the network (a check over the configuration) |

## HT3. The verifier

The receipt verifier is deterministic code in a handler, read by the checker as an effect with two completions (`verified`, `rejected`). It checks: the source hash matches the archived log; every quote occurs in the log byte for byte; the exit status matches the command's; the receipt is smaller than the log. Any failure completes `rejected`.

## HT4. Where it runs

The harness drives a coding agent's tool loop through MCP. In v1 it is an example and a benchmark, not a product: tasks and model responses are recorded, so no test spends on a live model. A live run is optional and bounded by the owner's budget.

## HT5. Open questions for the owner

1. **Q-H1.** Base harness for the comparison: Pi (as in the paper), or one of the owner's own harnesses (Puffin, Claude Code)?
2. **Q-H2.** Task set: a small subset of a public benchmark the paper used (EdgeBench, Terminal-Bench), or tasks from the owner's own repositories?
3. **Q-H3.** Ruled (owner, 2026-10-08): right after v1, as the first post-release example.

## Conclusion

SoL-Pi found the rules that make a harness cheap and tested them on benchmarks. Written in poly, the same rules are proved for every run, the evidence for each decision is journaled, and a cheaper run that solves fewer tasks is reported as the failure it is. The example shows poly governing the agent's own loop, not only the programs agents write.

## Glossary

- **Action Fusion:** one tool call that runs an edit and its follow-up command.
- **Handle:** a stable reference to an archived output, with its size and an excerpt.
- **Harness:** the control loop around a model that runs its tools and manages its context.
- **Receipt:** a cheaper model's compact reading of a log, with exact quotes and the log's hash, checked before use.
- **Paired acceptance:** keeping a change only when the same tasks, run with and without it, show a gain and no regression.
- **Stage score:** the share of a stage's checks that pass, computed from the journal.
- **VERA:** the stage-scored, verifier-gated training loop of arXiv 2610.05923.
- **SoL-Pi:** the harness of arXiv 2609.20519, whose four mechanisms this example reproduces.
