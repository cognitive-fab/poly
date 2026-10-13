# E3.9: the live run, reported as a result

*Cognitive Fab, October 2026. Run by the owner on 2026-10-13 with `node examples/harness/host/staged.mjs`. The data is `docs/e3/live-staged-2026-10-13.json` (the launcher's report, 40 trials with every call's usage and cost, no key in it). This is a result and not a test: it is reported whatever it shows. The expectation was written before it, in the README's section "Expected before the results come in".*

## Labels (they hold wherever a figure of this run appears)

1. **One model.** Claude Opus 5.5 as the agent, Claude Haiku 4.5 for the summaries and receipts, at the vendor's prices of 2026-10-12.
2. **12 tasks from the owner's repositories (6 JavaScript, 6 Go), 31 stages, binary stage scores.** The tasks are small. Each stage has one check.
3. **"Reached the end of the plan" is not "solved the task".** A stage is passed when its check passes; nothing more is claimed.
4. **40 trials, not 40 tasks.** Each task ran once under each configuration; eight tasks were rerun the same way. The eight were chosen before the run, by stage count.
5. **Completion under a cap partly measures cost.** No run was stopped by a cap here, so that caveat did not bite (section 3).
6. **The base harness is the full harness with the four mechanisms switched off.** The two differ in what the machines do and in one tool in the schema (the fused action), nothing else.

## 1. What was run

| | |
|---|---|
| Plan | 40 trials: each of the 12 tasks under the base and the full harness (24), then 8 tasks again (16), in pairs, the order alternating by task and reversed in the second pass |
| Environment | every command the agent caused ran in a disposable container with no network, no key and a read-only root; the isolation check passed before every one of the 40 trials |
| Caps | the host's cap of 0.60 USD a trial; the month's cap of 25 USD, poly's own |
| Stopped because | the plan was complete (40 of 40) |
| Spent | 4.3138 USD of the 25 |

## 2. The result

| | base | full |
|---|---|---|
| Trials that reached the end of the plan | 20 of 20 | 20 of 20 |
| Stages passed | 54 of 54 | 54 of 54 |
| Every stage ended by | done (54) | done (54) |
| Agent calls (steps) | 235 | 219 |
| Steps per trial, mean (least, most) | 11.8 (7, 19) | 10.9 (7, 16) |
| Turns per stage, mean (most) | 4.35 (8) | 4.06 (8) |
| Cost, total | 2.2214 USD | 2.0924 USD |
| Cost per trial, mean (most) | 0.1111 USD (0.1599) | 0.1046 USD (0.1681) |
| Time per trial, mean | 82 s | 79 s |

## 3. Completion, the pairs and the verdict

All 40 trials reached the end of their plans, so **completion has no variance and cannot tell the configurations apart**. Of the 12 pairs (one per task), 12 were completed by both and none by one only: **0 discordant pairs**. The exact one-sided McNemar test has nothing to count (p = 1). The paired rule's verdict is **INCONCLUSIVE**: with fewer than 5 discordant pairs no outcome could reach 0.05, and that is not "no difference". No stage regressed. No run was stopped by a cap (the largest trial cost 0.168 USD against the cap of 0.60, and no stage ran its eighth turn), so the comparison under a cap is the whole set of 12 and adds nothing.

The smallest gain the 12 pairs could detect at 80% power is **0.50**, and it is moot here: completion is at its ceiling, so a better harness could not show on it. What the run does show is in sections 4 to 6.

## 4. The noise floor

Measured as ruled: reruns of one configuration with the model frozen, over the 8 tasks that were rerun, for each configuration.

- **Completion: 0 of 8 tasks differ between reruns, in both configurations; stage scores: 0 of the stage cells differ.** That floor is zero only because everything completes; it says nothing about a harness that completes less.
- **Steps: reruns of one task under one configuration differ by 1.56 steps on average (at most 5).** For example the base harness on `snip-dedup` took 13 steps once and 8 the other time.
- **Cost: reruns differ by 20.2% of their mean on average (at most 58.1%), over the 16 rerun pairs.** The same task under the same harness cost 159,913 micro-USD once and 87,901 the other time.

So a difference in cost or steps between the configurations that is smaller than about a fifth of a trial's cost is inside what the model does by itself.

## 5. The cost, term by term

The agent's calls, by the class of token (the price per million at Opus 5.5: input 4, output 20, cache write 5, cache read 0.20):

| | base: tokens | base: USD | full: tokens | full: USD |
|---|---|---|---|---|
| Input (not cached) | 940 | 0.0038 | 876 | 0.0035 |
| Output | 46,697 | 0.9339 | 46,007 | 0.9201 |
| Cache write | 196,191 | 0.9810 | 189,257 | 0.9463 |
| Cache read | 1,512,996 | 0.3026 | 974,227 | 0.1948 |
| The agent, in all | | 2.2213 | | 2.0647 |
| The cheaper tier (receipts) | 0 calls | 0 | 7 calls | 0.0275 |

- **Where the money goes in the base harness:** output 42%, cache write 44%, cache read 14%, uncached input 0.2%. The first request of a trial (the system prompt, the tools and the task) is 1,330 tokens on average in the base harness and 1,502 in the full one (the fused action is in its schema: 172 tokens more, 13%).
- **What moved in the full harness:** the cache-read tokens fell by 36% (1.51 million to 0.97 million), the largest relative change, and the largest request fell from 20,991 tokens to 13,189. Steps fell by 6.8% (235 to 219), the output by 1.5%, the cache write by 3.5%. The cheaper tier's seven readings cost 0.0275 USD in all. Net: **2.2214 to 2.0924 USD, 5.8% less** (0.129 USD). Of that, 0.108 USD is the cache read, which is cheap per token and large in count.
- **Whether it is the harness or the noise:** per task, the full harness cost 0.0093 USD less a trial on average (mean over the 12 tasks of the difference of means; standard error 0.0060 USD, t = -1.56; 8 of the 12 tasks cheaper; 7 of 12 with fewer steps). That is an exploratory figure and not the declared test, and it is **smaller than the noise of section 4**. The run does not show that the full harness is cheaper; it shows a saving of about 6% that the rerun spread of 20% cannot rule out as chance.
- **Poly's own charge for the same usage equals the driver's, to the micro-USD, in all 40 trials** (4,313,767 micro-USD in all), so the real API's usage, priced under the table the module was admitted with, is what the driver logged. Poly's month budget (one store across the plan) holds `spent: 4313767` of `cap: 25000000`, which equals the driver's tally: the month's cap was accumulating, as poly's own, across all 40 trials. (Its period is labelled 2026-09 because the harness runs on the test clock the loader gives it; the cap did not depend on the label. This is fixed in d7d4b64a (S571): a live run now loads the harness with the real clock.)

## 6. Whether the mechanisms fire

The commands the agent ran are logged for every bash call, so these rates rest on evidence. The agent ran `go test` (46 times under the base harness, 50 under the full) and `npm test` (44 and 39) and nothing else: the tool description now names the runners of the classifier's table, and no vitest command was run. Every runner call was in the table.

| Mechanism | base | full |
|---|---|---|
| **Action Fusion** | 33 turns of one edit then one command; 0 fused (the mechanism is off) | 38 such turns; **36 fused**. The fused action was called in 54 of the 219 turns (25%); 36 of those turns were fused and 18 were not |
| **Online Context Compact** | 0 opportunities | **0 opportunities**: the largest request was 20,991 tokens (base) and 13,189 (full) of a window of 48,000, so the pay-gate's condition (more than a third of the window) was never met |
| **ObservationPack** | 7 outputs over 10 KiB; off | 9 over 10 KiB, **all 9 archived; 6 reached their handle** (sent in full for two requests, then replaced by the handle) |
| **Evidence-Preserving Reducer** | 7 logs over 4 KiB of a declared runner; off | 7 such logs, **7 read by the cheaper tier, 7 receipts verified, 0 rejected, 0 flagged, 7 shown** |

- **The 18 fused-action turns that were not fused** were turns the classifier is right to run apart: more than one edit beside the command (14), a search beside it (2), a command with `|` in it (1), and one `npm test` naming two test files, which the table's pattern does not take (1). The rule is one edit and one command of the table, and it held.
- **Compaction never fired** because the tasks are small: the windows stayed under half of the limit. The paper's saving from compaction needs long tasks, and these are not.
- **Fusion's saving cannot be isolated here.** A fused call returns the edit and the test together, which saves a model call; the full harness took 6.8% fewer steps, which the noise of section 4 does not exclude.

## 7. What this run does not show

- That any mechanism lowers cost or raises completion on a task of any size: at this size completion is at its ceiling and the cost difference is inside the noise.
- That Online Context Compact works: it did not fire.
- Anything about a model other than Opus 5.5 and Haiku 4.5, a task unlike these twelve, or a repository the owner did not write (snip is MIT licensed and small).
- That "reached the end of the plan" means the code is right: a stage is the repository's own tests for it.
- A comparison of the pass order: the two configurations alternate which runs first by task, and the second pass reverses the first, but the model's own variation and any drift of the service over the run are in the numbers.

## 8. Against what was expected

The README said, before the run, to expect **small or no differences** and an INCONCLUSIVE verdict, and to measure the noise floor, the cost per term and whether the mechanisms fire. All three held: no difference in completion (0 discordant pairs, INCONCLUSIVE); a cost difference of about 6% inside a rerun spread of about 20%; and the mechanisms fired where there was something for them to act on (fusion, the pack and the reducer) and not where there was nothing (compaction).

## Conclusion

On twelve small tasks, 40 live trials, the four mechanisms did what the machines say they do when they had something to act on, and made no difference that the run can tell from noise. Every trial finished, every call's cost is poly's charge to the micro-USD, the month's cap accumulated in poly's own budget across the plan, and the isolation check held before every trial. What the run measures well is the cost of each term and how often each mechanism fires; what it cannot measure is a gain from the mechanisms on tasks that are long enough to need them.

## Glossary

- **Cache read, cache write:** the prompt cache's two token classes: writing the new part of the context to the cache, and reading the part already there.
- **Discordant pair:** a task that one configuration completed and the other did not.
- **INCONCLUSIVE:** the third verdict, for a comparison too small to decide; it is not "no difference".
- **Noise floor:** how much an outcome differs between reruns of one configuration with the model frozen.
- **Opportunity:** a turn on which a mechanism could act (for fusion, one edit then one command of the classifier's table).
- **Reached the end of the plan:** every stage's check passed.
