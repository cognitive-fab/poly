# poly v1 · Decisions for the release

Rulings made after M9 to M11 that belong to the v1 release, not to one milestone. Each is built after the M10 and M11 merge, PS and PT text first (rule 7a), with a test that fails before the change.

## S400: strict by default (owner's reviewer, 2026-10-07)

Ruled in docs/proposals/experiment-strict-rerun.md, section SR1. PT3.4a is amended: the default mode is `strict` for every action parameter and field that has a check domain, and `disclosed` applies only where written.

## S401: an approved effect reads the state at approval (owner's reviewer, 2026-10-08)

**The gap.** PT9.3 evaluates a proposal against one snapshot: the post-state of the step that emitted the intent. An escalated intent waits for a person, and the instance can step meanwhile. A refund escalated while its order was open, approved after the order was cancelled, is re-proposed against the old snapshot, so a rule such as "no irreversible effect on a cancelled order" does not stop it. Found by the review of the research article (docs/reviews/review-2026-10-08-article-lamport.md, comment 6).

**Ruling.**
- The re-proposal that an approval triggers carries two snapshots: the emitting one, as now, and the emitting instance's latest post-state at the time of the approval, identified by its `seq` and `stateDigest`. The gate evaluates the policy against each. The decision is `allow` only if both evaluations allow. Otherwise it is `deny`, with reason `stale-approval` when only the later snapshot denies. An approved re-proposal is still never escalated again (PT9.3 rule 2).
- `machine("<module>.<Machine>")` reads the snapshot under evaluation. PS8.5 and PT9.3 are amended to say so.
- Replay reproduces the decision from the recorded `seq` of the later snapshot, as it does for the emitting one. A later snapshot that cannot be loaded makes the re-proposal `unavailable`, never evaluated against another state.
- **The checker.** The policy stage evaluates an approved re-proposal against every state of `Reach(I)` reachable from the emitting state, an over-approximation of what the instance can do while the intent waits. A policy that allows only on the emitting snapshot and denies on a later state is not a finding: that is the intended effect of the rule.
- **Not covered.** An allowed intent that is retried after a timeout is not re-proposed (PT9.3 rule 1), apart from the service-machine `Recheck` of S147. Its retries are bounded by the effect's retry policy. The release notes state this.

**Tests.** A refund escalated on an open order and approved after `Cancel` is denied `stale-approval`, and replay reproduces the denial; the same approval before `Cancel` is allowed. A control without the cancellation rule allows both.

## S402: routed decisions read Content and Items (owner, 2026-10-08)

S402: routed decisions may read Content and Items in v1 (tiers get M10's materials, each tier call carries the decision's taint, the answer stays finite); a Content result and cites stay refused (PL6839).

Raised by F1 of the review of the M10 and M11 merge (`decisions-m11.md`), where M11 refuses all four at check.

## The v1 gate list

- Move test/m3-isolation.test.mjs to the serial after-suite group so suite load cannot hit its CLI time limit. The v1 gate must have no failure. (Owner, 2026-10-08, after its timing failure in the suite that preceded the M11 merge, `decisions-m11.md`.)
- Replaying a credential's grant, which needs `std.credentials` in the build's records (AC27; `plan-m11.md`, ruled at M11's close).
- The gate times are compared with `docs/m11/gate2-file-times.json`, measured with nothing else running (ruled at M11's close).

## The release session's record

The release session works in the worktree `poly-v1`, on branch `v1` from m4 at fec4337f (the owner's plan, handoffs and inbox rulings, committed first). Each step below is recorded as it closes.

### V1: S400, strict by default (closed)

- **Spec first.** d9997692 amends PT3.4a, PS4.1b, PS9.1a, PF1.2 and AD-9; 7dd4f6b4 keeps a completion's `childKey` and `childState` outside the default, since the runtime supplies them from the child (S44, S51); 12cf1b37 says which layer refuses a value of the wrong JSON type.
- **Decided under the plan's rules: what has a check domain.** PS4.2 gives every parameter a check domain, so S400 covers every parameter of a handled action whose type the runtime can test: a `bool`, a range, an enum, a union, a record, a map, a `Conf`, and an `int` or `string` with a `check` clause. A `Principal`, `Ref`, `Content` or `Items`, or a type holding one, is explored by representatives and has no dispatch row. `disclosed` is written on a `check` clause, so a range or an enum parameter is always strict; to accept more, widen the type. A state field's mode decides no dispatch row (its writes come from strict inputs, and PT3.5 covers the rest); it still matters to PL1301.
- **Tests from the spec.** A test writer that read only PS and PT wrote `test/strict-default.test.mjs` (365f6c68). Three tests failed on the code before the change (an `int check` that reaches no effect, a range and an enum all took values outside their domains). Its bool test asserted `outside-check-domain`, but the vendored SAM strict profile refuses a string for a `bool` first, and polyrun journals that as a rejected step with the schema's message, the state unchanged. That is already a refusal at dispatch before the handler, so no engine change is needed: PT3.4a says so (12cf1b37) and the test asserts the schema's refusal, labelled a confirmation. Six of nine are confirmations.
- **The code (e5ffeee6).** The compiler's strict set and poly-ref's, each from its own reading of PT3.4a; a long run of consecutive integers is tested by its bounds. README gains SR1's manual paragraph.
- **What the old default hid (e1118211).** The first suite failed in the channel and routing tests. std's channel `Inbound` addresses and the Budget machine's amounts are the check's representatives; at run time a recipient is a keyed digest and an amount is in micro-units, as std.routing's PROVENANCE already said ("accepted and disclosed"). They now write `disclosed`. A channel's `Rejected` reasons are the runtime's whole set and stay strict. R2 and R5 (type escapes) and M3-10's out-of-range control relied on the old default to reach a handler with an outside value; their fixtures write `disclosed`, which keeps what each tests. The tests' copy of std.routing is kept byte for byte (this commit).
- **Suite.** At e1118211: 2,107 tests, 2,100 passed, 1 failed, 2 skipped, 4 waiting; check-memory passed (`.poly/logs/e1118211-2026-10-08T19-19-40-196Z-s400b.log`). The failure was the tests' std copy of routing.poly, not yet updated; with it updated, that file and the routing, budget and routed-materials files pass (29 of 29). The after-suite group did not run behind the failure; run alone it passes, 1 of 1 (`.poly/logs/e1118211-after-s400.log`). The next step's full suite covers both.
- **Measured verdicts.** 160 before (fec4337f, `docs/v1/verdicts-before-v1.json`) and 160 after (`docs/v1/verdicts-after-v1.json`): none differ. S400 changes what the runtime refuses, never what **check** explores, since check offers only inputs inside the domains; no measured program had a parameter whose domain was narrower than what its own peers send. This file is the baseline for the V10 gate.
- **Environment, not product.** The first suite also failed S170 and review D-F6 because `npm ci` ran before the first build, so the `poly` bin was not linked; `npm install` linked it, with no change to the lockfile.

### V2: S401, an approved effect reads the state at approval (closed)

- **Spec first (b1d5854b).** PT9.3 gains the bullet; PT9.1 lists `later`; PT8.3's `machine(...)` paragraph and PS8.5 say what is read and that the policy stage covers the later states.
- **Tests from the spec (930b0d55).** A test writer that read only PS, PT and this file wrote `test/stale-approval.test.mjs` over a refunds program and two policies. The approval after `Cancel` failed before the change (allowed against the emitting snapshot, no `later` recorded); the approval before `Cancel`, the control policy in both orders and the checker's stage passed, the last labelled a confirmation. The program records the request in a field, since an emit with no state change is `PL4002`.
- **The code (37d12d06).** The worker loads the emitter's latest post-state for an approved re-proposal and names it `later`; one that cannot be loaded throws inside the gate's try, so the intent is held as for an unavailable gate. The policy gate judges both actions with Polyaxion's own interpreter under the approval, which moves nothing, and gives the engine the later action when only it denies, so Σ moves once, the reason is `stale-approval` and session replay re-applies the recorded action.
- **Decided under the plan's rules: how the checker covers the later states.** poly-ref's decision table already gives every machine field every value of its type or check domain, a superset of `Reach(I)` from the emitting state, and the combination only removes allows, so no `never` verdict can change. What was not compared is the engine's decision under an approval on a row that is not an escalation, which the later snapshot can be; poly-ref's translation validation of a lowered policy now compares it on every row.
- **Not tested: a later snapshot that cannot be loaded.** The kernel loads any instance's latest state from its own row, so the case needs a store fault the harness does not inject; the path is a throw inside the same try that holds an unavailable gate's intent.

### V3: S402, routed decisions read Content and Items (closed)

- **Spec first (65d28a85).** PS18.2 and PT10r; the code table's `PL6839` entry.
- **Tests from the spec (4ec23f8c).** routed-materials' first test now asserts the new rule; `test/routed-content.test.mjs` runs the desk over a `Content` body carrying a canary: the small tier gets the body as materials, each call is proposed with the decision's taint (`customer`), a policy of the route's scope denying by `effect.taint.class` stops every tier and the decision fails `route-exhausted` while a control policy lets it answer, and after the run no table but `poly_content` and no build file holds the canary in any of four encodings. All six failed before the change, refused `PL6839`.
- **The code (06672522).** The checker keeps `PL6839` for a `Content` result and `cites` only. A tier's call is judged by the memory check over its decision's payload (taint, items, freshness), before the budget and the policy, and its provider gets the decision's materials. poly-ref's decision table gives a route's call the decision's content and items flags. `test/merge-order.test.mjs` runs again as it did at the merge (8069ddd4), since S402 admits its program.
- **The concierge's classification over the message body** is the desk's routed classification over a `Content` body under an audience: the concierge itself is the examples session's (E1), which rebases on this commit.

### V4: replaying a credential's grant (closed)

- **Spec first (e1f99233, e565a33e).** PT10e: a build with a credential records `std.credentials`, one with a channel its `std.channels.<kind>`; replay reads them from the std the runtime was loaded against; the runtime's own records are not runs for replay. The second commit came from building: the concierge has channels, whose conversations no build recorded either, and replay listed `runtime:ingress` as an archived run.
- **Tests (ff4cff89).** `test/grant-replay.test.mjs`: the concierge's delegated refund (a grant, a refund through it, a token refresh, a second refund) replays every run, the grant included, with every row folded, no diagnostic and nothing not run; and the certificate records `std.credentials`. Both failed before (replay threw rebuilding the Grant; no such record).
- **The code (505049b5).** The check records the std modules beside `std.routing`; the verified build keeps the std root it was verified against, and replay reads from it; replay leaves `runtime:` records out.

### V5: workflows under poly's gate (measured; owner's call Q-V3)

- **Measured.** The acceptance is already met, since M8a (S173 to S175): each work order is proposed to the gate and issued only on an allow, the certificate lists each workflow `{ runtime: "poly-runtime", gated: true }` (`packages/poly-check/src/admit.ts`), load refuses one run by polyflow, and `test/workflow-lower.test.mjs` asserts no `ungated` limit. V5's premise was the M6 state.
- **What polyflow's server does that poly's path does not:** nothing on gating, policies, approvals, settle or the ledger, where poly does more. polycrew's several participants (`workflow_next`, `workflow_claim`, actor attribution) are not served; budgets cover a route's calls only; an order's deadline is its effect's timeout, with no heartbeat; and the gate decides whether an order is issued, never what the agent then calls.
- **Built (fca9699e).** The Claude Code skill and the architecture's table still said workflows were ungated or run by polyflow's gateway; both now say what is built. `test/workflow-orders.test.mjs` gains a confirmation that a workflow run replays with no diagnostic, which no test did before (written by the builder, since no code changes with it).
- **For the owner (Q-V3), not built: a stable key per work order.** Each attempt's order id is new and opaque (S173 as amended), so an agent cannot make an irreversible tool call once across a lapsed attempt. Proposal: the MCP work order also carries `idempotency_key`, the intent id, stable across attempts, with one PT10 sentence; about three files and 60 lines, no engine change. It amends S173, so it waits for the owner. The other gaps are stated limits in `docs/release-notes.md`.

### V6: m3-isolation in the serial after-suite group (built; 1 of 3 suites)

- fb3cfed5 and 55fa2fc6: the file is in `test/after/`, the after group runs one file at a time, and account-independence finds runner tests there too. Alone it passed 5 of 5. The acceptance asks three consecutive full suites: the first is the suite below.

### V7: SR2, the counterfactual with no model call (closed)

- **How (b437c49b).** A worktree `poly-sr` at the M3 freeze b8a8cfb, with the S400 patch (`docs/v1/sr/s400-on-b8a8cfb.patch`: the compiler's and poly-ref's strict default, with the type kinds b8a8cfb lacks left out) and nothing else changed. `experiments/sr/sr2.mjs` copies each recorded delivery of T3 and T7, arms 3 and 4, out of the M3 records and scores it with the frozen scorer; `sr2-report.mjs` compares with the recorded M3 scores. 20 runs, 80 delivered versions, none not scored.
- **Result (`docs/v1/sr/sr2-report.txt`).** In the five defective deliveries (T3-arm3-run2, T3-arm3-run4, T3-arm4-run2, T3-arm4-run5, T7-arm4-run1), every failing O1 and O1-R test passes: 26 O1 failures and 16 O1-R failures in each T3 run's four versions, and 2 O1 and 4 O1-R in T7-arm4-run1, all now refused at dispatch (capture or refund of 0 or a negative amount, a refund above the domain, `taskTimeout` outside 0 or 1). No test of any of the 80 versions went from pass to fail, and every admission verdict is unchanged. The output's hashes: `sr2.json` a8afe44a…, `sr2-report.txt` ff673e54….

### The suite and the measured verdicts after V2 to V7

At b437c49b (V2 to V7 and the release notes): 2,120 tests and 6 in the after group, 2,114 and 6 passed, **no failure**, 2 skipped and 4 waiting (the waiting tests of M9's close); check-memory passed (`.poly/logs/b437c49b-2026-10-08T20-50-46-790Z-v2to6.log`). The 160 measured files are identical to the record after V1 (`docs/v1/verdicts-after-v1.json`): none differ. The examples session's one suite (`poly-ex`, its log a73d1b3a, 19:49 to 20:09 UTC) had ended before this one started at 20:50 UTC, and none ran during it. That suite did overlap V1's at e1118211 (started 19:19 UTC): V1's numbers stand, since this suite covers the whole set again with no failure.

### The probe review of V1 to V5

Two reviewers read the changes of V1 to V5 and ran probes, each in its own folder (`.poly/probe-a`, `.poly/probe-b`), without touching the source. Every finding below was reproduced by its probe; each real one fixed here has the probe as a test that failed first.

| Finding | Verdict | What was done |
|---|---|---|
| **B1** An approved allow read the emitter at `later.seq`, but its `reads` did not name the emitter, so a `Cancel` between the allow and the start was never rechecked (S147) and the refund ran on a cancelled order. | Real, a defect of S401. | dede1aa7: the allow reads the emitter at `later.seq`; it is rechecked, and the rechecked intent is proposed afresh and waits for a person again (an approval is not reused across a recheck). |
| **A F1** A parameter bound from a reply (S79) was strict whatever its type, so one holding a `Principal` was refused at run time over the check's representatives, and the instance stuck. | Real, older than S400, now against PT3.4a. | d3114e8f: compiler and poly-ref apply PT3.4a's test to it. |
| **A F2** The `childKey`/`childState` exclusion went by names, so an ordinary action with those names escaped strict and a checked invariant broke at run time. | Real, a defect of S400 (7dd4f6b4's code). | d3114e8f: only an action a spawn names as its completion is excluded. |
| **A F3** `PL1301` follows a value within one handler: a `disclosed` parameter stored in a field and emitted later in an irreversible payload is not reported. | Real gap, older than S400. | Not built: it widens a finding, a change of semantics not ruled. Stated in the release notes; proposal below. |
| **A F4** Since S400, a `send`, `spawn` or signal argument outside the receiver's strict domain checks `CLEAN`, and the receiver refuses the step at run time, silently to the sender. | Real risk, from S400. | Not built: a new check is a change of semantics not ruled. Stated in the release notes; proposal below. |
| **A N1** PT3.4a lists a map, but a map parameter is `PL0901`. | Real, text. | f88b0c18. |
| **B2** Text still said workflows run on polyflow outside the gate (the AST's and the embedded form's comments, PT14's adapter paragraph). | Real, text. | 78b492e3, dede1aa7. |
| **B3** Replay of a missing std module failed with a bare `ENOENT`. | Real, a nit. | dede1aa7: refused by name, as load refuses it. |
| **B4** A re-proposal held because the later snapshot cannot be loaded leaves no `verdict` event, only the outbox's last error. | Real, accepted as is. | The gate gave no answer, as for an unavailable gate; stated in the release notes. |

Probes that found nothing: the compiler and poly-ref agree on the strict set over records with nested unions, unions with payloads, a record holding a `Principal`, enums, decision outcomes and timers (no `PL2501`); lowered rows compare records by value; S402 leaks no body when a tier is denied or escalated, judges stale items per call, and the embedded form cannot slip a `Content` result or `cites` past `PL6839`; S401 over a rejected step, a stateful policy machine, a channel send and a workflow, with session replay and journal replay clean; V4's records with a channel, a route and a credential in one project, and a std module edited after certification refused by name at load and at replay.

**For the owner: two proposals from the probe review.**
- **F4, a check for values refused between machines.** A finding when the domain of a `send`, `spawn` or signal argument, as the sender's check explores it, is not inside the receiver parameter's strict domain, next to `PL1301` and with the same acceptance by a person. It is a static comparison of two domains, in the compiler and in poly-ref. Until ruled, the release notes state the limit.
- **F3, `PL1301` through state fields.** Carry the flow from a `disclosed` parameter through a field it is written to into any handler's irreversible emit that reads that field. Until ruled, the release notes state the limit.

### V8: SR3, the live rerun (closed)

- **How.** `experiments/sr/sr3.mjs` ran the 20 cells (T3 and T7, arms 3 and 4, runs 1 to 5) with the M3 frozen runner from the worktree `poly-sr` (b8a8cfb, the S400 patch, and the manual with SR1's paragraph and PT3.4a in its S400 form, `docs/v1/sr/sr3-manual.patch`): claude-opus-5-5 through the claude CLI 2.1.287 on the subscription, Node v24.12.0 (both as `freeze.json` records), 15,000,000 tokens, 3,600 s and $15 per run, in M3's block order. Ten blocks from 21:20 to 22:17 UTC; every runner exited 0, no run was stopped by a cap, none was refused or unscored (`experiments/sr/runs/blocks.jsonl`).
- **A void first attempt.** The first block, with both arms started at once, failed: the two CLIs share the arms' login folder, and the first three turns of each could not refresh the OAuth token ("another Claude Code process is refreshing it"), spending no token. The frozen runner does not mark that unscored, so the batch went on into block 2 before it was stopped. The four records are kept in `experiments/sr/void/block1-oauth`, none scored (8f169aa6). The batch then started arm 4 90 s after arm 3 and stops on any turn that exits with an error having spent no token, as M3 stops on a failed login.
- **The machine.** No suite ran during the batch (the examples session's one log ends at 20:09 UTC). In its first fifteen minutes the two probe reviewers ran small scripts, and the builder ran three test files.
- **Scored** with the frozen scorer (`experiments/sr/sr3-score.mjs`): every run delivered and admitted, and every O1 test of every version passes.
- **Result (SR-AC3).** `node experiments/sr/sr3-analysis.mjs experiments/sr/runs experiments/m3/runs --json docs/v1/sr/sr3-analysis.json`, printed to `docs/v1/sr/sr3-report.txt` (sha256 6f8a7eac…; the JSON 6a7fd9a2…):

  | | SR3 | M3, same cells |
  |---|---|---|
  | Runs with at least one escaped O1 defect | 0 of 20 | 5 of 20 |
  | One-sided Fisher exact test | p = 0.0236, significant at 0.05 | |
  | Escaped defects per delivered run, arm 3 (T3, T7) | 0.00, 0.00 | 10.40, 0.00 |
  | Escaped defects per delivered run, arm 4 (T3, T7) | 0.00, 0.00 | 10.40, 0.40 |
  | O1-R failures per delivered run, arm 3 and arm 4 on T3 | 0.00, 0.00 | 6.40, 6.40 |
  | Admitted runs | 20 of 20 | 20 of 20 |
  | Tokens per delivered run, arm 3 (T3, T7) | 1,450,896, 2,175,963 | 1,563,567, 2,363,077 |
  | Tokens per delivered run, arm 4 (T3, T7) | 1,309,116, 2,286,580 | 1,268,239, 2,041,726 |

  The pre-registered comparison (zero of 20 against five of 20 gives p = 0.024) is met. M3's verdict is not reopened.

### V6 closed: three consecutive full suites with no failure

After the probe fixes, the full suite ran twice more at 0b1ca108, back to back, with no other suite on the machine (the examples session's one log ends at 20:09 UTC): 2,310 tests and 6 in the after group, 2,304 and 6 passed, no failure, 2 skipped and 4 waiting, check-memory passed, each time (`.poly/logs/0b1ca108-2026-10-08T22-52-53-060Z-v6b.log`, `.poly/logs/0b1ca108-2026-10-08T23-29-25-573Z-v6c.log`). With the suite at b437c49b, m3-isolation passed in the serial after group in three consecutive full suites. The 160 measured files, measured between the two, are identical to the record after V1.

The suite grew by 190 tests between b437c49b and 0b1ca108: the standing rules (`test/standing.test.mjs`) walk every `.poly` source under `experiments/`, and only `experiments/m3/runs/` is excepted (S163), so the programs SR3's agents delivered are now checked by them, and pass. **For the owner:** whether `experiments/sr/runs/` and `experiments/sr/void/` join S163's exception, as frozen evidence like M3's runs, is a change of the standing rule's one exception, so it is not made here.

### V9 closed: the release notes

`docs/release-notes.md` (6134a346, 03f231c5) lists, for M8, M9, M10, M11 and v1, the formats a reader must expect, the commands, the new codes (each name checked against `diagnostics.ts`) and every stated limit, including those the probe review leaves. PT12.2's table gained `PL6841` to `PL6846` (df0c1849).

### Polywatch

Polywatch reviewed none of this branch's work: its reviews in this session were skipped as outside its project (the worktree `poly-v1` is not the project it watches). There are no findings to mark.

### What is next

V1 to V9 are done. The merge into m4 and the v1 gate (V10) wait for the reviewer's go. Waiting on the owner: Q-V1 (the release), Q-V3 with V5's proposal (a stable key per work order), the probe review's two proposals (F3, F4), and S163's exception for SR's records.

## V1 to V9 accepted, and what comes next (owner's reviewer, 2026-10-08)

- **Accepted.** V1 to V9 as recorded (fec4337f..3f539a47): three full suites with no failure, the 160 measured verdicts identical at every step, the baseline `docs/v1/verdicts-after-v1.json`. The voided SR3 block is a reported deviation, kept with its records. SR3's result stands: 0 of 20 runs with an escaped defect against 5 of 20 in M3, one-sided Fisher p = 0.0236.
- **V5 and Q-V3.** Workflows already cross the gate; Q-V3 is closed. The proposal to give each work order a key that stays the same across attempts (amending S173) is accepted; build it.
- **Probe findings.** B1, A F1 and A F2 as fixed. F3 and F4 are accepted for v1, not left as limits: F4 contradicts "no silent clean" (a send that the receiver's strict domain refuses must be a finding at check, in a configuration and outside one), and F3 is the S400 trap through a state field (PL1301 follows a value through fields to the effect). B4 is accepted as is, stated in the release notes.
- **S163.** SR3's run records join M3's as the paths the standing rule skips.
- **The examples session's poly-io commit (71a0e628)** is within S452: new files, a provenance entry, and one registry entry each in the checker and the runtime's kind list. No action.
- **The overlap** of the examples session's suite with V1's is noted; the later suites cover it. One suite at a time stays the rule for both sessions.

**Order from here, on v1:**
1. Fast-forward m4 to v1 now (`--ff-only`), record it, fast-forward again. This is not the V10 gate; it gives the examples branch a stable base.
2. Build, each with PS/PT text first and tests written from the text alone: S450, S451, S454, the core half of S455 (ruled in poly-ex's `docs/decisions-ex.md`, "plan-ex ruled"; copy them here), then F4, F3 and the work-order key.
3. Report each commit that changes PS or PT text, for the examples session to rebase.
4. V10 waits for E1 and E2.

## m4 fast-forwarded to v1

As ordered, m4 was fast-forwarded with `--ff-only` from fec4337f to 16b2cde7 (V1 to V9, the acceptance and the owner's rulings, which the m4 worktree held uncommitted and which were committed on v1 first, so the fast-forward kept them unchanged). This is not the V10 gate: it gives the examples branch a stable base. This record is the one commit after it, and m4 is fast-forwarded again to carry it. Nothing was pushed.

## S450 to S455, as ruled on plan-ex (owner's reviewer, 2026-10-08)

Copied from `docs/decisions-ex.md` on `ex` ("plan-ex ruled"), as the reviewer ordered: the release session builds S450, S451, S454 and the core half of S455 on `v1`, then F4, F3 and the work-order key.


**Where the core changes are built.** S450, S451, S454 and S455's core half change semantics or security, so they are built by the release session on `v1`, after S402 and in this order, with PS and PT text first and tests written from the text alone. `ex` rebases on each as it lands. Nothing on `ex` changes the core.

- **S450, accepted.** A channel may declare `principal from <claims field>`: the thread's principal comes from the verifier adapter's verified claims for the sender, never from message content. Without it the recipient keeps no principal, as now. PS15.0a and PS17.3 are amended. Test: the concierge's reply citing customer A's orders reaches A; the AC22 variant sending them to B is a finding at check and denied at run time.
- **S451, accepted.** Mail is a source owned by its account's principal. A retrieval may add one equality on a key the source declares (message id, thread, correspondent); key values are opaque, compared only for equality, so renaming invariance (PS4.1c, PS4.1f) holds. Test: IAC3, mail of one account never reaches a draft of another.
- **S452, ruled.** poly-io's adapters are certified host code, not semantics. `ex` may add new adapter kinds to poly-io, additive only: new files, a registry entry each, a provenance file, recorded-traffic tests. No change to an existing kind or to the loader. A registry conflict at rebase is resolved by keeping both entries.
- **S453, deferred to after v1.** No new credential kind in v1. SES ships after the release with an `aws_sigv4` kind and its own ruling. Q-EX5 is accepted: Gmail only for the v1 gate.
- **S454, accepted.** An unrouted decision may name a budget; its call reserves its worst-case cost like a tier call (PS18.4, S360, S361 apply unchanged). Test: drafts and titles stop at the monthly cap of IF3.5.
- **S455, accepted, both halves.** On `ex`: two credentials, `gmail.readonly` for polling and `gmail.compose` for drafts, so the polling token cannot send. In the core: an effect target may be written `exact "<url>"`, matched on the whole URL; the inbox's draft effect uses it, so `.../drafts/send` is outside the gate. The release notes say that Google's compose scope permits sending and that the exact target is what prevents it.
- **Q-EX1 to Q-EX4, accepted as recommended:** two routed enum decisions for triage, due dates as buckets; snooze of 1d, 3d and 1w; SES read-only when it comes; the digest a view computed by the page from checked state, local only (Q-I4).
- **Id range S450 to S499, accepted.** The three calls recorded in the plan (the Notice machine, opaque account labels, person-signed approvals only) are accepted.
- **Google OAuth.** Confirm from Google's documentation: refresh tokens of an app in Testing expire after seven days, and `gmail.readonly` and `gmail.compose` are restricted scopes, which may require verification for an app In production. Bring the facts to the owner; the owner sets the Google project and its keys.

**Start now:** recorded traffic, the MIME reader (kept for SES after v1), the synthetic corpus, the Gmail adapter kind (S452), and the concierge parts that do not need S450. Then E1 after S402 and S450 land, E2 after S451, S454 and S455.

## S450: how the application learns the thread's principal (owner, 2026-10-08)

Raised by the release session: S450 as ruled says where the thread's principal comes from and that it becomes the reply's recipient, not how the application learns it; an application's step bound to a channel message carries the Inbound's claims only by lineage, which a handler cannot read. **Ruled (owner): the claims on the bound action.** std's `Sender` claims gain `principal: Principal`, the principal the verifier maps the verified sender to, `none` when it maps none. `principal from principal` fixes the thread's principal at the first message that names one. An application action bound to the conversation's message may declare `by c: C` and receives the Inbound's verified claims, so it stores `c.principal` and retrieves by it; the principal always comes from the verifier, never from message content or a message parameter. The reply's recipient and the received body's owner are the thread's principal. Notes:

- (a) An unmapped sender gives no principal, so a reply carrying owned content is refused (fail closed); a test covers it.
- (b) A later message whose claims name another principal is refused under a new reserved reason, added to PS3.2's list.
- (c) The merchant (Q-EX6) is not a claims field: it comes from the Stripe Connect grant, as ruled.

## S450, S451, S454, S455, F4, F3 and the work-order key, built

Each was built with its PS and PT text first, then tests written by a subagent that read only the text and the tests (each failed on the code before it, but the confirmations named as such), then the code. S451, S454 and S455 were built by builder subagents from the text; the release session reviewed and committed each.

| Item | Text | Tests | Code |
|---|---|---|---|
| S450, the thread's principal | 283c5b2c, b6318b4c | ef12cf0b (8) | f2331af7 |
| S451, Key and retrieval by key | 35585af2 | 463e8d58 (4) | dd7060fa |
| S454, a budget on an unrouted decision | 70c2dfa2, 20d65adc | 681c546c (8) | 5e9cad52 |
| S455, an exact egress target | 7df04787, c87ccb61 | b9596441 (6) | bcd8ae46 |
| F4, PL5408 | 4b052c36 | 9173bc6f | a5569f5f |
| F3, PL1301 through fields | 02744afe | 9173bc6f | 754a2093 |
| The work-order key | e7e9c447 | 9173bc6f | fe5844fe |

Decided under the plan's rules, recorded:

- **S450.** The thread's principal is fixed only by a mapped principal; an unmapped or unverified sender's claims carry the keyed digest of its address, a principal no source owns, which never fixes a thread (SMS verifies no sender, so an SMS thread never has one). Adding `principal` to every std `Sender` doubled each conversation's inputs and ran the conformance concierge out of memory, so a claims `Principal` field that the handler never reads, in claims with no `Audience` field, is explored by one value (PS4.1c's renaming invariance), and a channel configuration does so for the Sender's principal unless the channel declares `principal from` or its bound actions take claims (b6318b4c, ruled in the text first). The first S450 test writer's fixtures took 190 s and ran out of memory; a second writer made them small, without weakening an assertion.
- **S451.** A key written twice in `keys` is refused; a retrieval by key from a `memory` source refuses every item, since the memory store keeps no keys; a key value of `none` or empty is refused before the adapter.
- **S454.** The clause before `provider` is `PL1201`; the embedded form has no surface for the clause yet, stated in the release notes.
- **F4.** On a machine alone, the receiver is known by the declared type of the send's address, so a send through a `Ref` field still `none` is judged.

**Found, not built: S322 and a channel's configuration.** `PL6838 FLOW_NOT_FOLLOWED` reads a configuration as holding the machines its instances declare, so a channel's generated configuration, whose conversation is spawned, does not count as holding it: a channel application that replies tainted content is `INCONCLUSIVE` on its own though its channel's configuration follows the reply. It is older than v1's work; it is brought to the reviewer as a fix to make (count a channel configuration's conversation), with a test.

**Suite.** At fe5844fe: 2,183 tests and 6 in the after group, all passed but 2 skipped and 4 waiting, no failure; check-memory passed (`.poly/logs/fe5844fe-2026-10-09T05-35-32-452Z-w1.log`). No other suite ran (the examples session's last log ends at 03:13 UTC). The suite is smaller than at 0b1ca108 because SR3's records are now outside the standing rule (S163).

**Measured verdicts.** Against `docs/v1/verdicts-after-v1.json`: 160 files, every verdict identical; three files differ in transition counts only, `conformance/m5/lineage-pay.poly`, `lineage-timer.poly` and `lineage.poly`, each with fewer transitions (219 to 111, 219 to 111, 3,052 to 1,540) and the same states, since a claims principal their handlers never read is now explored by one value (b6318b4c). The new record is `docs/v1/verdicts-after-rulings.json`.

## S456, S457, the S454 embedded form and the one-value rule (owner's reviewer, 2026-10-09)

The round above is accepted, with three additions.

- **S456 and S457, built next, as ruled.** S456 as ruled on plan-ex: a channel's generated configuration also offers the completions of the application's pending decisions and effects, each only while its intent is pending. S457: a credential granted by a person may omit `holder`; it then has one `Grant` instance, whose holder is fixed at the first signed grant request (recorded by keyed digest, never readable by the program), and replacing that holder needs a revocation. **With S456, the PL6838 fix:** a channel's generated configuration counts as holding the conversation its application spawns, with a test.
- **The S454 clause gets its embedded TypeScript form now**, in place of the stated limit.
- **The one-value rule of b6318b4c applies only when nothing reads the principal:** no handler, no policy and no `principal from`. A test checks a thread that uses `principal from` and is explored with full representatives.

Same method: the PS and PT text first, then tests written from the text alone, then the code.

## S456, S457, the S454 embedded form and the one-value rule, built

Each item got its PS or PT text first. Subagents that read only `docs/`, `test/` and `std/` then wrote its tests, and each test file failed on the code before it. The code came last.

| Item | Text | Tests | Code |
|---|---|---|---|
| S456 and the PL6838 fix | f0fa3d3f | 71970792 (9; 5 failed before) | 0554c5f7 |
| S457, a person's credential with no holder | 51d0f5b3 | 575f3522 (7; 5 failed before) | 38910d5e |
| S454's embedded form | a3e6084b, 5b6af3a9 | 575f3522 (8; 6 failed before) | ca1c15b0 |
| The one-value rule | 828eadb5 | 575f3522 (6; 1 failed before) | ccf1f566 |

**Decided under the plan's rules, recorded:**

- **S456.** The joint configuration completes the application's intents in the same way, since PS15.5 makes it a model of the run as much as each channel's own configuration is. A completion's step takes one pending taint of its kind with it in the flow rule's exploration, so the PS17.3 branch no longer offers that application's completions on its own. PL6838 counts a conversation both by its address (`m.c.Conversation`, which a send names) and by its machine's last name (which a spawn names). The first build counted only the last name, and the test written from the text caught it.
- **S457.** Only a person's signed grant request creates the one grant, so `rt.requestGrant(c, null)` is refused until a request has fixed the holder. Holding the grant back fails closed: it is never granted to a holder no record names. A request that names the same holder asks again, as `rt.requestGrant` does. The holder's keyed digest is in `poly_grant_holder`, and a refusal's journal entry and reason file never name the holder.
- **S454.** The first text named `PL0001` for an option the embedded reader refuses. The embedded surface reports every form outside its subset as `PL0301` (PT2), so 5b6af3a9 corrected the text, and the test now follows it.
- **The one-value rule.** No policy reads a `Principal` field of claims: the policy checker's `step.claims` and `lineage.origin` fields leave it out. So "no policy" holds for every program. The machine-alone exploration of a conversation whose channel declares `principal from` is now done with every representative. Its configurations already were.

**Suite.** At 0554c5f7: 2,220 tests and 6 in the after group. All passed except 2 skipped and 4 waiting, with no failure; check-memory passed (`.poly/logs/0554c5f7-2026-10-09T10-21-36-744Z-w2.log`). No other suite ran.

**Measured verdicts.** Against `docs/v1/verdicts-after-rulings.json`, all 160 files have identical verdicts and counts. None of them has a channel application that answers through a decision or an effect, and none has a conversation whose channel declares `principal from`. So no new record is kept.

## S458: a range read only against constants (owner's reviewer, 2026-10-09)

The round above is accepted: S456, S457, the S454 embedded form and the one-value rule. S458 comes next, as proposed by the examples session (decisions-ex.md, Finding 2): a range used only in comparisons with constants, or passed unchanged into a payload, is explored at the values its constants cut.

- **(1)** Any arithmetic, any comparison with another variable, or any comparison after storage turns the reduction off for that value.
- **(2)** The cut points come from the handlers, the guards, the properties (the constants of `emits` included) and the policies that read the payload.
- **(3)** The verdict prints the reduced domain and its representatives.
- **(4)** poly-ref applies it on its own, with a PS lemma, as it does for confidence intervals.

Same method: the PS and PT text first, then tests written from the text alone, then the code.

## S458, built

| Text | Tests | Code |
|---|---|---|
| f2d1de93 | f9f11a80 (12; 10 failed before) | bd52f07c |

**Decided under the plan's rules, recorded:**

- **Storage turns the reduction off.** The ruling turns it off for a comparison after storage. A stored value can be compared by another handler, a property or a policy (`machine("m.M").f`), so a write to a field turns it off at once, as the examples session's proposal also said ("never storing it"). The lemma then needs no reading of the state.
- **A class is an equivalence class, not an interval.** Two values are equivalent when every comparison with a cut point has one outcome on both, as for a `Conf` (PD1.4b). `amount != 7` gives the representatives {0, 7}, since 8 is equivalent to 0. The test writer read a class as an interval between cut points in three expectations, and those were corrected to the text in f9f11a80.
- **A name shared with a field or a binding turns it off.** Both implementations read the parameter by its name, so a field, a `let`, a loop variable or a pattern binding of the same name turns the reduction off rather than being told apart. Both sides then agree by construction, and the read-back of `dataDomain` checks that they do.
- **A broken variant.** PT3.3a makes a disagreement on `dataDomain` a translation-validation finding, so the broken lowering `range-cut-dropped` (one class fewer) is in the list of toolchain faults, over `test/fixtures/cut-ranges/refunds.poly`.

**Suite.** At bd52f07c: 2,234 tests and 6 in the after group. All passed except 2 skipped and 4 waiting, with no failure; check-memory passed (`.poly/logs/bd52f07c-2026-10-09T15-49-17-807Z-w3.log`). No other suite ran.

**Measured verdicts.** Against `docs/v1/verdicts-after-rulings.json`, all 160 files have identical verdicts, states and transitions. No conformance case or example has a range parameter that S458 cuts, so no new record is kept. The concierge draft in `poly-ex`, whose amount is compared with 100 and passed into the refund's payload, is the first program it reduces.

## S459 and the examples' harness (owner's reviewer, 2026-10-09)

S458 is accepted as built, with both of the release session's choices: storage turns the reduction off, and a class is an equivalence class. S459 is ruled as the examples session proposed it (decisions-ex.md, E2), in three parts:

- **(a) A handler reads its own payload's bodies.** A handler may read the bodies of the `Content` values of its own payload, and of nothing else, only once the flow check has allowed the intent (PS17.3). Each read is recorded by digest.
- **(b) A thread's envelope from the source.** A source may give, by key, an envelope item for a thread: the recipient, the subject, `In-Reply-To` and `References` of a reply to its newest message. The program passes it to the draft effect as a `Content` tainted by the account. **The condition:** the draft effect's recipient and threading headers come from the source's envelope item for that thread, never from a decision's answer or a message body. The checker refuses a draft whose envelope value has any other origin, and a test shows a model's answer that tries to set the recipient being refused.
- **(c) The harness fix.** The examples' checks resolve `use`, provider profiles and route files as `poly check` does, from `std/` and beside the source, so an example that uses a v1 surface can live in `examples/`.

Then: measure what drives the growth S456 caused in the concierge (the stored reply's `Content` representatives times the pending completions, or something else), and bring the numbers before changing anything.

## S459, built and accepted (owner's reviewer, 2026-10-09)

| Part | Text | Tests | Code |
|---|---|---|---|
| (a) and (b), a handler's reads and the envelope | 792d770c, b10bb558 | 248c2adf (12, all failing before), 5196ba7c (1) | 57266860, b7fe922c, d406d75e, 99ef395c |
| (c), the examples' harness | (none; the harness is the tests') | c6c6b9fe | c6c6b9fe |

**Accepted with the five choices made while building it:**

1. **No item fails the retrieval.** An adapter's null is the retrieval's failed completion, as the text's "null fails the retrieval" says, not a retry.
2. **A shared parameter is refused.** A parameter is an envelope's origin only when nothing but an envelope retrieval's ok outcome fills it; a decision bound to the same parameter could otherwise choose the recipient.
3. **`none` is denied at run time.** A field that holds the envelope may be written `none`, and an intent whose envelope is `none` is denied `envelope-origin`.
4. **The `Re: ` prefix is case-insensitive.** `postgresSource` leaves a subject that already starts with it, in any case, as it is.
5. **A forgotten envelope fails at `content.read`, and its draft is refused.** As ruled with the acceptance, the origin check also refuses an envelope erased since (PS17.3a as amended, b10bb558), so no recipient survives an erasure: test 13 of `test/envelope.test.mjs` erases a held envelope and finds the draft denied `envelope-origin`, its handler never run (5196ba7c, 99ef395c).

**PL6830's error source.** The first full suite after the code failed one test: the compiler's check that every error code has an error source. `conformance/m0/errors/PL6830-envelope-not-from-source.poly` is it (d406d75e).

**Suite.** At 99ef395c: 2,254 tests and 6 in the after group, all passed but 2 skipped and 4 waiting, no failure; check-memory passed (`.poly/logs/99ef395c-2026-10-10T04-05-10-988Z-w6.log`), on a machine with nothing else running.

## Three items from the examples session (owner's reviewer, 2026-10-09)

- **(a) The retrieval signature (a defect, S41 with S451).** The runtime ran every retrieval of one source with one manifest entry for the whole program, the last machine's, so two different retrievals silently ran as one. **Ruled, as the release session proposed:** each intent reads its retrieval from its own machine's manifest entry, and two differing retrievals of one source within one machine are `PL1002`. Tested first with the inbox's case: by message with limit 1, and by thread with limit 5.
- **(b) S460, a source names its credential.** The certificate gets a vault for it, and its `Grant` machine tracks it. The adapter receives a handle, never the token: `rt.credentialHandle(c)`, limited to the provider's base addresses, refusing once the grant is not `Granted`. `rt.connectSource` accepts only an adapter built with that credential's handle. Revoking the grant stops the sync. This is additive.
- **(c) A parameter named after a state field.** The release session's scan found 35 in 275 sources, among them `Conversation.Open(app)` in every std channel kind, which the channel expansion writes, and `conformance/m0/shadowing.poly` tests S19, under which such a parameter shadows the field. **Ruled (option 3):** in v1, `poly check` warns, naming both, and S19 stays the meaning; `PL1002` comes after v1, with std and the corpora renamed together.

## After v1

What is ruled for after the release, in one place:

- **S453:** SES, with an `aws_sigv4` credential kind and its own ruling (Q-EX5: Gmail only for the v1 gate).
- **`PL1002` for a parameter named after a state field** (item (c) above), with std's channel kinds, the conformance cases, the examples and the tests' fixtures renamed together, and `conformance/m0/shadowing.poly` turned into its error source.

## (a), S460 and (c), built

| Item | Text | Tests | Code |
|---|---|---|---|
| (a) one retrieval per machine and kind | de6e4538 | 12a73b53 (4; 3 failed before) | 5ea0b6a0 |
| (b) S460, a source's credential | 69de3796 | f1fc221b (19; 17 failed before), 56491250 | 96929562 |
| (c) the v1 warning | fc2b2ddd | 1b75822f (4; 3 failed before) | cb304e6e |

**Decided under the plan's rules, recorded:**

- **(a)** Remembers share the defect and the fix: every remember of a source has one kind, so each intent runs its own machine's entry too, and two differing remembers of one source in one machine are `PL1002`.
- **S460, the handle.** `rt.credentialHandle(c)` refuses a credential that no source of the build names, or one with a holder: otherwise a host could reach anything under the provider's bases outside an effect's declared targets. A request outside the bases is checked before the grant, audited `PL6406` under the grant's id, and a refusal for the grant (`credential-unavailable`) is permanent, so a retrieval fails at once and is not retried. The runtime knows its handles by its own table; a handle another runtime made is refused for a source that names a credential.
- **S460, the adapters.** Only `openSearchSource` takes a handle in v1, as PT10j says; a `postgres` source that names a credential checks clean and cannot be connected, which fails closed.
- **S460, the quote.** The test asked for the printed option with single quotes after PT10j's notation; the embedded printer writes every string option in double quotes, and the test takes either (56491250).
- **(c)** The report's `warnings` is absent when there is none.

**Suite.** At 96929562: 2,284 tests and 6 in the after group, all passed but 2 skipped and 4 waiting, no failure; check-memory passed (`.poly/logs/96929562-2026-10-10T04-46-42-521Z-w7.log`). One heavy job on the machine.

## An Items at the type check, and the serial after-suite group (owner's reviewer, 2026-10-10)

**The defect.** The examples suite (`ex`, rebased on 459) failed `test/runtime-type.test.mjs` on `examples/concierge`: `Found.items = {"count":0}` is in the contract's data domain, and the runtime's type check refused it, since it asked for `{ ref, count }` with a `ref` beginning `items:`. **Ruled:** an `Items` is checked as a `Content` is. The checker's domain covers the count; the `ref` is an opaque handle, never a domain value, so the runtime checks only its form (`items:` and a key it stored) and the count against the domain; no synthetic reference enters a domain.

| Text | Tests | Code |
|---|---|---|
| b8bccdc5 (PT10j) | 52dd6e49 (8; 4 failed before) | c0e99891 |

**Decided under the plan's rules, recorded.** The type check reads the top of the domain's counts from the contract's `dataDomain`, and asks the store whether it keeps the item set (`poly_items`); an item set forgotten since is outside the type, which fails closed. The domain sweep of `test/runtime-type.test.mjs` carries each `Items` count by a reference its lookup holds. The older test of an outside `Found` with a forged reference now takes either refusal, the type check's or K10's, both before any step; the new tests show K10 alone with a stored reference.

**The serial after-suite group (ruled 2026-10-10).** `test/serial-sources.mjs` names `examples/concierge/`: its sources stay in the standing rule's coverage, the parallel sweeps of `test/standing.test.mjs` and `test/tv.test.mjs` skip them, and `test/after/serial-sources.test.mjs` runs the same two assertions after the parallel suite (c7af49be). The example arrives from `ex`; on `v1` the group holds no source yet.

**Suite.** At c0e99891: 2,292 tests and 7 in the after group, all passed but 2 skipped and 4 waiting, no failure; check-memory passed (`.poly/logs/c0e99891-2026-10-10T12-31-21-167Z-w8.log`).

## V10 item 4, and S461 (owner's reviewer, 2026-10-10)

- **Item 4, ruled: the release session's reading is accepted.** The concierge and the inbox are each `CLEAN` with their policy, and their journals replay; every other example's verdict equals its recorded one, under item 3. **Added:** every file in `examples/` carries a first line `// expected: CLEAN | FINDING <code> | INCONCLUSIVE <reason>`, and the gate compares each verdict with that line, so nobody has to know which files are teaching variants; `examples/README.md` states the line. Built: the 20 files on `v1` state their lines, taken from `docs/v1/verdicts-after-rulings.json` (a `FINDING` line lists every code the check reports, an `INCONCLUSIVE` reason begins with its code); `test/examples-expected.test.mjs` compares each (21 tests, all passing), and `test/after/serial-sources.test.mjs` does so for the serial group. One test read a diagnostic's line in `checkout-optimistic.poly`, now one lower.
- **S461, per-owner grants for an owned source.** The inbox needs three Gmail accounts in one assistant, and S460 gives a source's credential exactly one grant. **Ruled:** an owned source's credential may name `holder Principal`; each owner gets one `Grant` instance, keyed by the owner's verified principal (S450); `rt.credentialHandle(c, owner)` routes a request only to that owner's grant, and a request for one owner's items through another owner's handle is refused, with a test; revoking one owner's grant stops only that owner's sync, with a test showing the other accounts still syncing; the checker treats these grants per owner, as M9 does for a credential held by a principal, adding only one `Grant` per owner in the instance. Built now, before the concierge probes, text first and tests from the text; added to the release notes. No full suite until the examples session has run its own.

## S461, built (no full suite yet)

| Text | Tests | Code |
|---|---|---|
| 1824c65f | c102801d (8; 7 failed before), 410b4488 | b49fce1c |

**Decided under the plan's rules, recorded:**

- **The retrieval's context.** The runtime runs every source adapter call (a retrieval, an envelope retrieval, and a decision's read of an item's body) inside a context that names the source and the owner, so a handle knows the retrieval it serves. A decision's read of a body runs under the grant of the item's owner, as the read of the retrieval that kept the item.
- **An owner's handle fails closed.** Inside any retrieval whose owner is not its own (another owner's, one with no owner, or one from another source), it is refused `owner-mismatch` before the grant is read, and nothing is sent.
- **The instance line** is the pipeline's, since poly-ref's instance sees the machine and not the module's sources; it is text in the instance record, no new artefact.
- **The test fix (410b4488).** The required owner-mismatch test held on the first run; it failed at its last step only, on a recorded answer left queued for a body a retrieval never reads.

**For the reviewer: a forget through a per-owner source.** `rt.forget` calls the source adapter's `forget(subject)`, which is not a retrieval, so the routing handle refuses it (`credential-unavailable`) and a forget by subject cannot reach such a source today: it fails closed, with nothing erased there. Running it under the subject's own grant would serve a forget while that grant is `Granted`, but not after its revocation, when a person who withdrew may most want it. Not built; a ruling is needed.

**Tests run** (no full suite, as ordered): `test/source-credential-owners.test.mjs` and `test/source-credential.test.mjs`, 26 tests, no failure; the memory, envelope and `Items` tests before them, 51 tests, no failure but the one fixed in the test.

## A forget uses no grant (owner's reviewer, 2026-10-10), built

**Ruled.** Forget never uses a grant. `rt.forget(subject)` erases what the runtime holds for the subject (items, bodies, envelopes, taint records), the M10 erasure unchanged. The adapter's `forget(subject)` runs with no handle: any request it makes is refused, so it clears only its own state. When the subject is an owner of the source, the forget first revokes that owner's grant, so the next sync cannot bring the data back; the other owners keep syncing. The provider's copy is not poly's to erase, a limit in the release notes; provider-side erasure where the provider's copy is poly's own goes on the After v1 list.

| Text | Tests | Code |
|---|---|---|
| 8c2cde1d (PS17.7, PS16.4, PT) | 4917f8a2 (4, all failing before) | this record's commit |

**Decided under the plan's rules, recorded:**

- **The token revocation at the provider is not a request under a grant.** Revoking the owner's grant dispatches `Revoke()`, whose `credential.revoke` the vault sends (RFC 7009), as every revocation does. It withdraws the token and reads or writes no data, so the forget's tests allow it and no other request.
- **The refusal is the adapter's end.** A request through a credential handle inside the forget throws `forget-no-grant`. `rt.forget` takes it as that adapter's end and records it on the `forget` event, `noGrant: [{ source, refused: 'forget-no-grant' }]`. Any other failure of an adapter's forget still fails the forget, which the same record completes later (review C1).
- **An adapter over a store poly reaches with no credential** (a `postgres` table, an OpenSearch index over the host's transport) still removes the subject's items there, as in M10. The After v1 item covers the case where the provider's copy is poly's own and is reached through a credential.

**Tests run** (no full suite, as ordered): `test/forget-no-grant.test.mjs`, `test/source-credential-owners.test.mjs`, `test/source-credential.test.mjs`, `test/memory-forget.test.mjs` and `test/erasure.test.mjs`, 39 tests, no failure.
