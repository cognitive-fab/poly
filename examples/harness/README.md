# examples/harness: a checked agent harness

> **Status (2026-10-13):** the live run (E3.9) is in and reported in `docs/e3/live-run-report.md`; section 5 summarises it. Figures from the recorded runs are recordings evidence and carry the three labels of section 4; figures from the live run carry the labels of section 5.

An agent harness is the loop around a model: it sends the context, runs the tools, handles their output and decides when to compact. This example writes the control part of one in poly, so that the rules which make the four mechanisms of SoL-Pi (NVIDIA and MIT, arXiv 2609.20519) safe to switch on are properties the checker proves, not conventions. The proposal is `docs/proposals/example-harness.md` (ids `HF`, `HT`, `HAC`); the plan and every ruling are `docs/plan-e3.md` and `docs/decisions-e3.md`.

## 1. What is here

| Path | What it is |
|---|---|
| `harness.poly` | The machines: `Turn` (one model call and its tool, per plan step), `Context` (the window, the pay-gate, compaction), `Trial` (the plan, the stage checks, the caps), `Receipt`, `Observation`, `Archive`, `Ledger`. |
| `harness.policy.poly` | The signed policy: an offline run denies every tool that needs the network (HF3.10). |
| `host/` | The host's code, which no machine reads: the loop, the handlers, the scorer, the paired acceptance, the change gate, the price gate, the task machinery. |
| `host/handlers/` | The certified handlers: the verifier, the credential scan, the classifier, the archive, the compaction, the intake, the tools. Deterministic, no model call. |
| `editable/` | The only files a harness change may touch: prompts, skills and thresholds. |
| `tasks/` | The 12 tasks of the live run and the offline proofs: 6 from `todo-app` and 6 from `snip` (MIT licensed, each with its `NOTICE`), 31 stages in all. |
| `prices/`, `prices-live/` | The price tables the module reads (placeholders, labelled) and the tables proposed for the live run, read from the vendor's page. |
| `assumptions.json` | The assumptions and statements the certificate carries. |

## 2. The four mechanisms and the rules that make them safe

The four mechanisms are switched by the host, once, before a trial begins; a handler reads them through a capability that can only read, and no effect of the module can write them, so a trial cannot change its own mechanisms (`test/e3/e3-loop.test.mjs`).

- **Action Fusion:** an edit and its follow-up command run as one call. Fusion follows a deterministic classifier over a declared table of runners (HF3.4). What is proved is that fusion follows the classifier; the table is the trust.
- **Online Context Compact:** a compaction starts only at a finished step or at the limit, only when the measured saving pays for the cache rewrite, and only once the summary is made (HF3.1, HF3.8).
- **ObservationPack:** a tool output is archived behind a handle with its size and an excerpt, and sent in full for two requests only; every handle in any context resolves (HF3.3).
- **Evidence-Preserving Reducer:** a long log of a build or test is replaced by a receipt a cheaper model wrote. A receipt is shown only if the verifier passed it; otherwise the original is (HF3.2).

The rules are `never` statements and invariants of the machines, with a seeded fault for each in `test/e3/e3-hac1.test.mjs` (HF3.1 to HF3.11): each fault is refused with the diagnostic and a witness, and the control module checks clean with no rule vacuous.

## 3. What may change

A harness change touches only `editable/`: prompts, skills and thresholds. The gate (`host/change-gate.mjs`) refuses any other path, including the rules, the policy and the price tables. A change is then accepted only by the paired rule (`host/paired.mjs`): a significant gain by the exact McNemar test, no regressed stage, and a measured noise floor below the gain. A regression, or a candidate that completes fewer tasks, is refused whatever it costs; too few discordant pairs is INCONCLUSIVE and is never reported as no difference.

## 4. The labels on every figure

The measured results of the recorded runs (the trigger rates, the token and cost figures) carry three labels:

1. They come from a **synthetic corpus of 12 trajectories**, with tokens estimated at four characters each.
2. A run that **"reached the end of the plan"** did not "solve the task": the model, the tools and the stage checks are recorded.
3. The figures of **20% fewer input tokens and 36% less cost** (all four mechanisms against none, over the corpus) **hold for recordings only**. The saving of Action Fusion cannot show on recordings and is measured at the live run.

On the corpus, with the placeholder price table (a write over read ratio of 12.5): fusion triggers on 10 of 12 trajectories (21 of 22 opportunities, intensity 2.1), and the pay-gate chooses no compaction (0 of 12; 3 are forced at the limit), because a trajectory of two to four steps has no long tail to save. At a ratio of 2 it chooses one. That shows nothing about long tasks. The files are `docs/e3/trigger-rates.json` and `docs/e3/cost-report.json`, compared by `test/e3`.

## 5. The live run (E3.9)

One bounded live run, reported as a result and not as a test, on 2026-10-13: 40 trials of the 12 tasks (each under the base and the full harness, then eight tasks again), with Opus 5.5 as the agent and Haiku 4.5 as the cheaper tier, every command in a disposable container with no network, the isolation check made before each trial, each trial capped at 0.60 USD by the host and the month at 25 USD by poly's own budget. The preparation is in `docs/e3/e3-9-plan.md` and the full report in `docs/e3/live-run-report.md` (data: `docs/e3/live-staged-2026-10-13.json`). **Labels on every figure of the run:** one model; 12 small tasks from the owner's repositories, 31 stages, binary stage scores; "reached the end of the plan" is not "solved the task"; the base harness is the full one with the four mechanisms off; the comparison is of two harnesses, not of models. A live run now uses the real clock, so that poly's month budget is keyed to the real month (S571, `d7d4b64a`).

### Expected before the results come in (written 2026-10-13, after a pilot and before the plan)

On tasks this size the four mechanisms have little to save. The pilot (task 1, one trial of each configuration, not counted in the plan) never reached a tenth of the window, produced no output over 10 KiB, and ran 8 to 10 agent calls costing about 0.11 to 0.12 USD; no mechanism fired. The live run is therefore **expected to show small or no differences between the base and the full harness**, and a verdict of INCONCLUSIVE. It goes ahead as planned because of what it measures whatever the differences are: the noise floor over the eight tasks that are rerun, the cost of each term on a live model (the preamble, the cache write and read, the output, the tool results), and whether the mechanisms fire at all (fusion, compaction, ObservationPack, the Reducer), with the commands the agent ran logged beside each call. The pilot also found that the classifier's table of declared runners did not hold the command the bash tool's description named (a vitest command), so that command was neither fused nor read by the Reducer; the description now names the runners of the table (`npm test`, `go test` and the others), and the table was not widened, because it is what fusion is trusted on.

### What the run found

- **Completion:** all 40 trials reached the end of their plans (20 of 20 under each harness, all 108 stages ended by `done`). There were 0 discordant pairs of 12; the verdict is INCONCLUSIVE, not "no difference". Completion is at its ceiling, so it could not tell the harnesses apart.
- **The noise floor:** 0 of the 8 rerun tasks differed in completion (a floor of zero because everything completes); reruns of one task under one harness differ by 1.6 steps on average (at most 5) and by 20% in cost on average (at most 58%).
- **Cost:** the base harness cost 2.2214 USD and the full one 2.0924 USD (5.8% less, 235 against 219 agent calls). That is inside the 20% rerun spread, so the run does not show the full harness to be cheaper. By term, the cache-read tokens fell by 36% in the full harness (the largest relative change), output and cache write by 1.5% and 3.5%, and the cheaper tier's seven readings cost 0.0275 USD. Poly's own charge equals the driver's to the micro-USD in all 40 trials, and poly's month budget accumulated to the same 4.3138 USD across the plan.
  The 36% cost saving measured on recordings (section 4) did not carry over to the live run, where the total fell 5.8%, inside the noise.
- **The mechanisms:** Action Fusion fired on 36 of 38 opportunities in the full harness (the fused action was called in 54 of 219 turns); ObservationPack archived all 9 outputs over 10 KiB and 6 reached their handle; the Reducer read all 7 long logs of a declared runner and all 7 receipts were verified, none rejected; **Online Context Compact never fired**, because no window passed a third of its limit. The commands the agent ran were `go test` and `npm test`, which the classifier's table holds.
- **Against the expectation written before the run:** small or no differences, an INCONCLUSIVE verdict, and the measures it names. All held.

## 6. Deviations from the paper, and limits

Where this example differs from SoL-Pi, by its own choice (`assumptions.json`, statement `paper-differences`):

- **A one-number pay-gate.** The machine takes one measured number, the saving over the rewrite in halves (`Measured(gain: 0..8)`), where the paper compares two. Two numbers of 0..12 made the check of `Context` need 2.5 GB. The margin is multiplicative (a saving above the rewrite times the compactions so far plus one) where the paper accounts the rewrite costs not yet recovered.
- The summary is estimated at 250 tokens; the cache ratio is the price table's; the Reducer reads the logs of the declared runners; the handle excerpt is 512 bytes of complete lines each side.

Limits, each also in the certificate:

- **S551, measured numbers in checked state.** Sizes enter as buckets; the verdict prints the unit and the domain. The tokenizer count is a trusted host measurement.
- **S552, bounded observations.** The check instance has K observation slots, checked as one slot (PS13.8a); a run with more is accepted and disclosed.
- **S553, the verifier.** HF3.2 holds relative to a handler the checker does not read. Property tests and four seeded mutant verifiers are the answer, and the handler is listed as an assumption.
- **S554, the scan.** Known secrets in four encodings and seven shapes are covered and tested by a canary; a credential of no known shape is an open assumption (`scan-verdict-unrecognised`).
- **S559, the classifier.** The table of runners is the trust; additions are outside the editable surface.
- **S560, compaction.** It is proved for when, not for what. A summary must cite the context, and its completeness is measured by stage scores, not proved.
- **The machines are proved one at a time.** The joint configuration of `Turn`, `Context` and `Trial` is an open assumption: pairs were checked at transit 2 and gave an inconclusive verdict, and transit 3 ran out of memory.
- **Two properties are held by a source lint, not a proof:** every model decision names its budget (S562), and the effect that starts a compaction and the summary decision are emitted in the same branch (S564).
- **The audience classes are declared and unused** (S566, S567); HF3.5 is held by the scan, the redaction and a step property.
- **No sandbox on the owner's Windows host.** The network rule for a task's commands rests on an environment that points the proxies at a closed port, a list of declared runners, a path check and the repositories' own tests. A program that opened a socket on purpose would not be stopped. The live run therefore runs every model-caused command in a container with no network, no key and a read-only root (`poly-e3-runner:611a58b2975d`), and the isolation check passed inside it before every one of the 40 trials (assumption `live-run-isolation`, discharged). The barrier is the container runtime's.
- **Stage scores are binary:** one check per stage.
- **The live run's reach.** One model, 12 small tasks, completion at its ceiling: it shows what each mechanism does when it has something to act on and what each term costs, and it does not show a gain from the mechanisms on long tasks, which is where the paper finds them, nor anything about Online Context Compact, which did not fire.
- **A stage is up to eight turns** (amendment A1, HF2.9): the agent works in turns, and the stage is checked once, at its `done`, at the eighth turn or at the end of the budget. The machine proves the check is once and at the end; that the agent's `done` was read right from its calls is the open assumption `done-signal`.
- **The cap of a trial is the host's.** The module's per-run cap is per decision instance, that is per Turn, so it does not bound a trial (PS18.4); the month's cap of the scope, which is poly's own, spans trials. The host refuses a model call that would take a trial past its cap, and the machines take the refusal as the end of the budget (open assumption `trial-cap`, tested). No budget scope can be keyed to a trial (a scope is the instance's module, PS8.7), so poly's own budget bounds each Turn and the month, and the host bounds the trial; the agent decision is not moved into the Trial for this example (owner, 2026-10-13).

## 7. Running it

- `npm run test:e3` runs the E3 tests one file at a time (not part of `npm test`). Heavy files admit the harness module and take a lock; no two run together.
- `node examples/harness/host/price-gate.mjs [prices|prices-live]` prints the price gate's verdict and exits 1 while any table is refused.
- `node examples/harness/host/cost-plan.mjs` prints the plans of the live run.

## Conclusion

The harness's control loop fits poly: the rules that make the four mechanisms safe are properties the checker proves, with a seeded fault for each, and what the checker cannot see (the verifier's bytes, the scan's coverage, a summary's content) is a named assumption with a test. The recorded results are recordings evidence. What a live model does with them was shown on 12 small tasks: the mechanisms fired where they had something to act on and made no difference the run can tell from noise, and compaction had nothing to act on. Longer tasks are a candidate for a later release, and this example gives it a harness whose rules are checked.

## Glossary

- **Action Fusion:** one tool call that runs an edit and its follow-up command.
- **Archive:** the machine that holds output handles and how many contexts refer to them.
- **Cache ratio:** the price of writing a prompt to the cache over the price of reading it; the pay-gate's rewrite cost.
- **Handle:** a stable reference to an archived output, with its size and an excerpt.
- **Harness:** the control loop around a model that runs its tools and manages its context.
- **INCONCLUSIVE:** the third verdict, for a comparison too small to decide; it is never "no difference".
- **Noise floor:** how much an outcome (completion, steps or cost) differs between reruns of one configuration with the model frozen.
- **Pay-gate:** the numeric condition under which a compaction is worth its cache rewrite.
- **Recordings evidence:** results from the recorded runs, carrying the three labels of section 4.
- **Stage:** one step of a task's plan, with one check.
