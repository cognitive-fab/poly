# E3.9: the live run, prepared and not run

*Cognitive Fab, October 2026. Written 2026-10-12 for the owner's check. Nothing in this document has been run against a model, a container or the network. Everything computed here is computed from the committed price tables and tested without a model.*

Status: a proposal with three parts for the owner to check (the price tables, the isolation, the cost plan) and the list of what the run is refused for. The expected verdict of the run is INCONCLUSIVE, and the report says so (section 4).

## 1. The price tables

Read from the vendor's page, https://platform.claude.com/docs/en/about-claude/pricing, on 2026-10-12. Each table is in the PS18.3 format (micro-units per million tokens), names its source and the date it was read, and passes `node examples/harness/host/price-gate.mjs prices-live` (checked by `test/e3/e3-prices.test.mjs`).

| Tier | Model (API id) | Input | Output | Cache write (5 minute) | Cache read |
|---|---|---|---|---|---|
| main (the agent) | Claude Sonnet 5.5 (`claude-sonnet-5-5`) | $2 | $10 | $2.50 | $0.10 |
| cheap (summaries and receipts) | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | $1 | $5 | $1.25 | $0.10 |

Dollars per million tokens, as the page gives them. The files are `examples/harness/prices-live/main.json` and `cheap.json`.

Three things for the owner to check or choose:

- **The choice of models is the owner's.** The page also lists Opus 5.5 ($4 input, $20 output) and Haiku 5.5 ($0.10 input and $0.50 output up to 100,000 tokens of prompt). Sonnet 5.5 and Haiku 4.5 are chosen because they are the mid-priced agent and the cheap tier whose API ids are known to this repository's tooling. A different choice changes the two files only.
- **The cache write price is the 5 minute one.** The 1 hour write ($4 for Sonnet 5.5) is on the page and is not used. The pay-gate's ratio is write over read: 25 for Sonnet 5.5 (the placeholder tables had 12.5). At 25 a compaction has to save more to pay, so the recorded finding "the gate chooses no compaction on this corpus" holds more strongly. A live prompt that is not re-sent within five minutes pays a write again; the live run's calls are seconds apart.
- **These tables do not replace `prices/`.** The module reads `prices/main.json` and `prices/cheap.json`, and the committed cost report is computed from them. Adopting the live tables means copying them over `prices/`, regenerating `docs/e3/cost-report.json` (`UPDATE_E3=1`) and running the files that read prices again, one at a time. That step waits for the owner's check.

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

**Proposed: A.** The reason is that it needs no filter. A container with no network cannot reach the model API, and it does not need to: the driver (the poly runtime, the harness loop and the calls to the API) stays on the host, and only the effect `harness-tool` and the effect `harness-check` cross into the container. Those are the two commands the module already declares (`exec: ["harness-tool"]`, `exec: ["harness-check"]`), served by the host's exec transport, so the module does not change. The key never enters the container, so a program there cannot read it from an environment, a file or `/proc`.

**A deviation to approve.** The gate item reads "network to the model API only". Under A the environment that runs model-written code has no network, and the API is reached by the driver, which runs no model-written code. If the owner wants the driver inside the isolated environment as well, that is B, with the cost stated above. The decision is the owner's.

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

## 3. The cost plan

### The worst case is a guarantee, not an estimate

A run's budget gate admits a call only when what the run has spent plus that call's reservation stays inside the run's cap, and a call within its limits costs no more than its reservation (PS18.3, K15). So a run spends at most its cap, and N runs cost at most N times the cap. The reservation of the agent decision, from its declared limits (100,000 input tokens, 8,000 output) at the live prices, is $0.28. The month's cap of $25 is a second hard stop: no call is admitted past it, so the run cannot overspend. What it can do is run out of month before the plan is done. The plan below is chosen so that it cannot.

**The reservation also limits a run in practice.** A run stops when spent plus $0.28 would pass its cap, so the spendable part of a cap is the cap less $0.28. A cap of $0.25 or less lets no call through.

### The expected cost, from assumptions

Assumed (to be replaced by the pilot's measured figures, not measured): a preamble of 5,000 tokens (system prompt and tool schemas, with the fused action), 300 output tokens and 1,200 tool tokens a step, the previous request's whole input read from the cache and the new tokens written to it.

| Steps in a trial | 10 | 16 | 30 | 60 |
|---|---|---|---|---|
| Cost at the live prices | $0.086 | $0.14 | $0.29 | $0.70 |

The 31 stages of the 12 tasks are checked after a few steps each, so a trial of 10 to 30 steps is the range to expect. The cheap tier's calls (summaries, receipts) are a few cents.

### The options

48 runs at the $1 cap is $48 at worst, over the month's cap. Four plans fit $25 at worst:

| Option | Runs | Per-run cap | Worst case | Spendable per run | Steps before the cap | Pairs | Smallest gain detected (80% power) | Noise floor |
|---|---|---|---|---|---|---|---|---|
| **Staged** (proposed) | 24 first runs (12 tasks, both configurations), then 16 reruns (8 tasks, both configurations) | $0.60 | $24.00 | $0.32 | 32 | 12 | 0.50 | from 8 tasks, two runs each |
| Full | 48 (12 tasks, both configurations, two reruns) | $0.50 | $24.00 | $0.22 | 23 | 12 | 0.50 | from 12 tasks |
| Eight tasks | 32 (8 tasks, both configurations, two reruns) | $0.75 | $24.00 | $0.47 | 44 | 8 | 0.70 | from 8 tasks |
| Single run | 24 (12 tasks, both configurations, once) | $1.00 | $24.00 | $0.72 | 61 | 12 | 0.50 | none |

What each costs in power:

- **Staged** keeps all 12 pairs, so the detectable gain is the same 0.50 as the full plan, and gives each run a larger cap. It measures the noise floor on 8 tasks rather than 12, so the floor has a coarser resolution (steps of 1/8). The 8 tasks for the reruns are fixed before the run, by a rule that does not look at results: the four tasks of each repository with the most stages. Choosing reruns by outcome (rerun the discordant tasks) would bias the floor and is not proposed.
- **Full** has the best floor and the tightest cap: a trial longer than 23 steps is stopped by its cap and counts as not completed in both configurations. If the pilot shows trials near that length it should not be chosen.
- **Eight tasks** is cheaper per pair and detects only a gain of 0.70, which no plausible harness change reaches. It is listed to show what dropping tasks costs; it is not proposed.
- **Single run** is the only plan with a large cap and it measures no noise floor, which the gate item of the run exists to measure (HAC3 asks for at least two runs of each configuration). Not proposed.
- **A lower reservation** is a separate lever. The module declares a reservation of $0.28 through `max input tokens 100000` and `max tokens 8000`. Lowering them (to 40,000 and 4,000, a reservation of $0.12) raises the spendable part of every cap by $0.16 and allows a smaller per-run cap with the same steps. It is a module edit: the gate-reach file and the HAC1 file have to be run again, one at a time. It also has to be checked against the real size of a request (a transcript over 40,000 tokens would be refused).

The per-run cap in the module is `cap usd 2 per run`. Any plan above needs it changed to the plan's cap, which is also a module edit with the same two files run again. The change is made when the owner chooses the plan.

### The pilot

The first two trials are task 1 under the base and under the full configuration, with the plan's settings, and they are real trials of the plan (they count in it, so the pilot costs nothing extra). After them the run stops and reports: steps, tokens by class, cost, whether a cap stopped either, and the preamble measured from the request. The assumptions of this section are then replaced by those figures, the plan is recomputed (`host/cost-plan.mjs`), and the run goes on only if the recomputed worst case still fits and the owner agrees.

Expected cost at the assumed sizes: a 16-step trial costs about $0.14, so 40 runs cost about $6 to $12 in the likely range of 16 to 30 steps. The worst case of $24 is the guarantee.

## 4. What the run will and will not show

At 12 pairs the smallest gain detected at 80% power is 0.50, so the verdict on completion will almost certainly be INCONCLUSIVE, and the report says so plainly, not as "no difference". The run is worth doing for three other things:

1. **The noise floor**, measured from reruns with the model frozen, which a recording cannot give (its floor is zero by construction).
2. **Action Fusion's saving**, which a recording cannot show. The fused action is exposed in the tool schema in this run (the paper found prompt-only triggering unreliable).
3. **The cost terms on a live model**: the preamble, the cache read and write, the real tokens a step adds, and the pay-gate's ratio at the vendor's prices.

Every figure carries its labels: the task set of 12 from the owner's repositories, 31 stages, binary stage scores, "reached the end of the plan" and not "solved the task", the noise floor measured on 8 tasks, the model and the price tables with their date, and the isolation used.

## 5. The run is refused until

1. The owner has checked the price tables and `node examples/harness/host/price-gate.mjs` exits 0 on the tables the module reads.
2. The owner has chosen the isolation and the plan, and the module carries the plan's per-run cap.
3. The image is built, the oracle passes inside the container (31 of 31 stages), and `isolation-check.mjs` exits 0 inside it, with its output recorded in `decisions-e3.md`.
4. The owner has set the key, in the host's driver only, and the pilot's two trials have been read.
5. The gate-reach file and the HAC1 file have been run again after any module edit, one at a time.

## Conclusion

The price tables, the isolation and the cost plan are ready for the owner's check, and nothing has been run. The tables pass the gate. The proposed isolation is a container with no network for every command a model causes, with the key kept on the host. The proposed plan is 40 runs in two stages at a $0.60 cap, a worst case of $24, which keeps all 12 pairs and measures the noise floor on 8 tasks. The verdict at 12 pairs will be INCONCLUSIVE, and the run is worth its cost for the noise floor, the saving of fusion and the cost terms.

## Glossary

- **Cap:** the most a run may spend, enforced by the budget gate before each call.
- **Detectable gain:** the smallest difference of completion rates the task set detects at 80% power with the exact test.
- **Noise floor:** the share of tasks whose outcome differs between reruns of one configuration with the model frozen.
- **Reservation:** the most one call can cost, taken before it is admitted (PS18.3).
- **Spendable part of a cap:** the cap less the largest reservation.
