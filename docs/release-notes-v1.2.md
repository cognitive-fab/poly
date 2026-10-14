# poly v1.2 · Release notes (E3, the checked agent harness)

## What v1.2 is

v1.2 adds one example and one clause of the semantics. It changes no command, no format and no guarantee of the language or the runtime: E3 made no core change (Q-E3-4). The example is `examples/harness`, the control loop of an agent harness (the four mechanisms of SoL-Pi, arXiv 2609.20519: Action Fusion, Online Context Compact, ObservationPack and the Evidence-Preserving Reducer) written in poly, so that the rules which make the mechanisms safe to switch on are properties the checker proves, with a seeded fault for each. The clause is PS13.8a. The release also carries one defect the live run found, S571, and its fix.

## What v1.2 contains

- **The harness (`examples/harness/harness.poly`, `harness.policy.poly`).** Seven machines: `Turn` (one model call and its tool), `Context` (the window, the pay-gate, compaction), `Trial` (the plan, the stage checks, the caps), `Receipt`, `Observation`, `Archive` and `Ledger`; a signed policy that denies every tool that needs the network in an offline run (HF3.10); a budget. The rules HF3.1 to HF3.13 are `never` statements, invariants and step properties. Each has a seeded fault that the checker catches with a diagnostic and a witness (`test/e3/e3-hac1.test.mjs`, 15 tests with the clean control). The four mechanisms are switched by the host once, through a capability no effect can write.
- **A stage is up to eight turns, checked once at its end (amendment A1, HF2.9).** A stage ends at the agent's explicit `done`, at its eighth turn or at the end of the budget, and its check runs once, in the step that ends it, with the reason recorded. The scorer reads, from the journal, the turns each stage took and what ended it.
- **The host's code, which holds no rule.** The loop and the live loop; the certified handlers (the receipt verifier, the credential scan with its redaction, the fusion classifier, the archive, the compaction, the intake, the tools); the scorer; the paired acceptance (exact McNemar test, the noise floor, the smallest detectable gap, and a verdict of ACCEPT, REFUSE or INCONCLUSIVE that is never "no difference"); the change gate (a harness change may touch only prompts, skills and thresholds); the price gate; the cost plan.
- **Twelve tasks and their oracle.** Six from `todo-app` (JavaScript) and six from `snip` (Go, MIT licensed, each with its `NOTICE`), 31 stages, each stage's check proved to fail before its fix and pass after it, in a container, before any model is asked.
- **The live path.** An Anthropic client that reads its key from the environment only and never logs, writes or returns it; the tools, with the explicit `done` and the fused action in the schema; a container with no network, no key and a read-only root for every command a model causes; an isolation check made inside it before every trial; a pilot launcher and a launcher of the staged plan; price tables read from the vendor's page.
- **PS13.8a, the projection onto one slot (S552).** A configuration may be checked with one slot of a group in place of `K`, and the verdict then holds for every `K`, when three conditions hold: every property is about one slot and its own partners, the sender sends every slot the same messages and reads nothing back, and nothing the sender does depends on how many slots exist or which answered. The verdict prints `1 of K, PS13.8a`. The harness uses it for its observation slots.
- **S571, a live run uses the real clock (HF2.10).** The first live run loaded the harness with the loader's test clock, so poly's month budget was keyed `2026-09` in an October run. The cap held, but its period was wrong. A live run now loads with the real clock. The spec line came first, a test written by a separate writer failed before the fix, and the fix followed (`5b03724a`, `b3adcd53`, `d7d4b64a`).
- **The tests of the example run by `npm run test:e3`, not by `npm test`**, one file at a time. They are named as their own item of this release's gate.

## The live run, as reported

One run on 2026-10-13: 40 trials of the twelve tasks, each under the base harness (the four mechanisms off) and the full one, then eight tasks again, with Claude Opus 5.5 as the agent and Claude Haiku 4.5 as the cheaper tier at the vendor's prices of 2026-10-12, every command in the container, each trial capped at 0.60 USD by the host and the month at 25 USD by poly's budget. The report is `docs/e3/live-run-report.md`; its data is `docs/e3/live-staged-2026-10-13.json`. **Labels on every figure:** one model; twelve small tasks from the owner's repositories, 31 stages, binary stage scores; "reached the end of the plan" is not "solved the task".

- **Completion:** all 40 trials reached the end of their plans (20 of 20 under each harness; all 108 stages ended by `done`). There were 0 discordant pairs of 12, so the paired verdict is **INCONCLUSIVE**, which is not "no difference". Completion was at its ceiling and could not tell the harnesses apart.
- **The noise floor:** 0 of the 8 rerun tasks differed in completion, which is a floor of zero only because everything completed. Reruns of one task under one harness differed by 1.6 steps on average (at most 5) and by 20% in cost on average (at most 58%).
- **Cost:** 2.2214 USD for the base harness and 2.0924 USD for the full one, 5.8% less, inside the 20% rerun spread. The run does not show the full harness to be cheaper. The cache-read tokens fell by 36%, the largest relative change. The 36% cost saving measured on recordings did not carry over. The whole run cost 4.31 USD of the 25.
- **The mechanisms:** Action Fusion fired on 36 of 38 opportunities in the full harness; ObservationPack archived all 9 outputs over 10 KiB and 6 reached their handle; the Reducer read all 7 long logs of a declared runner and all 7 receipts were verified, none rejected; **Online Context Compact never fired**, because no window passed a third of its limit.
- **Integrity:** poly's charge for the usage equals the driver's to the micro-USD in all 40 trials; poly's month budget accumulated to the same total across the plan; the isolation check passed inside the container before every one of the 40 trials; no stage ran its eighth turn and no run met a cap.
- **Against what was written before the run:** small or no differences, an INCONCLUSIVE verdict, and the measures it names. All held.

## What the evidence did not show

- Any gain from any mechanism on a task of any size: at this size completion is at its ceiling and the cost difference is inside the noise.
- That Online Context Compact works: it did not fire. The paper's saving from compaction needs tasks long enough to fill a window, and these are not. A set of long tasks is a candidate for a later release.
- Anything about a model other than Opus 5.5 and Haiku 4.5, a task unlike these twelve, or a repository the owner did not write.

## Open assumptions

Named in `examples/harness/assumptions.json` (which the certificate hashes) and the README. **Discharged:** the scan of the host's known secrets and the seven shapes (`scan-verdict-known`), the one-slot projection (`one-slot-projection`), and the isolation of the live run (`live-run-isolation`: the named container and the 40 checks inside it; the barrier is the container runtime's). **Open:**

- `stop-reason`, `token-buckets`, `compaction-size`, `dispatch-order`: the host's facts (the provider's stop reason, the token counts in buckets, the size a compaction leaves, the order of the host's dispatches). A wrong fact changes a score or leaves a run stuck, never a rule.
- `classifier-verdict`, `verifier-verdict`, `stage-check-verdict`: the three certified handlers whose soundness the checker cannot see. The rules hold relative to them; property tests and seeded mutant verifiers are the answer.
- `scan-verdict-unrecognised`: a credential of no known shape is not recognised by the scan.
- `recorded-world`, `staging-rows`: what a recorded run does not check, and the one table the canary scan does not look in.
- `joint-configuration`: the rules are proved for each machine alone; `Turn`, `Context` and `Trial` are not checked as one configuration.
- `done-signal`: the host's reading of the agent's calls for the explicit `done`.
- `trial-cap`: the cap of a trial is the host's. The budget's "per run" is per decision instance (S569), which here is one Turn, so poly's own budget bounds each Turn and the month, and the host bounds the trial.

**Later-release candidates**, recorded and not planned: S562 to S569 (among them S569, that "per run" means per decision instance, and S568, no read-only table grant), K10 (a decision and an effect cannot share a completion action), and a set of long tasks.

## Evidence for the release

Run on the merge commit `afb39d0e` (a temporary local branch at it, since a test refuses to write files on a branch named `main`), each part alone, as measured:

- **`npm test`:** the build and the boundary check passed; then **2,817 tests: 2,811 passed, 0 failed, 2 skipped, 4 to-do**. The 2 skipped and the 4 to-do are the same six as at v1.1.0 (`docs/v1/gate-v11.md`): `PS15.4, E13` (creation-unavailable) and `S152` (no OpenShell gateway) are skipped; `S153` and `S160` (waiting on E5), `S122` (waiting on E2) and `M4c … (K4)` (waiting on E1, polyrun's tombstones at archive) are to-do.
- **`test/after`:** 19 of 19 passed.
- **`npm run test:e3`:** 226 of 226 passed.

## Conclusion

v1.2 shows that the rules of an agent harness can be properties a checker proves, with a seeded fault for each, and that the same harness runs a live model under a budget and an isolation that were checked before and during the run. On twelve small tasks, 40 live trials, the mechanisms did what the machines say they do when they had something to act on, and made no difference the run can tell from noise. The open assumptions are named, and the gaps the run exposed (S569, S571) are recorded for a later release.

## Glossary

- **Action Fusion:** one tool call that runs an edit and its follow-up command.
- **Amendment A1:** the change that lets a stage take up to eight turns.
- **Assumption (discharged, open):** a fact the host supplies or a handler's verdict, named with a status; a discharged one is closed by a check, an open one says what tests it.
- **Compaction:** replacing the old part of a context by a summary, when it pays.
- **Container:** the environment, with no network and no key, in which every command a model causes runs.
- **INCONCLUSIVE:** the verdict for a comparison too small to decide; it is not "no difference".
- **Noise floor:** how much an outcome (completion, steps or cost) differs between reruns of one configuration with the model frozen.
- **Oracle:** the proof, before any model is asked, that a stage's check fails before its fix and passes after it.
- **PS13.8a:** the projection of a group of identical slots onto one.
- **Reducer:** the mechanism that has a cheaper model read a long log and shows the agent the receipt only if a verifier passes it.
- **S571:** the rule that a live run uses the real clock.
- **Stage:** one step of a task's plan, with one check.
