# E3.9: the live run, prepared and not run

*Cognitive Fab, October 2026. Written 2026-10-12 for the owner's check. Nothing in this document has been run against a model, a container or the network. Everything computed here is computed from the committed price tables and tested without a model.*

Status: the owner's choices of 2026-10-12 are applied: **Opus 5.5 for the main tier and Haiku 4.5 for the cheap tier, isolation option A (approved, and stricter than the gate item's wording), and the staged plan at $0.60 per run with $25 for the month.** Recomputing the plan with Opus prices showed that the module's reservation of $0.56 left one step, and the owner ruled the fix: **50,000 input and 4,000 output on the agent decision, the host window at 48,000 (`LIVE_WINDOW_TOKENS`), and the per-run cap from $2 to $0.60.** The module carries them. The fallback is accepted: if the pilot shows 20 to 26 steps, the staged plan on 4 tasks (32 runs at $0.78, worst case $24.96, with the noise floor from 4 tasks stated). The expected verdict of the run is INCONCLUSIVE, and the report says so (section 4).

## 1. The price tables

Read from the vendor's page, https://platform.claude.com/docs/en/about-claude/pricing, on 2026-10-12. Each table is in the PS18.3 format (micro-units per million tokens), names its source and the date it was read, and passes `node examples/harness/host/price-gate.mjs prices-live` (checked by `test/e3/e3-prices.test.mjs`).

| Tier | Model (API id) | Input | Output | Cache write (5 minute) | Cache read |
|---|---|---|---|---|---|
| main (the agent) | Claude Opus 5.5 (`claude-opus-5-5`) | $4 | $20 | $5 | $0.20 |
| cheap (summaries and receipts) | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | $1 | $5 | $1.25 | $0.10 |

Dollars per million tokens, as the page gives them. The files are `examples/harness/prices-live/main.json` and `cheap.json`.

Re-read on 2026-10-12 against the same page, including the cache-read column. The cache-read prices are right and not low: the page prices a cache hit on Opus 5.5 and Sonnet 5.5 at **0.05 times the base input price** (footnote 2 of the table, and the cache section: "$0.20 USD per million tokens on Claude Opus 5.5, $0.10 USD on Claude Sonnet 5.5"), against 0.1 times for Haiku 4.5 ($0.10 on $1). Opus 5.5 is therefore $4 input and $0.20 cache read, which is 0.05.

- **The cache write price is the 5 minute one** ($5 for Opus 5.5; the 1 hour write, $8, is on the page and is not used). The pay-gate's ratio is write over read: 25 for Opus 5.5 (the placeholder tables had 12.5). At 25 a compaction has to save more to pay. A live prompt that is not re-sent within five minutes pays a write again; the live run's calls are seconds apart.
- **These tables do not replace `prices/`.** The module reads `prices/main.json` and `prices/cheap.json`, and the committed cost report is computed from them. Adopting the live tables means copying them over `prices/`, regenerating `docs/e3/cost-report.json` (`UPDATE_E3=1`) and running the files that read prices again, one at a time. That step waits until the plan is settled, because the module's limits change in the same step.

## 2. The isolation

### What has to be true

Model-written code runs: a test or a script the agent edited, which `npm` or `go` then runs. On the Windows host that code runs as the owner, can read the owner's files and can open sockets. The owner's gate item is that the live run does not run there. The environment has to be disposable and has to reach the model API and nothing else.

### The options, and the one proposed

| Option | What stops the network | Where the key is | Verdict |
|---|---|---|---|
| **A. Split: driver on the host, every model-caused command in a no-network container** | The container has no network at all (`--network none`): no route, not a filter | On the host only, in the driver. The container never holds it. | **Proposed** |
| B. Everything in one container, API through an egress proxy | An internal network plus a proxy that allows one host | In the container that also runs the agent's commands, unless a second container is added | More parts, and the poly toolchain is not shown to run on Linux |
| C. A WSL distro made for the run | Nothing built in; WSL2 has outbound NAT, so a filter by address would have to be written and kept | In the distro | Weaker barrier. Note that the owner's existing `Ubuntu` distro mounts the Windows drives and must not be used. |
| D. Windows Sandbox | `<Networking>Disable</Networking>` in the .wsb file | In the sandbox | Not installed here (`WindowsSandbox.exe` is absent) and needs a Windows feature and a restart |

**Chosen by the owner: A.** The reason is that it needs no filter. A container with no network cannot reach the model API, and it does not need to: the driver (the poly runtime, the harness loop and the calls to the API) stays on the host, and only the effect `harness-tool` and the effect `harness-check` cross into the container. Those are the two commands the module already declares (`exec: ["harness-tool"]`, `exec: ["harness-check"]`), served by the host's exec transport, so the module does not change. The key never enters the container, so a program there cannot read it from an environment, a file or `/proc`.

**The deviation is approved by the owner.** The gate item reads "network to the model API only". Under A the environment that runs model-written code has no network at all, and the API is reached by the driver, which runs no model-written code. A is stricter than the wording.

### The setup under A

1. **Docker Desktop is installed and stopped** (WSL distros `Ubuntu` and `docker-desktop`, both stopped; checked 2026-10-12). Starting it is the owner's.
2. **An image, built beforehand, with network only at build time:** Linux node 24 and Go 1.25, `npm ci` for `todo-app` from its `package-lock.json`, `go mod download` for `snip` from its `go.sum` (both lockfiles exist), the two repositories' source at the pinned digests of `tasks/repos.json`, and a small runner program that reads one JSON request on its standard input and writes one JSON reply. The image holds no key and no network configuration.
3. **A run starts a container** from the image with `--network none`, a read-only root, a tmpfs for scratch, one writable volume for the task's copy, a non-root user, no host mounts, `--memory 2g`, `--cpus 2`, `--pids-limit 512`, and no environment but the allow-list of `commandEnv`.
4. **The exec transport** (`host/transports.mjs`) sends `harness-tool` and `harness-check` to the runner with `docker exec -i`. The copy is made inside the volume by the runner from the image's pinned source, never from a path of the host.
5. **The oracle is run again inside the container** before any model call: all 12 tasks and 31 stages must fail before their fix as a test and pass after it, on Linux. The proofs so far were made on Windows and are not evidence for Linux (line endings, paths, native packages).
6. **The check from inside** is `host/isolation-check.mjs`, run in the container as the user the commands run as: `docker run --rm --network none ... node isolation-check.mjs`. It makes a positive control (it connects to a listener of its own, so a failure to connect cannot come from a broken probe), then requires every one of these to fail to connect: 1.1.1.1:443, 8.8.8.8:53, example.com:443, github.com:443, registry.npmjs.org:443, proxy.golang.org:443, pypi.org:443, 169.254.169.254:80 (and the host gateway and `host.docker.internal`, added to the call), and requires that the environment holds no credential-looking variable and that `/proc/mounts` shows no mount of the Windows host. Under A the `--reachable` list is empty. The run is refused unless it exits 0, and its output is copied into `decisions-e3.md`.
7. **Teardown:** `docker rm -f` the container and `docker volume rm` the copy volume after the trial's work is read out; for a capped trial the work is saved first (HF3.9) into `.poly/e3-tasks/`, as a file copy out of the volume. The image is rebuilt, not reused, for a later run.

What this does not give, stated: the barrier is the container runtime's, the same trust as any container. A kernel or runtime escape is out of scope. The oracle's own commands (the repositories' tests) are the only code that ran on the host so far.

### What is tested now

`host/isolation-check.mjs` is tested on the loopback only (6 of 6): its control, a barrier and a breach, a credential variable, a host mount, and that an unreadable mount table fails. It has not been run in any container.

## 3. The cost plan, recomputed with Opus 5.5

### What changed

The worst case is a guarantee, not an estimate. A run's budget gate admits a call only when what the run has spent plus that call's reservation stays inside the run's cap, and a call within its limits costs no more than its reservation (PS18.3, K15). So a run spends at most its cap, N runs cost at most N times the cap, and the month's cap of $25 is a second hard stop. The reservation is `ceil((I x P_in + N x P_out) / 10^6)`, with I the decision's input limit and N its output limit at the highest price of any class but input. A run stops when spent plus the reservation would pass its cap, so **the spendable part of a cap is the cap less the reservation.**

The agent decision declares `max input tokens 100000` and `max tokens 8000`. At the Opus 5.5 prices:

> reservation = 100,000 x $4 + 8,000 x $20, per million = **$0.40 + $0.16 = $0.56**

Under the staged plan's cap of $0.60 the spendable amount is **$0.04, which buys 1 step.** At the largest cap 40 runs allow ($25 / 40 = $0.625) it is $0.065, which buys 3 steps. As the module stands, the staged plan at Opus prices runs nothing useful. (With Sonnet 5.5 the reservation was $0.28 and the same cap bought 32 steps.)

### The cost of a step at Opus prices (assumptions, not measurements)

Assumed: a preamble of 5,000 tokens, 300 output tokens and 1,200 tool tokens a step, the previous request's whole input read from the cache and the new tokens written to it.

| Steps in a trial | 10 | 16 | 30 | 60 |
|---|---|---|---|---|
| Cost at Opus 5.5 | $0.17 | $0.28 | $0.57 | $1.40 |

### The fix proposed: lower the declared limits of the agent decision

`max input tokens 100000` is more window than the tasks use, and `max tokens 8000` is more than a step writes. The reservation is made from these limits, not from what a step uses, so they are the cheapest lever. Other limits at the staged plan's $0.60 cap (40 runs, worst case $24):

| Max input | Max output | Reservation | Spendable | Steps the cap buys | Steps before the input limit |
|---|---|---|---|---|---|
| 100,000 (module now) | 8,000 | $0.56 | $0.04 | 1 | 64 |
| 60,000 | 4,000 | $0.32 | $0.28 | 16 | 37 |
| **50,000** | **4,000** | **$0.28** | **$0.32** | **18** | 31 |
| 40,000 | 4,000 | $0.24 | $0.36 | 20 | 24 |
| 40,000 | 2,000 | $0.20 | $0.40 | 22 | 24 |
| 30,000 | 2,000 | $0.16 | $0.44 | 23 | 17 |

**Proposed: 50,000 input and 4,000 output.** The reservation is $0.28, the cap buys 18 steps, and the input limit (31 steps) is not what binds, so the cap is the only limit a trial meets. It also requires the host's window to be set under the limit so that the harness compacts before a request is refused: the loop's `windowTokens` is 48,000 live (its limit bucket starts at five sixths of that, 40,000). The cheap tier's decisions (summaries and receipts) can keep their limits or take the same 50,000 input, which lowers their reservation from $0.12 and $0.11 to $0.07 and $0.06.

**What it costs the plan.**

- **A trial that needs more than 18 steps is stopped by its cap** and counts as not completed, in both configurations. At the assumed sizes a 16-step trial costs $0.28 and a 30-step trial $0.57, so a task whose stages need more than about 18 steps cannot finish under this cap. This is the real price of Opus at $25. The pilot measures the steps a task takes before the plan goes on.
- **A step may write at most 4,000 tokens.** A whole-file write above that is cut off (the harness reprompts after a cutoff, HF3.7) and costs a step.
- It is a module edit (two limits of one decision, and the per-run cap from `cap usd 2 per run` to `cap usd 0.60 per run`). The gate-reach file and the HAC1 file are then run again, one at a time, and the reservation test of HF3.6 (the cap check, PL6845) is checked at the new values. Nothing is edited until the owner rules.

### The plans with the proposed limits

| Option | Runs | Per-run cap | Worst case | Spendable | Steps the cap buys | Pairs | Smallest gain detected (80% power) | Noise floor |
|---|---|---|---|---|---|---|---|---|
| **Staged** (the owner's choice) | 24, then 16 reruns of 8 tasks | $0.60 | $24.00 | $0.32 | 18 | 12 | 0.50 | from 8 tasks |
| Staged on 4 | 24, then 8 reruns of 4 tasks | $0.78 | $24.96 | $0.50 | 26 | 12 | 0.50 | from 4 tasks (steps of 1/4) |
| Full | 48 | $0.50 | $24.00 | $0.22 | 12 | 12 | 0.50 | from 12 tasks |
| Eight tasks | 32 | $0.75 | $24.00 | $0.47 | 25 | 8 | 0.70 | from 8 tasks |
| Single run | 24 | $1.00 | $24.00 | $0.72 | 36 | 12 | 0.50 | none |

- **Staged on 4** is the alternative if the pilot shows trials of 20 to 26 steps: a larger cap for the same $25, at the price of a noise floor measured on 4 tasks, which can only say 0, 25, 50, 75 or 100 percent of tasks disagree. It keeps all 12 pairs.
- **Full, Eight tasks and Single run** are as before: Full's cap buys 12 steps, Eight tasks detects only a gain of 0.70, Single run has no floor.
- **Opus against Sonnet** is the other lever, and the owner has ruled on it: Sonnet 5.5 halves the cost of a step ($0.14 for 16 steps) and the same plan buys 32 steps. It is not proposed again.

At the assumed sizes the expected cost is 40 runs at $0.17 to $0.32 each (a trial longer than 18 steps costs its $0.32 spendable amount, and stops), $7 to $13. The guarantee is $24.

### Completion under a cap partly measures cost

Under a fixed cap a configuration that spends fewer tokens per step gets more steps, so "completed under the cap" measures skill and cost together. The README and the report say so plainly. The report also gives the runs a cap stopped, and compares completion again on the tasks that fit inside the cap in both configurations (`instance.underCap` in `host/paired.mjs`, with its own exact test); that comparison does not depend on cost, has fewer tasks and detects less. It is reported beside the verdict and does not decide it.

### The pilot

The first two trials are task 1 under the base and under the full configuration, with the plan's settings, and they are real trials of the plan (they count in it, so the pilot costs nothing extra). After them the run stops and reports: steps, tokens by class, cost, whether a cap stopped either, and the preamble measured from the request. The assumptions above are replaced by those figures, the plan is recomputed (`host/cost-plan.mjs`), and the run goes on only if the recomputed worst case still fits and the owner agrees.

## 4. What the run will and will not show

At 12 pairs the smallest gain detected at 80% power is 0.50, so the verdict on completion will almost certainly be INCONCLUSIVE, and the report says so plainly, not as "no difference". The run is worth doing for three other things:

1. **The noise floor**, measured from reruns with the model frozen, which a recording cannot give (its floor is zero by construction).
2. **Action Fusion's saving**, which a recording cannot show. The fused action is exposed in the tool schema in this run (the paper found prompt-only triggering unreliable).
3. **The cost terms on a live model**: the preamble, the cache read and write, the real tokens a step adds, and the pay-gate's ratio at the vendor's prices.

Every figure carries its labels: the task set of 12 from the owner's repositories, 31 stages, binary stage scores, "reached the end of the plan" and not "solved the task", the noise floor measured on 8 tasks, the model and the price tables with their date, and the isolation used.

## 5. The run is refused until

1. The owner has checked the price tables and `node examples/harness/host/price-gate.mjs` exits 0 on the tables the module reads.
2. The owner has ruled on the limits of section 3, and the module carries the plan's per-run cap and the agent decision's limits.
3. The image is built, the oracle passes inside the container (31 of 31 stages), and `isolation-check.mjs` exits 0 inside it, with its output recorded in `decisions-e3.md`.
4. The owner has set the key, in the host's driver only, and the pilot's two trials have been read.
5. The gate-reach file and the HAC1 file have been run again after any module edit, one at a time.

## Conclusion

The price tables, the isolation and the cost plan are ready for the owner's check, and nothing has been run. The tables pass the gate. The isolation is a container with no network for every command a model causes, with the key kept on the host (the owner's choice). The plan is 40 runs in two stages at a $0.60 cap, a worst case of $24, which keeps all 12 pairs and measures the noise floor on 8 tasks. At Opus 5.5 prices the module's reservation of $0.56 leaves 1 step under that cap; lowering the agent decision's limits to 50,000 input and 4,000 output makes it $0.28 and buys 18 steps, which the owner is asked to rule on. The verdict at 12 pairs will be INCONCLUSIVE, and the run is worth its cost for the noise floor, the saving of fusion and the cost terms.

## Glossary

- **Cap:** the most a run may spend, enforced by the budget gate before each call.
- **Detectable gain:** the smallest difference of completion rates the task set detects at 80% power with the exact test.
- **Noise floor:** the share of tasks whose outcome differs between reruns of one configuration with the model frozen.
- **Reservation:** the most one call can cost, taken before it is admitted (PS18.3).
- **Spendable part of a cap:** the cap less the largest reservation.
