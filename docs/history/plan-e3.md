# poly · Plan for E3, the checked harness

*Cognitive Fab · October 2026 · written before any example code · on branch `e3` in the worktree `poly-e3`, cut from main at 02ad6d4f · from `proposals/example-harness.md` (HF, HT, HAC; Q-H3 ruled), `plan-v1.md` (E3, Q-V2), `plan-ex.md` and `decisions-ex.md` (the method this plan follows), `decisions-v1.md` (S400 to S463) and PS13, PS17, PS18*

Status: for the owner's ruling. Nothing is built. The worktree holds only this plan.

## 1. What this plan covers

The proposal specifies a harness whose control loop is a poly program: the loop, four cost mechanisms (Action Fusion, Online Context Compact, ObservationPack, the Evidence-Preserving Reducer), a budget, stage scores and a paired rule for accepting a change. Its rules (HF3.1 to HF3.11) are proved for every run, and its acceptance criteria are HAC1 to HAC8.

Reading the proposal against the code and the specs found:

1. Most of the rules map onto what poly already checks (section 3).
2. Eleven points are not covered as written. Each is a proposed spec issue, numbered from S550 (section 5). Most have a fallback that needs no change to the core. Where a fallback exists, the plan builds with it unless the owner rules the core change in.
3. Three points are contradictions or gaps in the proposal itself, not in poly (section 6, Q-E3-1 to Q-E3-3). They change what HAC3 can claim, and they need the owner before any code.

Nothing on `e3` changes the core. A core change is the release session's or an approved change, as `plan-ex.md` ruled for `ex`.

## 2. Common rules

- **Layout.** `examples/harness/`: the module `harness.poly`, its policy `harness.policy.poly`, price tables and maps, the editable surface (section 5, S557) in `examples/harness/editable/`, and host code in `examples/harness/host/`. Recorded tasks and model answers in `test/fixtures/harness/` with a `PROVENANCE.md`. Tests are `test/e3-*.test.mjs`.
- **Measured files.** `scripts/measure-verdicts.mjs` walks `examples/`, so each new `.poly` file becomes a measured file. Additions only; the existing verdicts stay identical, and each addition is listed with its verdict and counts in `decisions-e3.md`.
- **Tests first.** Each acceptance criterion gets a test that fails before the code that meets it. A test that cannot fail first (a control) is labelled so.
- **Recorded traffic only.** No test calls a model or a network. Model answers come from `recordedProvider`. A live run is a separate, bounded step (E3.9), never part of a suite.
- **Synthetic tasks.** Task repositories, logs and credentials in fixtures are written for the test. Test credentials are generated in the test and never written to disk.
- **No model on a check path.** The compaction gate, the verifier, the fusion classifier, the credential scan, the stage scorer and the acceptance test are deterministic code. The import-boundary check covers `examples/harness/` as it covers the rest.
- **One heavy job at a time.** Before any full suite or any benchmark run I check that no `node --test` runs from another worktree, and in particular none from `poly-m7`. Targeted tests run while building. The full suite runs through `scripts/suite-summary.mjs` before each commit that changes a `.poly` file, with the log cited by path.
- **Ids.** Spec issues S550 to S599. Diagnostic codes are the core's; the example adds none.
- **Records.** `docs/history/decisions-e3.md`, one entry per step, with polywatch findings marked real or false and why.
- **Commits.** One change, one commit, as `kizo-core`. Nothing is pushed.

## 3. How the proposal maps onto poly

| Proposal | Maps to | Status |
|---|---|---|
| HT1 machines `Session`, `Observation`, `Receipt`, `Archive` | machines, a configuration with instance groups (PS13) | fits; instance bounds apply (S552) |
| HT2 "compaction only at a finished step or the limit" | `never n: emit compact while P` (PS5.2a) | fits, with S551 for the numbers and S563 for "finished" |
| HT2 "only verified receipts reach the agent" | `never emit showReceipt while receipt.state != verified`; `Receipt` is a separate machine, so it is a configuration invariant (PS13.6) or a guard in `Session` that reads a field set by a message | fits with a choice (E3.1) |
| HT2 "handles always resolve" | configuration invariant over `Observation` and `Archive` instances | see S552 |
| HT2 "full output exactly twice" | a counter in `Observation`, `handled` on the third send | fits; the broadcast is S552 |
| HT2 "budget" | std `Budget` through S454 (PS18.4a) | fits; the route does not (S550) |
| HT2 "output cutoff recovers", "overflow compacts first" | `never emit … while …` over `Session` fields | fits, with S550 for the stop reason |
| HT2 "stage scores come from the journal" | a reader of the journal | not a language feature (S555) |
| HT2 "rules stay out of reach" | signed policy (S194) and a declared editable set | partly new (S557) |
| HT2 "offline means offline" | effect labels and a policy (PL6301, PL6401) | maps; confirm in E3.0 (S558) |
| HT3 the verifier | a certified effect handler with two completions | fits; its soundness is an assumption (S553) |
| HF3.5 credentials never in context | the M9 canary, plus the flow rule of PS17 | the scan is new (S554) |
| HAC3, HAC8 paired tests | host code | outside the language (S556) |

## 4. The program

One module, `examples/harness/harness.poly`, with its policy.

| Machine | Instance | Holds |
|---|---|---|
| `Session` | `session:<task>` | the plan's step count and current step (bounded), the step's state, the context size and the limit as bucketed numbers (S551), the reprompt count, the compaction count, the cap flags, the state of HT1 |
| `Observation` | `obs:<task>:<n>` | the size class, the number of requests it was sent in full (0 to 3), the state `full` or `handled`, a flag from the credential scan |
| `Receipt` | `receipt:<task>:<n>` | the source hash as an opaque key, the verifier's result, the state `pending`, `verified`, `rejected` |
| `Archive` | `archive:<task>` | handles and reference counts, as far as S552 allows |
| `Budget` | std, through S454 | the task's cost cap |

Decisions are unrouted, each with a budget (S454): `agent` (the main model, one step), `reader` (the cheaper model, one receipt), `summarise` (compaction). Effects are certified handlers: `runTools`, `archive`, `verify`, `scan`, `classify`, `stageCheck`, `saveWork`, `compactApply`.

The host (`examples/harness/host/`) owns the loop's I/O: it counts tokens, runs the tools in a sandbox, and reads the journal. It holds no rule.

## 5. Spec gaps, as proposed spec issues

Each entry: the gap, a proposal that stays inside the example if it can, and the alternative in the core. "Fallback" means the plan's default if the owner rules nothing.

- **S550. The agent's step is a decision whose result carries Content and a stop reason.** A step returns tool calls (arguments are text) and a stop reason (`end`, `tool`, `length`). A routed decision refuses a `Content` result and `cites` (PL6839, kept by S402), and a route's escalation (conf, margin) is not what the harness means by "main tier" and "cheap tier". *Fallback:* `agent`, `reader` and `summarise` are three unrouted decisions on one budget (S454). HAC5's "every tier choice" then becomes "every decision's model and cost" (PS18.6 records both for an unrouted budgeted decision). The result is a record `{ stop: Stop, calls: Content }` with `Stop` an enum the host maps from the provider's metadata; E3.0 probes that a record with a `Content` field is allowed as an unrouted result. *Core alternative:* none needed if the probe passes.
- **S551. Measured numbers in checked state.** Context size, a saving, a rewrite cost and a threshold are large integers. The checker explores small domains, cut at the constants a condition names (PS4.1h), and discloses a value beyond them. *Fallback:* sizes enter as buckets of a stated unit (for example 1 KiB and 1 ktok), the gate is an integer comparison over buckets, and the verdict prints the unit and the domain. The tokenizer count is a trusted host measurement, and the certificate says so, as S463 does for its assumption. A threshold is a constant of the editable surface (S557), so each change is re-checked at its new value.
- **S552. Fan-out to a bounded set of observations.** "Sent in full for two requests" needs the session to tell every live `Observation` that a request went out, and "every handle in any context has a positive count" needs the context to name its handles. A state holds bounded fields, and a configuration has an instance bound N (PL5302 when hit). *Fallback:* the check instance has K observation slots (K = 3 to start, measured in E3.0), the session sends `Sent` to each, and the handle invariant is a configuration invariant over the K slots and the archive's counts. A run with more than K live observations is accepted and disclosed (PT3.4), and the verdict prints K. If E3.0 shows the count explodes, the invariant is checked per observation in a two-instance configuration and the plan says why the quotient is exact. *Core alternative:* a broadcast to an instance group, if one does not exist. E3.0 checks.
- **S553. The verifier is a certified handler, and its soundness is an assumption.** The checker models `verify` as an effect with two completions; it cannot see that the handler compares bytes. HF3.2 and HAC4 then hold relative to the handler. *Proposal:* the certificate lists the verifier as an assumption with its status, as S463 lists its own. The handler is tested by property tests and by four seeded mutant handlers (skips the hash, accepts a quote not in the log, accepts a longer receipt, ignores the exit status), each of which a test must catch. The mutant handlers enter the explicit list of toolchain faults the way the standing rule asks, if the handler is an artefact the runtime reads.
- **S554. Credential scan and the class of a tool result.** HF3.5 means no model sees a credential, and that includes the cheaper model the reader calls. The proposal's text, "a flagged log always takes the original-log path through redaction", is ambiguous: the original path would show the credential. *Proposal:* the scan runs in `scan` before any model call. It classifies the output `clean` or `secret`, with a pattern scanner and an exact match against every token in the vault. A `secret` output is redacted by a handler that removes the matched spans before it is stored as `Content`; the unredacted bytes never enter a `Content`. The audience lattice of PS17 carries the class (`clean < secret`), and the flow rule gives a finding (PL6831) for any path from a `secret` item to a decision's materials. The M9 canary test covers the context, the archive, the receipt and the journal. *Limit:* a credential the scan cannot recognise is not caught; the canary shows the vault's tokens, not arbitrary secrets. The plan states that.
- **S555. Stage scores are a reader of the journal.** A stage is a plan step with checks; the failing stage is the first state whose journaled check failed. *Proposal:* `stageCheck` is an effect whose completion (`Passed(k)` or `Failed(k)`) is journaled. `examples/harness/host/score.mjs` reads the journal through the public journal API and computes the scores and the first failing stage. It is deterministic and calls no model. It is host code, so it is not a language feature, and HAC7's seeded fault test checks the reader against a machine-written fault at stage k. If the journal API does not expose what is needed, E3.0 stops and brings it.
- **S556. The acceptance rule of HF2.8 and HAC8, and the statistics of HAC3.** Exact McNemar on discordant pairs, the rerun spread as the noise floor, and the smallest gap detectable at 80% power. *Proposal:* a small module `examples/harness/host/paired.mjs` with its own tests against published values, the same shape as the one-sided Fisher test of `proposals/experiment-strict-rerun.md`. Its verdict has three values: `ACCEPT`, `REFUSE` and `INCONCLUSIVE`. An underpowered comparison (the detectable gap above the observed one, or fewer than two reruns) is `INCONCLUSIVE` and never `ACCEPT`, so no silent clean holds here too. Every verdict prints its instance: the pairs, the discordant counts, the noise floor and the detectable gap.
- **S557. What a harness change may touch.** HF3.11 asks that the loop not change the rules or the policy. *Proposal:* the editable surface is a set of files, `examples/harness/editable/`: skills, prompts and thresholds as data and constants. The rules and the policy are in other files, pinned by hash in the certificate. A change is a diff; a deterministic gate refuses any diff that touches a file outside the surface, or a policy file whose signature does not verify (S194, PL6409). Because a threshold is a constant of the checked module, every change to one is checked again, and a change under which a rule fails is refused before any measurement. The seeded change for HAC1 edits a rule file and is refused.
- **S558. Offline means offline.** *Proposal:* every tool effect carries the label `net` or `local`, which PL6301 already forces. The offline policy scope denies `net`. "A check over the configuration" is then the policy stage of the checker, not new code. A tool with no label is `PL6301`. E3.0 confirms that a label can be refused by a scope in the policy language as written. If it cannot, the fallback is a host check, which the plan then lists as not covered by the checker.
- **S559. Fusion is a classifier over a declared set.** HF3.4 asks that a command needing to inspect the edit's result is never fused. Whether a command needs to inspect is a judgement the checker cannot make on model-written text. *Proposal:* the harness has a table of fusable command shapes (a test runner, a build) and `classify`, a deterministic handler, returns `Fusable` or `Separate`. The property is `never emit fuse while classified != Fusable`. What is proved is that fusion follows the classifier, and the plan says the table is the trust. The table is part of the editable surface only for additions that a test shows the classifier handles.
- **S560. Compaction is proved for when, not for what.** HF1 names the danger that a compaction drops what the next action needs. HT2 rules out the wrong time and requires that the gate be numeric. Nothing proves a summary keeps a fact. *Proposal:* `summarise` is `Content cites context`, so a summary that cites nothing is refused by the citation check (PS17.6), and the plan says in the README and the certificate that a summary's completeness is measured by stage scores (HAC7), not proved.

## 6. Questions for the owner

- **Q-E3-1. HAC3 cannot be measured on recorded model answers.** A harness that changes the context changes the prompt, and a recorded answer belongs to one prompt. A recording can replay one fixed trajectory under different context management, which gives exact token traffic and cost, but it cannot show whether the agent still completes the task, nor give a rerun spread, since a recording has none. HT4 says no test spends on a live model, and HAC3 asks for completion, paired tests and reruns. These cannot both hold. *Recommendation:* split HAC3 in two. (a) In the suite: the cost side on recorded trajectories (HAC2, HAC6), and the statistics pipeline of S556 on recorded outcome tables, including a seeded table where a cheaper configuration completes fewer tasks and is refused. (b) A live run of the base and the full harness on the task set, at least twice each, offline in tools, bounded by a budget the owner names, reported as a result and not as a test. HAC3 is then accepted when (a) passes and (b) is reported, and the report says what the task count can and cannot detect. If the owner wants no live run, HAC3's completion half is not claimed, and the example says so.
- **Q-E3-2. The base harness (Q-H1), and the MCP sentence of HT4.** HT4 says the harness drives a coding agent's tool loop through MCP. A harness that compacts the context and replaces outputs by handles must own the context, so it must own the model call. A client such as Claude Code owns its own context, and MCP tools cannot change it. *Recommendation:* the poly harness owns the loop, and MCP is how it reaches tools as a client. The base is the same harness with the four mechanisms switched off by configuration, which gives the paired comparison one variable at a time, as VERA asks. A comparison to Pi, Puffin or Claude Code needs an adapter for that loop and is a later step. If the owner wants Pi as the base from the start, E3.9 gains a port of the Pi loop and the plan grows.
- **Q-E3-3. The task set (Q-H2).** The paper's benchmarks are not offline, and HAC7 needs checks per stage, which a benchmark with one final check does not give. *Recommendation:* 12 tasks written from the owner's own repositories (this one included), each a small change with a test suite, a plan of 2 to 4 steps and a check per step, runnable offline. The plan states that 12 pairs detect only a large gap (a gap of about four discordant tasks at the 0.05 level), so a negative result at this size is `INCONCLUSIVE`, not a finding of no difference. A larger set (40 or more) follows if the live run is worth repeating. Which repositories the owner is willing to use is theirs to name.
- **Q-E3-4. Who builds the core changes.** None of S550 to S560 requires one on the fallbacks. If the owner prefers the core alternatives (a group broadcast, S552; a label-denying scope, S558), they are the release session's work, and `e3` rebases on them.
- **Q-E3-5. Which cost model.** HAC6 reports cost as preamble, transcript and output. PS18.3 prices by token class from a price table with its source and date. *Recommendation:* the harness uses that table format, for the model names the owner names, with the source read from the vendor's page when the table is written. The tables in `examples/inbox/prices/` are the shape to follow.
- **Q-E3-6. The failing stage when two stages fail on one run.** HF2.7 names the first state with a failed check. HAC8 wants "no stage regresses". *Recommendation:* the score is per stage, the failing stage is the first, and regression is per stage across the pair, so both are reported. Say if the owner wants only the first.

## 7. Steps

| Step | What | Acceptance |
|---|---|---|
| **E3.0 Measure first** | Probe, in fixtures that are discarded: a record with a `Content` field as an unrouted result; an unrouted decision with a budget; a configuration of one `Session`, K `Observation`s and an `Archive` and its state count at K = 2, 3, 4; the broadcast; a label denied by a policy scope; the journal API for the score reader. Record the counts and each answer. | A table of the probes in `decisions-e3.md`. If a count reaches the checker's bound, or a probe fails with no fallback, stop and bring the numbers (as S300 and S456 did). |
| **E3.1 The rules, tests first** | One failing test per rule of HF3 (HAC1): the variant that breaks it, the finding and its witness. The variant is a copy of the module with one line changed. A rule that is a policy or configuration check (HF3.10, HF3.11) gets the configuration variant. | 11 variants, each a test that fails because the module does not exist. |
| **E3.2 The machines** | `harness.poly` and its policy until the program is `CLEAN` with the instance printed, and every variant of E3.1 gets its finding. | HAC1. The vacuity report is run: a rule never exercised is a finding, not a pass. |
| **E3.3 The effects** | The certified handlers: `scan`, `verify`, `classify`, `archive`, `compactApply`, `stageCheck`, `saveWork`, with their property tests and the four mutant verifiers. | HAC4, S553, S554: the canary found across context, archive, receipt and journal; the seeded control (a handler that prints a token) found. |
| **E3.4 The host** | The loop, the tool sandbox, the token counter, the recorded provider. It holds no rule. | A recorded task runs end to end; the journal replays every post-state and decision (HAC5). |
| **E3.5 The mechanisms** | Action Fusion, compaction, ObservationPack and the Evidence-Preserving Reducer switched on one by one on recorded trajectories. | HAC2: each fires where the paper says it should, by trigger rate, with the rate printed and the trajectories named. |
| **E3.6 The cost report** | The preamble, transcript and output terms and the step count, per call and per trial. | HAC6: a seeded change that moves one term is traced to it. |
| **E3.7 Stage scores** | `score.mjs` over the journal, and the stage checks for the 12 tasks. | HAC7: a seeded fault in stage k is reported as stage k. |
| **E3.8 Paired acceptance** | `paired.mjs`, and the change gate of S557. | HAC8, and the cost half of HAC3 and its statistics on recorded outcome tables, including the seeded cheaper-and-worse table refused. |
| **E3.9 The live run (only if Q-E3-1 rules it in)** | Base and full harness on the task set, at least twice each, offline in tools, within the owner's budget. | The report: completion, the pairs, McNemar, the noise floor, the detectable gap, and the cost split. Reported as a result, whatever it shows. |
| **E3.10 Record** | The full suite, the verdict file, `decisions-e3.md`, the README for `examples/harness/` with its glossary, and the certificate's list of assumptions. | The suite passes; every added `.poly` file is listed; the README states the limits of S551, S553, S554, S559 and S560. |

E3.1 to E3.3 can start after E3.0 and before the answers to Q-E3-2 and Q-E3-3. E3.4 and later need them.

## 8. Risks, measured where they can be

- **State space.** A session, K observations and an archive in one configuration. E3.0 measures K = 2, 3, 4 before E3.2. The `Receipt` machine is checked in a two-instance configuration if the whole is too large.
- **Vacuous rules.** A rule such as "compact only when it pays" is vacuous if the gate never fires in the check instance. The vacuity report decides; E3.2 adds a witness run for each rule.
- **The verifier as the trust.** HF3.2 holds relative to a handler the checker does not read. The mutants and the certificate's assumption line are the answer, and the README says so.
- **A cheaper run that completes fewer tasks.** HAC3 asks that this fail. The seeded outcome table of E3.8 is the test, and the live run, if ruled in, is the evidence.
- **Shared machine.** The M7 session runs heavy jobs. Every suite and every benchmark waits for a quiet machine; no benchmark runs while a suite runs.

## Conclusion

The harness's control loop fits poly: the loop, the budget, the verifier's two completions, and the "never emit" rules are things poly already checks. Eleven points do not fit as written, and each has a proposal that stays inside the example. Three decisions are the owner's: whether a live run measures completion (Q-E3-1), whether the poly harness owns the loop (Q-E3-2), and which tasks it runs (Q-E3-3). Until they are ruled, only E3.0 to E3.3 can start, and this plan asks for no build before then.

## Glossary

- **Action Fusion:** one tool call that runs an edit and its follow-up command.
- **Archive:** the machine that holds output handles and how many contexts refer to each.
- **Handle:** a stable reference to an archived output, with its size and an excerpt.
- **Harness:** the control loop around a model that runs its tools and manages its context.
- **Noise floor:** the spread between reruns of one configuration on the same tasks.
- **Paired acceptance:** keeping a change only when the same tasks, run with and without it, show a gain and no regression.
- **Receipt:** a cheaper model's compact reading of a log, with exact quotes and the log's hash, checked before use.
- **Stage score:** the share of a stage's checks that pass, computed from the journal.
- **Vacuous rule:** a rule that holds only because the checked instance never exercises it.
