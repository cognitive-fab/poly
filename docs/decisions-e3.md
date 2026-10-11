# poly · Decisions for E3, the checked harness

Steps, results and rulings of the branch `e3` (the harness example of `proposals/example-harness.md`), in the order they happen. Each entry names who ruled.

## plan-e3 ruled (owner, 2026-10-11)

The plan (`plan-e3.md`, 62c7d7e3) is accepted. Rulings:

- **Q-E3-1, ruled yes.** One bounded live run (E3.9), reported as a result and not as a test. The cap is $25, enforced by poly's own budget. The owner sets the key. In the suite, cost and stage statistics run on recordings.
- **Q-E3-2, as recommended.** The poly harness owns the loop and reaches tools over MCP as a client. The base is the same harness with the four mechanisms switched off.
- **Q-E3-3.** The 12 offline tasks come from the owner's small personal repositories (todo-app, md2pdf, snip and the like), with a check per stage. The originals are read-only: each is copied into a scratch folder. A negative result at that size is reported as inconclusive.
- **Q-E3-4.** The fallbacks are used. No core changes in E3.
- **Q-E3-5, as recommended.** The PS18.3 price-table format, following `examples/inbox/prices/`, with source and date read from the vendor's page.
- **Q-E3-6, as recommended.** The score is per stage, the failing stage is the first, and regression is reported per stage.
- **S550 to S560, accepted on their fallbacks.** Each limit is stated in the certificate and the README.

Start: E3.0, measure first. One heavy job on the machine at a time, shared with the M7 session.

## E3.0: measure first (2026-10-11)

Set-up: `npm ci` and `tsc -b` in `poly-e3`; no `node --test` ran on the machine (checked with the process list, M7 included). The probes are in `experiments/e3-probes/` (not under `examples/`, so not measured files). Each is a discarded fixture whose job was one answer. Checks ran with `node packages/poly-check/dist/src/cli.js check`, each in under 10 s except the largest configuration.

| Probe | Question | Answer |
|---|---|---|
| p1 | S550: can a budgeted unrouted decision return a record with `Content` and a stop reason? | **No.** `{ stop: Stop, calls: Content }` is `PL1209 CONTENT_NOT_OPAQUE` (a `Content` is no record field, PS1.4a) and then `PL1101` (a decision's result is finite or one `Content`). **Works:** the decision returns `Content` alone (`calls`), with `budget` and `prices … max input tokens … max tokens …` (S454), and the stop reason enters as a separate host-reported action `Metered(s: Stop)`. Under it, `never cutoff-recovers: emit endStep() while stop == Length && reprompts < 1` gives `PL3002` with a 4-step witness (the seeded violation), so the rule fires. An effect taking a `Content` argument is accepted. |
| p1 | Budget forms for the live run's $25 cap | `cap usd 1 per run` (a task's cap, per decision instance) and `cap usd 25 per month per scope` (PS18.4) are both accepted. The scope cap spans the module; a period cap resets by the runtime's UTC clock, so the live run must not cross a month boundary. |
| p2 | S552: fan-out to K observation slots with a handle invariant | Explicit refs `o1 … oK` in `Session` (there is no group broadcast). A configuration of one `Session`, K `Observation`s and K `Archive`s, 3 requests, with `handled-resolves` and `twice-then-handle` as configuration invariants (both hold, neither vacuous): **K=1, 52 global states; K=2, 898; K=3, 17,984** (8 s, and `PL5301 TRANSIT_BOUND_HIT` at the bound K·R+2); **K=4 did not finish in 230 s** and gave no verdict. The growth is a factor of 17 to 20 per slot. The invariants are per slot, and slots interact only through identical messages from the session, so by PS13.8 (steps of different instances commute) a K-slot run projects onto a 1-slot run. **The 1-slot configuration is the check; K is not a bound.** This replaces the plan's K-slot fallback and needs a PS13 paragraph stating the projection (S552, for ruling as text). A first draft also showed that a handle must be issued only after the archive's `Stored` ack arrives; `Pending` is a state of `Observation` for that reason. |
| p3 | S558: a policy scope refuses a network tool | **Yes, proved by the checker.** `never offline-no-network "...": allow when proposal.kind == "effect" && effect.labels has "egress:external"` gives `PL6503 NEVER_VIOLATED` with a 1-step witness when a catch-all allow rule is in force and the machine has a network effect (the seeded variant for HF3.10), and `CLEAN` once a `deny` obligation on that label precedes the allow. No host check is needed. |
| p4 | S555: what the score reader can read | `JournalReader.journal(instanceId)` returns rows `{ seq, action, data, pre, post, step_kind, reject_reason, action_id, at }` (`@poly/runtime`, `readerOf`). A stage check is an action `StageChecked(k, passed)` on `Session`, so the first failed check is the first accepted row of that action with `passed == false`, and the stage is `post.step`. The reader needs the stage index in `Session`'s state. No new API. |
| p5 | S551: a compaction gate over bucketed numbers | A gate with `saving > rewrite` over `0..16` buckets, `never emit compact while mode is Working && ctx < 14`, checks in under a second. It found two design faults of mine, kept as requirements (S561): a compaction that does not shrink the context loops at the limit without end (`PL3102 DOMAIN_ESCAPE` on the compaction counter, 9-step witness), and once the compaction is required to shrink, a context that cannot shrink is `PL3201 DEADLOCK`. So the model needs `CompactFailed`, which ends the trial `stopped(overflow)` with the reason (HF3.8 after one attempt), and a compaction completes only with a smaller size. |

**Counts for E3.2.** No full `Session` was measured yet; its state count is E3.2's first number. The probes bound it: `Session` alone is small (p1 13 states, p5 under 100), and the configuration is checked per slot.

### Changes to the plan from E3.0

- **S550, amended.** The decision returns `Content` only. The stop reason is a host-reported fact, `Metered(stop)`, like a token count, and the certificate lists it among the trusted measurements. The two completions (the decision's and the host's) may arrive in either order, and the checker explores both; `Session` takes the next step only when it has both.
- **S552, replaced.** The 1-slot configuration with the projection argument, in place of K slots. The README states the argument.
- **S558, confirmed** as the checker's own policy stage; no host check.
- **S555, confirmed**, on the existing journal reader.
- **S561, new.** A compaction must shrink the context and may fail; failure ends the trial with the overflow reason after one attempt. Both are properties of the harness module (HF3.8), not core changes.

No count reached the checker's bound in the design chosen, and no probe failed without a fallback, so E3.1 starts. Next: E3.1, the failing tests of HAC1.

## S552, the projection: ruled with conditions, written and evidenced (owner, 2026-10-11)

Ruled: the projection is accepted if the PS13 paragraph carries three conditions (per-slot properties; identical messages from the session; nothing the session does depends on how many slots exist or which answered), says that where the session waits for or aggregates slots the projection does not apply and K stays a bound, and is backed by a seeded per-slot violation agreeing at K = 1, 2 and 3 with the clean module clean at all three.

Written as **PS13.8a** in `docs/04-semantics.md`, after PS13.8 (spec text only; no code or checker change; the checker does not apply the projection, the author writes the one-slot configuration).

Evidence (`experiments/e3-probes/p2/gen.mjs`; the machines are service machines, the transit bound is K·R + 2K, R = 3; this replaces the E3.0 figures, which had `PL5402 STUCK` and `PL5301` findings of the probe's own making):

| K | clean module | seeded module (a slot is handled after 2 sends, not 3) |
|---|---|---|
| 1 | CLEAN, 52 global states | FINDINGS: `PL5401 twice-then-handle-1`, 7-step witness |
| 2 | CLEAN, 898 | FINDINGS: `PL5401` on slots 1 and 2, slot 1's witness the same 7 steps |
| 3 | CLEAN, 17,992 | FINDINGS: `PL5401` on slots 1, 2 and 3, slot 1's witness the same 7 steps |

The 7 steps are `Req@s`, `Req@s`, `Put@o1`, `Store(o1) -> a1`, `Stored() -> o1`, `Sent() -> o1`, `Sent() -> o1`. The other slots' witnesses have the same shape on their own slot. A condition of the harness, to be stated in its README: the real `Session` sends each observation the same `Sent` per request and reads nothing from the slots, so (1) to (3) hold for the handle and twice-sent properties; the budget and the context size are properties of `Session` alone and are not projected.

## E3.1: the rules, tests first (2026-10-11)

`test/e3-hac1.test.mjs`: 12 tests, all failing, each because `examples/harness/harness.poly` does not exist (ENOENT): one control (the module is `CLEAN` with its policy, and no rule is vacuous), ten seeded variants (HF3.1 to HF3.10) and the change gate (HF3.11). A variant replaces the one line tagged `// @HF3.n` in the module, so E3.2 must write each guard as one tagged line; the test header is the contract (rule, place, guard, expected code).

| Rule | Variant | Expected |
|---|---|---|
| HF3.1 | the gate allows compaction mid-step below the limit | `PL3002` with a witness |
| HF3.2 | `Show` accepts a rejected receipt | `PL3002` with a witness |
| HF3.3 | `Put` makes an observation `Full` before the archive stores | `PL5401` in the 1-slot configuration, with a witness (PS13.8a) |
| HF3.4 | fusion without the classifier's word | `PL3002` with a witness |
| HF3.5 | a flagged log stored as clean | `PL3002` with a witness (the canary of E3.3 is the other half) |
| HF3.6 | a reservation above the per-run cap | `PL6845` (a static refusal, no witness) |
| HF3.7 | a step ended on a cutoff with no reprompt | `PL3002` with a witness |
| HF3.8 | overflow ends the trial with no compaction tried | `PL3002` with a witness |
| HF3.9 | a cap ends the trial before the work is saved | `PL3002` with a witness |
| HF3.10 | the offline deny rule no longer matches network effects | `PL6503` with a witness |
| HF3.11 | `checkChange` refuses a rule file, the policy, a price table, the gate itself or a path outside `editable/` | a unit test (host code) |

**A limit found while writing HF3.6 (S562, for the record, no ruling asked).** A model decision that names no `budget` is not a finding: the checker proves the `Budget` invariant for the decisions that name it, and `PL6845` for a reservation that cannot fit, but nothing flags a decision with no budget clause, and the policy inputs (`effect.kind`, `labels`, `class`, `taint`, `items`, `provenance`) do not carry the budget. So HF3.6's variant is the reservation above the cap, and the unbudgeted decision is covered by a source test (E3.2: every `decision` in the module names `budget task`), which is a lint, not a proof. The certificate and README state this. A core check (a decision with no budget in a module that declares one) would close it; it is a core change, so E3 does not make it. The owner may rule it into a later release.

The tests are not committed to the measured set: nothing under `examples/` exists yet. Next: E3.2, the machines and the policy.

## Rulings after E3.1 (owner, 2026-10-11)

- **The probe rebuild is accepted.** The E3.0 figures for S552 are withdrawn; the table in the S552 entry above is the evidence for PS13.8a.
- **Commit 427aef51 stands.** It is not split and history is not rewritten. It carries the evidence (the probe generator and this record) along with the spec text of PS13.8a. Rule 7a's order held: the spec text came before the tests, and no code existed.
- **E3.1 accepted.** The tagged one-line guards are the contract. Any change to a replacement line is recorded in the test header and here. Changes made in E3.2 are listed below.
- **S562 accepted as a stated limit.** The source-scan lint stays (`test/e3-lint.test.mjs`), and the certificate and the README say it is a lint, not a proof. The core check belongs with M7.5, where the S359 budgets put a budget on the workflow: under a budgeted workflow, every model decision must name a budget. The owner carries it to M7 as a candidate requirement. E3 does not make the change.
- **E3.2: go.** M7 runs a full suite next: no checker run at K = 3 or above until it finishes. E3.2 runs none (the observation slot is checked as one slot, PS13.8a); the targeted runs below were single machines and the 1-slot configuration.

## E3.2: the machines and the policy (2026-10-11)

`examples/harness/harness.poly` (first line `// expected: CLEAN`), `harness.policy.poly`, `prices/main.json` and `prices/cheap.json` (placeholders with `example.com` as source; the vendor's page is read at E3.9, Q-E3-5), `editable/` (a system prompt, one skill, `thresholds.json`) and `host/change-gate.mjs`. `test/e3-hac1.test.mjs`: **12 of 12 pass**; `test/e3-lint.test.mjs`: 2 of 2; `test/examples-check.test.mjs` and `test/examples-expected.test.mjs` (which now include the harness): 22 of 22 and 27 of 27 with two neighbours; `npm run check:boundaries` passes. The full suite was not run (M7's turn).

**The verdict, with its checked instance.** `poly check examples/harness` is `CLEAN` with the policy, and no rule is vacuous. Counts: Turn 199 states, Context 660, Trial 80, Receipt 12, Observation 7, Archive 3, Ledger 4, `task.Budget` 96, configuration `pack` (one observation slot, PS13.8a) 52 global states. About 7 s a check.

**What E3.2 found, and did about it.**

1. **One machine does not fit.** The first `Session` of 18 fields ran the checker out of memory twice (3.7 GB, then 3.0 GB after the number domains were cut to 0..6). A node out-of-memory is a crash, not a verdict, so no result was ever mistaken for clean. The loop is now three machines by concern, which coordinate by messages: `Turn` (a model call and its tool), `Context` (the window and its compactions) and `Trial` (the plan, the stage checks, the caps, the end). Each rule reads the fields of one concern, so each is checked on its own machine. The 3 s run that followed is the evidence. This is the plan's risk 8, "state space", realised; the split was not in the plan. The cross-machine messages (`Turn` to `Trial`, `Trial` to `Context`, `Context` to `Trial`) are checked as intents and not yet as a joint configuration; a configuration of the three is E3.4's check once the host drives it, and if it is too large the messages are checked in pairs.
2. **A `never` over a rejecting `require` is vacuous.** The checker counts a `never emit k while P` as tested only if some accepted step takes an action that can emit `k` from a state where `P` holds. A guard written as a `require` that rejects those states leaves no such step, and the rule is reported vacuous. So every gate is an `if` that is always taken and decides whether to emit: the typed gate of HT2 ("a typed decision over measured numbers"), journaled in both outcomes. This is the design HAC5 wants (every compaction decision replayed) and it came from the checker's discipline, not from the proposal.
3. **A `never` cannot name a decision** (`PL1001`: the machine declares no effect `summarise`). The compaction rule is on a new effect `startCompaction`, emitted by the gate in the same step as the summary decision; the summary's own application, `compact`, follows the summary.
4. **S561 as built.** `Overflowed` starts one compaction (`attempts` 0 to 1). If the window is still over the limit after it, whether the compaction failed or did not shrink enough, the next `Overflowed` ends the trial with `stopOverflow` and tells `Trial`. A compaction that succeeds sets the window to the summary's size (two buckets), so a compaction always shrinks. There is no `forced` flag and no `Failed` state: the first draft had both and they were redundant.
5. **A completion cannot repeat an effect.** `PL4002` refused `Summarised`, `Open` and `Receipted`, which emitted and changed nothing, so a duplicate completion would repeat the effect. Each now changes a field (`summarised`, a `Reading` and a `Checking` state of `Receipt`).
6. **`PL7001`, the credential-egress region.** A model call carries private code to a provider, so the checker finds the region reached with no gate crossed. The policy's `model-calls` obligation names `decision.agent`, `decision.summarise` and `decision.read`, and so crosses it. The budget check runs before any rule (PS18.4); the obligation allows.
7. **A policy checks the names it uses.** `effect.kind == "tool.none"` is `PL1001` ("not one of the program's values here"). The HF3.10 variant therefore points the deny rule at another real kind (`tool.stage-check`), the realistic fault of a wrong target.

**Changes to the replacement lines of E3.1 (as the owner's ruling asks them recorded).** The test header holds the new table. In short: the modules are `Turn`, `Context`, `Trial` and `Receipt`, not `Session`; every variant replaces an `if` or a `prices` line, not a `require` line, for the reason in finding 2; HF3.1 keeps the range guard (`if compactions < 2 && saving > rewrite {`), or it also breaks the counter's range (`PL3102`); HF3.4's variant is `if plan is Fusable || plan is Separate {`; HF3.5's `if scanned {`; HF3.7's `if stop is Tool && reprompts < 1 {`; HF3.8's `if attempts == 1 {`; HF3.9's `emit stopCap()`; HF3.10's `when proposal.kind == "effect" && effect.kind == "tool.stage-check"`. Two expectations changed: HF3.6 is `REFUSED` with `PL6845` (a static refusal, not `FINDINGS`), and HF3.10 gives `PL6503` and `PL7001`, since removing the deny rule also removes the gate that crossed the region. HF3.11's thresholds file is `editable/thresholds.json`.

**What the module proves and what it trusts (for the certificate and the README, E3.10).**

- The rules hold for the host's facts as given: the stop reason (`Metered`), the token measurements (buckets), the classifier's, the scan's and the verifier's verdicts, the stage check's result, and the order in which the host dispatches `Go`, `StoreLog`, `Measured`, `Overflowed`, `CapReached`, `Close`, `Show`. A `require` rejects an action out of turn; the host's failure to dispatch one is a stuck run, not a broken rule.
- HF3.11 and the unbudgeted decision (S562) are lints and unit tests, not proofs.
- The observation slot is checked as one slot (PS13.8a); `Ledger` sends each slot the same `Sent` and reads nothing back.
- Not yet checked: a joint configuration of `Turn`, `Context` and `Trial`; liveness of the loop (E3.4).

Next: E3.3, the effects (the certified handlers and their mutants).
