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
