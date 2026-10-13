# examples/harness: a checked agent harness

> **DRAFT.** This file is marked a draft until the E3.9 results are in. Sections 5 and 6 name what the live run adds; nothing in them is a result yet. Figures from the recorded runs are recordings evidence and carry the three labels of section 4 wherever they appear.

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

## 5. The live run (draft: not yet run)

One bounded live run is planned (E3.9), reported as a result and not as a test, capped at $25 by poly's own budget, with the owner's key. The preparation is in `docs/e3/e3-9-plan.md`: the price tables, the isolation (a disposable environment, because a model can edit a test that `npm` or `go` then runs), and the cost plan. The live report will state, whatever it shows:

- the verdict, which at 12 pairs will almost certainly be INCONCLUSIVE: the smallest gain detected at 80% power is 0.50;
- **completion under a cap partly measures cost.** Every run has a fixed cap (0.60 USD, of which the spendable part is 0.32 USD, about 18 steps at the assumed sizes), and a configuration that spends fewer tokens per step gets more steps inside it. "Completed under the cap" therefore measures skill and cost together, and the report says so beside the verdict. It also reports which runs a cap stopped, and compares completion again on the tasks that fit inside the cap in both configurations (`instance.underCap` of `host/paired.mjs`), which does not depend on cost. That second comparison has fewer tasks and detects less;
- the noise floor, measured from reruns with the model frozen (a replay of a recording has a floor of zero by construction, which is not a measurement);
- Action Fusion's saving, with the fused action exposed in the tool schema;
- the cost terms on a live model: the preamble, the cache read and write, the tokens a step adds;
- the McNemar gap: with 12 pairs an exact one-sided test reaches 0.05 only for all of 5 discordant pairs one way, 7 of 8, or 8 of 9 (6 of 7 gives 0.0625).

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
- **No sandbox on the owner's Windows host.** The network rule for a task's commands rests on an environment that points the proxies at a closed port, a list of declared runners, a path check and the repositories' own tests. A program that opened a socket on purpose would not be stopped. The live run therefore runs model-caused commands only in the isolated environment (assumption `live-run-isolation`, open until the environment is named and checked from inside).
- **Stage scores are binary:** one check per stage.
- **A stage is up to eight turns** (amendment A1, HF2.9): the agent works in turns, and the stage is checked once, at its `done`, at the eighth turn or at the end of the budget. The machine proves the check is once and at the end; that the agent's `done` was read right from its calls is the open assumption `done-signal`.
- **The cap of a trial is the host's.** The module's per-run cap is per decision instance, that is per Turn, so it does not bound a trial (PS18.4); the month's cap of the scope, which is poly's own, spans trials. The host refuses a model call that would take a trial past its cap, and the machines take the refusal as the end of the budget (open assumption `trial-cap`, tested). No budget scope can be keyed to a trial (a scope is the instance's module, PS8.7), so poly's own budget bounds each Turn and the month, and the host bounds the trial; the agent decision is not moved into the Trial for this example (owner, 2026-10-13).

## 7. Running it

- `npm run test:e3` runs the E3 tests one file at a time (not part of `npm test`). Heavy files admit the harness module and take a lock; no two run together.
- `node examples/harness/host/price-gate.mjs [prices|prices-live]` prints the price gate's verdict and exits 1 while any table is refused.
- `node examples/harness/host/cost-plan.mjs` prints the plans of the live run.

## Conclusion

The harness's control loop fits poly: the rules that make the four mechanisms safe are properties the checker proves, with a seeded fault for each, and what the checker cannot see (the verifier's bytes, the scan's coverage, a summary's content) is a named assumption with a test. The recorded results are recordings evidence. What a live model does with them is the live run's to show, and this file stays a draft until it has.

## Glossary

- **Action Fusion:** one tool call that runs an edit and its follow-up command.
- **Archive:** the machine that holds output handles and how many contexts refer to them.
- **Cache ratio:** the price of writing a prompt to the cache over the price of reading it; the pay-gate's rewrite cost.
- **Handle:** a stable reference to an archived output, with its size and an excerpt.
- **Harness:** the control loop around a model that runs its tools and manages its context.
- **INCONCLUSIVE:** the third verdict, for a comparison too small to decide; it is never "no difference".
- **Noise floor:** the share of tasks whose outcome differs between reruns of one configuration with the model frozen.
- **Pay-gate:** the numeric condition under which a compaction is worth its cache rewrite.
- **Recordings evidence:** results from the recorded runs, carrying the three labels of section 4.
- **Stage:** one step of a task's plan, with one check.
