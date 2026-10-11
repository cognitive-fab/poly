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
- **Erasure at the provider where the provider's copy is poly's own** and is reached through a credential (ruled 2026-10-10, with the forget that uses no grant).
- **The journal records of a provider revocation are named in the spec** (ruled 2026-10-10): which records journal each attempt of `credential.revoke`, which the tests read today from the runtime's own.
- **The full inbox checked with its cross-account variant (IAC3)** (ruled 2026-10-10). That check runs out of a 12 GB heap, so in v1 IAC3's witness comes from a cut-down copy of the inbox. The variant is measured in the release session's probes, after the concierge's.
- **The checker keeps every edge of a flow-rule exploration** (ruled 2026-10-10, from probe 2): keeping only state keys plus one predecessor for witnesses would let the full inbox (IAC3) and larger configurations reach a verdict.
- **A declared configuration offers the completions of its instances' pending intents** (ruled 2026-10-10, from S463): only a channel's generated configuration covers its application, so the liveness assumption of a `Grant` or `Route` machine is `open` in the certificate until a declared configuration covers it.
- **Nothing collects adjudications for a calibration refit** (ruled 2026-10-11): `poly journal fit` fits a map from `decision` events and their outcomes, and no part of the runtime or the commands gathers a person's adjudication of a decision's answer to feed it.

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

## The provider's revocation (owner's reviewer, 2026-10-10)

**Ruled.** The RFC 7009 revocation at the provider stays: a token left valid there would undo the point of revoking. Condition: the local grant goes to `Revoked` first and unconditionally; the provider's revocation is then sent, retried like an effect and journaled; its failure never undoes the local revocation or blocks the forget. Erasure in a store poly owns without a credential stays as M10 has it.

**Text** 72b08a3f (PS16.4, PT10g). **Tests** `test/revocation-provider.test.mjs`, written from the text: three, which pass with no code change, since the `Grant` machine's `Revoke` step makes the grant `Revoked` in the same step that emits `credential.revoke`, and that intent is retried within polyrun's default bound like any effect. Measured: when the provider answers 503 to every attempt, or times out, the forget completes and the grant is `Revoked` before any provider answer; the intent makes five attempts, each journaled (a `Start` and a `HandlerFailed` step on the intent's run, and an observation on the grant's run), ends dead, and changes no grant; `rt.revokeGrant` returns while the provider's answer is still held. The release notes state that a token stays valid at the provider until the revocation succeeds or the token expires.

## Replay of a count read, and a required citation (owner's reviewer, 2026-10-10), built

**Ruled.** Two defects found by the examples session. (1) A to-do handler read `cites.count > 0`: the check passed and the runtime ran it, but replay refused the step with `PL9001` (".count outside a step or reject property"). A handler is a step, so replay was wrong: a count read in a handler replays, and every conformance and example program the checker admits replays its recorded runs. (2) A decision whose answer must cite accepted an empty citation list: a required citation list that is empty is refused `uncited` at run time, by the same check that refuses a citation from another thread.

**Text** 58b59cd5 (PS11.4, PS17.6, PT10l). **Tests** 17c6b73a, written from the text by a writer that read docs, test and std only:
- `test/replay-items-count.test.mjs`: a desk whose handlers read `items.count` and `cites.count` (fixture `test/fixtures/replay-count/concierge-count.poly`) runs to its end, and `replayRuntime` folds every run with no diagnostic.
- `test/replay-admitted.test.mjs`, the standing test: a seeded walk of 30 steps of every machine of every program of `conformance/` and `examples/` that parses, declares a machine and is not `REFUSED` in `docs/v1/verdicts-after-rulings.json`, with `std/` resolved as `poly check` resolves it; each run is journaled in the runtime's form (an `Items` as `{ ref, count }`) and folded by `replayRun`. 101 files, 126 machines, 3,780 steps. No conformance or example program uses `Items`, so the count fixture joins the walk.
- `test/cites-required.test.mjs`: an empty list and an absent one are each refused `uncited`, the failed outcome runs and the observation is on the run; an item of another thread's retrieval (cust-b's `o-3`, cited by cust-a's desk) is refused the same way while cust-b's own answer citing it completes; a citing answer is the control.

Against the build before the fix, replay refused both count reads and the empty and absent lists completed; the control and the other thread's item passed.

**Built** 6a69aa7f. (1) `poly-ref`'s `alpha.ts`: replay read a journal's `Items` as the plain object the runtime wrote, while the checker's value of an `Items` is the record whose `count` a handler reads, so `.count` found no record. `alphaData` now reads it as that record, the `ref` carried and never read. The standing test found no other program the walk refuses. (2) `poly-runtime`'s `memory.ts`: `cite` refuses an empty or absent list as it refuses an id not given, with its own message.

**Tests changed by the ruling.** Seven M10 test files gave recorded answers that cited nothing (`cites: []`, or no `cites`), which the ruling now refuses: `memory-runtime`, `memory-forget`, `memory-enforce`, `memory-canary`, `review-m10`, `rulings-m10` and `source-keys`. Each provider now cites the items it read. In `memory-forget`, AC24's cited set now names the customer, so the forget removes it with the orders' set, where the empty set used to stay.

**For the examples session.** The concierge's decision has `cites`: a recorded or real answer that cites nothing now takes the `failed` outcome. Its host's recorded provider must cite the items it read.

**Accepted** (owner's reviewer, 2026-10-10), with the standing test's runs recorded as poly-ref's in `gate-v10.md`.

## The full suite after item 4, S461, the forget, the revocation and the two replay and citation fixes

Run w9 at 9112728c, alone on the machine after the examples session's heavy runs (`.poly/logs/9112728c-2026-10-10T17-45-24-454Z-w9.log`): 2,337 tests, 2,331 passed, 2 skipped and 4 waiting, with no failure; the after group's 7 passed; check-memory passed. The 4 waiting tests are those of w8, which wait on engine fixes (polyrun's tombstones at archive, S124, among them). Against w8 (2,292 tests at c0e99891) the 45 new tests are those of item 4, S461, the forget, the revocation and the two fixes. The slowest files are the channel tests, as before: `channels-whatsapp` 1,272 s, `channels-events` 1,270 s, `channels-adapter-pin` 1,229 s, `std-channels` 1,193 s, each run beside the others. S456's test of the M8 concierge's recorded counts took 537 s.

## S462: a handler reads its own payload's item sets, and one item (owner's reviewer, 2026-10-10), built

**Ruled.** AC27 waits on it: the concierge's refund must name the order it refunds, and a module cannot take a `Key` out of a retrieval (PS1.4c). As S459's `content.read`, a handler whose effect has an `Items` parameter may call `items.read(ref)`, which gives the ids, owners and keys of that payload's own item set only, each read recorded by digest. An effect parameter declared as exactly one item is refused before the handler runs when the set holds any other count. The `Items` type check still refuses a forged or unstored reference. **The form, as answered:** the effect item `one p` (option 1). The checker narrows `p`'s count domain to `{1}`, so an emit whose `Items` could hold any other count is refused at check time with a code and a witness; the runtime refuses any other count before the handler as the second layer; both layers are tested.

**Text** 2cba85ef (PS17.4b, PT10j, the grammar and `PL6847 ONE_ITEM_COUNT`). **Tests** 46570170, `test/items-read.test.mjs` with the fixtures in `test/fixtures/items-read/`, written from the text by a writer that read docs, test and std only; the runtime layer's test was added by the release session from the same text. The writer's runs came after the code was built, so the tests were not seen failing first; that is shown below ("S462, the tests without the code").
- Check layer: the refund guarded by `require cites.count == 1` checks `CLEAN`; without the guard it is `PL6847` with its witness. `one p` naming no parameter is `PL1001`, a parameter that is no `Items` `PL1201`, and `one` written twice `PL1002`.
- The control: the refund's handler reads its one cited order with `items.read`, `[{ id: 'o-2', owner: 'c-a', keys: { order: 'o-2' } }]`, and the read is recorded on `runtime:content` with the set's reference and the digest of what it gave, no id or owner in the record.
- `items.read` refuses a forged reference, an unstored one and an `Items` of another intent's payload, each `PL6406`, audited, before any read.
- The runtime layer: the pending refund's `order` replaced in the outbox by the retrieval's set of two, by a reference to that set claiming one, and by a forged one is each denied `items-count`, and the handler never runs (the S459 test's method for an envelope).
- The toolchain fault `one-dropped` is in `test/toolchain-faults.mjs`, with the guarded fixture.

**Built** 2fd29e66. The compiler reads `one p` on both surfaces and checks it; the lowering writes `one` in the manifest entry, and the effect signature carries it; poly-ref reads it back and finds `PL6847` at the first emitting step in BFS order, once per effect. A retrieval now keeps each item's values for the source's declared keys. The runtime gives a handler `items.read` beside `content.read`, and its count check runs with the envelope's origin check, before the memory check; its refusal is final whatever a policy says.

**For the examples session.** The concierge's refund carries `order: Items` with `one order`, guarded by a count read, and its handler reads the order with `items.read`. A set retrieved before this build has no keys; its items read with `keys: {}`.

## S462, the tests without the code (owner's reviewer, 2026-10-10)

**Asked.** The S462 tests were never seen failing. Run against a build of 46570170 (the tests, without the code), each fails for the reason it tests; then against that build with the compiler packages of 2fd29e66 and the old runtime, to separate the two layers.

**46570170 as it is.** `test/items-read.test.mjs`: 10 of 11 fail. Every check-layer and run-time test fails because `one` is not in the grammar: `PL0001 expected kind, labels, targets, uses, retrieve, remember, to, audience, envelope, class, retry, ok, failed or exhausted, found 'one'`, and each runtime test fails at admission with the verdict `REFUSED`. The one that passes is the check that `one-dropped` is listed in `test/toolchain-faults.mjs`: it reads the list the same commit adds, so it shows nothing about the code. The fault itself, `a broken lowering is caught with PL2501: one-dropped` in `test/tv.test.mjs`, fails on the same `PL0001`.

**46570170 with the compiler packages of 2fd29e66 and the runtime of 46570170 (no `items.read`, no count check).** 6 of 11 pass: the five check-layer tests (`CLEAN` when guarded, `PL6847` unguarded, `PL1001`, `PL1201`, `PL1002`) and the fault list, and `one-dropped` is caught with `PL2501`. The five runtime tests fail for the missing code: the control with `handler error: items capability missing`, and the two-items test with `two: the handler never ran` expected and the handler having run (the intent reached its handler with a set of two). The three refusal tests (forged, unstored, another intent's set) fail indirectly: with no `items` capability the handler's call throws before any refusal, so no refund is recorded, and the assertion on the recorded refund (line 243) fails. They show the capability is missing; they do not show the refusals' own reason, which only the control and the passing run at 2fd29e66 together do.

**Reading.** The check-layer tests, the control and the runtime count check each fail without their code for the reason they test. The three `items.read` refusals fail without their code, but not for the refusal's own reason. The build was restored to 8a1488fb afterwards and the file passes, 11 of 11.

## Probes 1 and 2 of the concierge and the inbox (2026-10-10)

Measured on `v1` at 8a1488fb, one at a time, with no suite or test run beside them, and changing nothing. Both are on copies of the examples branch's files in `.poly/probe/`, which is not committed.

**Probe 1: the concierge with its policy, as a project.** `CLEAN` in 92 s (160 s on a cold cache), peak 1.95 GiB, with a policy `concierge` `CLEAN` at every stage. The counts are those the examples session reported: `Desk` 1,826 states, flow rule 2,978, translation validation 107,734 transitions; `Notice` 28; `support.Conversation` 342; `staff.Conversation` 666; `payments.Grant` 13; `triage.Route` 6; `spend.Budget` 96; configuration `support` 26,211 global states, 650,210 steps and flow rule 34,179; configuration `staff` 3,620 and 194,795. This concierge still has the refund from before S462.

**Probe 2: the inbox's cross-account variant (IAC3).** The `Todo` machine of the inbox with a second `Principal` field, explored keeping only state keys:

| `Todo` | Principals | Model-check states | Steps | Flow-rule states | Flow-rule steps | Peak memory |
|---|---|---|---|---|---|---|
| Unchanged inbox | 3 | 7,294 | 605,402 | 18,746 | 1,555,918 | 0.17 GiB |
| With the second principal | 4 | 48,470 | 4,507,710 | 594,820 | 55,318,260 | 0.55 GiB (396 s) |

The flow rule's states grow 31.7 times. The state space is small, so the 12 GB limit is the edges a full check keeps (55 million steps), not the states; I did not measure which stage ran out. The stated limit stands, and the remedy is on the After v1 list.

## Per-field confidence at run time (owner's reviewer, 2026-10-10), built

**Defect.** Found by the concierge's first AC27 run. PD1.2b and PT28.3a give `r.conf.f` for each field of a record result, and the checker requires it, but the runtime computed one scalar `conf`. A program that follows PT28.3a completed with `conf` undefined, the step was refused, and every record decision took the failed path. **Ruled:** the runtime gives a conf for each field as the text says.

**Text** 958ce6d2 (PT10k). The text did not say how the runtime derives the numbers, so it now does: for a record result, a field's probability for a value is the sum of the provider's probabilities of the answers that hold it, `conf.f` is its calibrated probability for the value returned, and `margin.f` is that minus the calibrated highest probability of any other value, floored at 0. This is the marginal of the provider's joint distribution; a provider that gave a distribution for each field would need new text. A result that is not a record keeps one `conf` and one `margin`. **Tests** 3f579829, `test/decision-field-conf.test.mjs` with the fixtures in `test/fixtures/field-conf/`, written from the text by a writer that read docs, test and std only. Its harness was wrong in two places and the release session corrected it: its provider returned `conf` and `margin` itself, which tests the provider, and its machine was terminal in `Classifying`. The cases, with the joint distribution `{A,2}` 0.5, `{A,3}` 0.3, `{B,2}` 0.2: the answer `{A,2}` gives `conf.branch` 800, `margin.branch` 600, `conf.value` 700, `margin.value` 400; the answer `{B,3}` gives 200, 0, 300 and 0; the answer `{A,4}` (a value the distribution does not list) gives `conf.value` 0; the decision event holds the same as records; a scalar result is the control, `conf` 930 and `margin` 890. **Built** c01b347c: the manifest names a record result's fields, and `decisionHandler` gives `conf` and `margin` as records for them.

**Fail-first, shown.** Against the runtime before the fix the three record cases fail with the step refused and the failed path taken (`phase` is `Failed`, the decision's intent `dead`), and the scalar control passes. With the fix all five pass. Run one at a time, with no failure: `decisions`, `decision-budget`, `review-m2`, `routing`, `provenance-pd5`, `memory-runtime`, `session-replay` and `runtime-decisions`. No full suite has run since.

**For the examples session.** A record decision's recorded provider gives an answer and a distribution over whole answers; the runtime computes the per-field numbers from it, so a field whose value the distribution does not list has conf 0.

## S462, the mutant check (owner's reviewer, 2026-10-10)

**Asked.** A mutant of `items.read` with no origin or payload checks, the three refusal tests run against it, each failing for its own reason.

**The mutant.** In `capabilities.ts`, the refusal of a reference that is not an `Items` of the intent's own payload and the refusal of a set the runtime does not hold were removed, so `items.read` read whatever reference it was given. It was built, the three tests run, and the file restored and rebuilt; it was not committed. Against the mutant:
- the forged-reference test fails with `no refusal: {"read":null}`: the read of `items:forged` returned null instead of being refused;
- the unstored-reference test fails the same way, the read of a well-formed reference the runtime never stored returned null;
- the outside-the-payload test fails with `gave no refusal`, and the read returned both of c-a's orders (`o-2` and `o-1`, with their owner and keys): the handler read a stored set that is not its own.

**A finding in the tests, fixed.** The third test as first written, "another intent's set", read a made-up reference that no one stored, so it repeated the unstored case and could not tell a missing payload check from a missing store check. It now reads the set the retrieval kept for the same desk (both orders, a real stored set that the refund's payload does not hold), asserts that it differs from the payload's own, and asserts that the payload's own set still reads. With that, the mutant fails the three tests for three reasons: nothing refused a forged reference, nothing refused an unstored one, and a stored set outside the payload was read. The tests also now print what the read returned. Against the real code all 11 pass, and `capabilities.ts` is as committed.

## S463: a rejected completion of the application's own intent (owner's reviewer, 2026-10-10), built

**Found by the examples session** (`test/ex-concierge-liveness.test.mjs` on `ex`): a `require cites.count == 1` in the handler of a decision's completion checks `CLEAN` with a liveness property and fairness, while at run time the rejected completion leaves the `Desk` stuck in `Extracting`. The machine check offers a decision's completions as free inputs (PS4.4), so the failed completion is still there after a rejection and fairness takes it. At run time the intent is consumed. The generated configuration matches the runtime (S456) but reported nothing.

**Ruled.** In the generated configuration a reachable rejected completion of the application's own decision or effect is a finding with a witness, as `PL5406` is for a receipt, under a new code. The certificate states that machine-level liveness assumes no completion of the program's own intents is rejected, and the configuration finding discharges the assumption.

**Text** 4bb168bc (PS6.4, PS15.5, PT's code table and certificate paragraph). **Code** ac277d15: `PL5409 COMPLETION_REJECTED`, in `config.ts`: a step of the application that completes an intent pending in its pre-state and that its handler rejects, reported once per action at its first step in breadth-first order, with the path to it. **Decided in the text, not ruled:** a rejection with the reason `terminal` is no finding, because a completion that reaches an ended application leaves nothing waiting (without the exception, every application that ends while an intent is pending would have one). `admit.ts` adds one string to the certificate's `limits` when any machine of the build ran a liveness stage; that includes the std credential and route machines, so a build with a credential or a route carries it too.

**Tests** 7cf83115, `test/rejected-completion.test.mjs` with the fixtures in `test/fixtures/rejected-completion/`, from the S456 channel fixtures. The writer's first version was replaced by the release session (a require that no run could pass, a liveness property that failed on the machine, an array read as a string). The five tests: the require variant (the decision's ok completion refused by `require conf >= 0.5`) is `PL5409`, one finding, naming the action `Answered` and the reason `unsure`, with a witness whose last step is the rejected `Answered`; the `if` variant is `CLEAN`; with `liveness settles: phase == Asking leads to phase != Asking under fair { Answered | AnswerFailed }` the machine is `CLEAN` in the require variant as in the `if` one, and the configuration has `PL5409` (the assumption and its discharge in one check); a completion rejected `terminal` is no finding, and the configuration is shown to reach it; the certificate of a machine with a liveness property has one limit that states the assumption and names `PL5409`, and that of `conformance/m1/records.poly` has none.

**Fail-first, shown.** Without the code, the require variant is `CLEAN`, the defect as the examples session showed it, and the liveness and certificate tests fail; the `if` and `terminal` tests pass, as they should. With the code all 5 pass.

**Effect on the recorded verdicts.** Run one at a time, no failure: `channel-completions` (9), `certificate` (13), `thread-principal` (8), `one-value-principal` (6), `policy-channel` (11), `channels-adapters` (30), `channels-adapter-pin` (4), `rulings-m10` (11), `review-m8b-c` (8) and `channels-escalation` (4). The M8 concierge, `conformance/m8/concierge/concierge.poly`, checks `CLEAN` in 52 s, as `verdicts-after-rulings.json` records, and the examples branch's concierge with its policy is `CLEAN` in 162 s at the build before S462's refund. Not run: `std-channels`, `channels-events`, `review-m8b-d` and `tv`, which the gate run covers; if one of them fails with `PL5409`, the application it checks has a reachable rejected completion, and the finding is the ruled one. **Measured verdicts (gate item 3):** no file with a channel in `conformance/` or `examples/` changed; the 160 files are measured at the gate.

**For the examples session.** A channel application whose handler for a completion can reject it is now `PL5409` in its generated configuration. The concierge's `if` guard is the shape that has none. Rebase onto 4bb168bc.

## S463, the certificate states the assumption with its status (owner's reviewer, 2026-10-10), built

**Ruled.** The liveness assumption is stated with its status, not as a bare limit: **discharged** when the generated configuration covering that machine was checked and reported no `PL5409`; **open** only when no generated configuration covers the machine. The certificate test covers both statuses. This replaces the string that the S463 build put in `limits`.

**Text** 04714cef (PS6.4, PT's certificate paragraph): `poly.assumptions` holds, for each machine with a liveness stage, `{ id: "liveness-completions", machine, assumption, status, by }`, with `by` the configuration that discharges it, or null. A generated configuration covers the machine that is its channel's application. A machine whose covering configuration reported `PL5409` and a person accepted it is `open`. **Tests** b0908af8 and **code** 456f9249: `Certificate['poly'].assumptions`, built in `admit.ts` from the machines that ran a liveness stage and the checked configurations, and no liveness string in `limits`. The four certificate tests of `test/rejected-completion.test.mjs`: a channel application with a liveness property is `discharged` by `rc.support`; a machine alone with one is `open`, `by` null; the std machines of a credential (`stripe-refund.poly`) are `open`; a build without a liveness property has no entry; and in each, `limits` holds no liveness string. `certificate`, `credentials` and `revocation` pass, run one at a time. The new tests were not run against the previous build, where the field did not exist.

**A stated limit of the covering rule, for the owner.** Only a channel's generated configuration covers a machine, as its application, and only it offers the application's completions (S456); a declared configuration does not, and the conversation machine does not. A build whose `Grant` (std.credentials) or `Route` machines are in a declared configuration therefore shows the assumption `open` for them, not `discharged`; the build with a credential in `rc-grant` is such a case. Covering them needs the declared configuration to offer completions, which is new text. It is on the After v1 list.

## S463, discharged by form; policy files in examples/; the suite summary (owner's reviewer, 2026-10-10), built

**Ruled.** No new spec text for declared configurations. A machine none of whose completion handlers can reject (no `require`, no `reject` on any completion of its own intents) satisfies the liveness assumption by its form: status `discharged`, `by` "no rejecting completion handler", decided from the handler syntax. Test std's `Grant` discharged by form, and a machine with a rejecting handler and no configuration left open. Keep the declared-configuration item on the After v1 list (it stays).

**Text** f75c0eed (PS6.4, PT's certificate paragraph). **Tests** ea64afda and **code** eaad513b: `noRejectingCompletion` in `admit.ts` reads the handlers of the actions that the `ok`, `failed` and `exhausted` outcomes of the machine's own decisions and effects name, in every branch (`if`, `match`, `for`), and the machine's `guard` declarations, since a guard rejects every action. The configuration is preferred when it covers the machine too (`by` names it). A machine whose source the check does not hold is `open`. Tests: a machine with no `require` or `reject` in its completion handlers is `discharged` by form; a `reject` in an `if` branch of one handler, a `guard`, and a `require` each leave the machine `open`; the channel application with a liveness property is still `discharged` by `rc.support`.

**A std finding, reported: neither `Grant` nor `Route` qualifies.** Both have a `require ... else reject` in the handlers of their own completions: `Grant`'s `Refreshed` and `RefreshFailed` (`require g == Refreshing else reject "not-refreshing"`), and `Route`'s `Answer` and `Fail` (`require r == Trying else reject "not-trying"`). So the credential and route machines of a build are `open`, as before, and the test `rc-grant` says so. **By reading, not by a check:** neither rejection looks reachable while its intent is pending. `Route` leaves `Trying` only through `Answer` or `Fail`, each of which consumes the one pending `call` and emits the next or ends. `Grant` is in `Refreshing` from `TokenExpiring` until `Refreshed` or `RefreshFailed`, and the only other action that can take it out is `Revoke`, which ends it in `Revoked`, the terminal state, where a late completion is rejected `terminal` and is no finding (PS15.5). I have not machine-checked this, and the form cannot see it. Two ways to close it, for the owner: rewrite the four handlers as `if`, which is a change to `std` and to its checked counts; or let the declared configuration offer completions (the After v1 item).

**Earlier item 1, policy files in examples/: it was not done; now done.** `examples/` held no policy file on `v1`, so no test failed here, but on `ex` the concierge moves into `examples/concierge/` with `concierge.policy.poly`, and the serial group listed it as an example: checked alone it is `REFUSED (PL1001)` and it carries no expected line. **Text** none (the ruling of item 4 and `examples/README.md`). **Code and tests** 5c2b58b0: `exampleFiles` leaves policies out; `checkExample` checks a program with a policy beside it as one project (the policy signed as a person signs it, `maps/` and `prices/` copied), and returns the report `mismatch` reads, with the policies' diagnostics in `diagnostics`; `test/examples-expected.test.mjs` and `test/after/serial-sources.test.mjs` use them, so the expected line is the program's and the project's check is the one compared. The serial group's toolchain-fault check now runs on that project report, so the concierge is no longer checked twice. `test/examples-check.test.mjs` has two tests on a fixture pair (`test/fixtures/examples-policy`): no policy is listed, the expected line is in the program, the pair checks `CLEAN`, and a policy that does not parse changes the verdict. **Not run:** the serial group on the real concierge, which is on `ex`; the examples session's rebase runs it.

**Earlier item 2, the suite summary and a waiting test: already done.** `scripts/suite-summary.mjs` skips a failing-list line that carries a directive (`# waiting on ...`), and the totals count `todo` as waiting. The w9 log lists the waiting test under `failing tests:`, and the summary of that log reads `failures: 0`, `4 waiting`, `exit 0`. No change was needed. There is no test of the script; it is tooling.

## Discharge by form, fail-first (owner's reviewer, 2026-10-10)

The new certificate tests (`test/rejected-completion.test.mjs` and the fixtures `machine-form*.poly` at ea64afda) were run against 456f9249, S463 before discharge by form, rebuilt: 8 of 9 pass and the one that fails is the one that must. "A machine none of whose completion handlers can reject is discharged by its form" fails there with the machine `mf.Asker` `open` and `by` null, where `discharged` by `no rejecting completion handler` is expected. The tests that pass there are those of states the build already had: the rejecting handler in a branch, the guard and the `require` are `open`; the channel application is `discharged` by its configuration; the std machines of a credential are `open`; a build without a liveness property has no entry. The build was restored to 53f93736 afterwards, with the tree clean.

## The V10 gate (2026-10-11)

**The run.** Merge ba54b994 of 5a1e535f, the head the examples session reported (it had first run on 46517f51 and then a6e5e5ed, and was stopped and reset to 4b9b80d5 when the owner said neither was final), the measure-verdicts change reapplied (84822f54) and the inbox added to the serial group (1f02fbfa). A clean build, alone on the machine. The record is in `docs/v1/gate-v10.md`: the suite 2,452 tests with no failure (2 skipped, 4 waiting), the after group 12 of 12, check-memory passed, the 160 measured programs identical and three new entries (the `PL6830` error source, the concierge and the inbox, both CLEAN with their policies), every example meeting its expected line, per-file times compared (the load of 54 more files, no file's result changed).

**Commits since the last record.** Documents: 4b9b80d5. Merge: ba54b994. Measure: 84822f54 and a5b7892a. Serial group: 1f02fbfa. **Not pushed.** The ex branch and `aside-measure-verdicts` are local branches.

**Changed by the gate, on the way.** `scripts/measure-verdicts.mjs` measures a program with its policy as one project and gives each child 8 GB. The counts of the concierge are above its first report, as the release notes say.

**Waiting for the owner.** The word for main to be fast-forwarded to `v1` and for the local tag `v1.0.0` (Q-V1).

**Item 5, the spot check (2026-10-11).** `outbox-intent` alone 163 s (gate2 223 s) and `m4f-recheck` alone 373 s (gate2 289 s, 1.29 times), each under 1.5 times its gate2 time with nothing else running: the gate's slowdown was contention, and item 5 passes. The gate is accepted (items 1 to 4 and 6 to 7) by the owner's reviewer. Main is fast-forwarded to `v1` and the local tag `v1.0.0` made; not pushed.

## v1.0.1: the grant commands, loopback ingress, an entry guard, the keyring override (owner's reviewer, 2026-10-11), built

**Ruled**, from the examples session's dry run. (1) `poly grant-request` and `poly grant-revoke` get command-line forms: revoking in Google's account settings leaves the runtime's `Grant` believing the grant is live, so the owner must be able to sign a revocation from poly, by the local-first path of S461 and 72b08a3f. (2) `serveIngress` binds loopback by default; any other address is named explicitly. (3) An entry guard on `cli.js`, so it does not run on import. (4) An environment override for the per-user keyring configuration path, documented. And "nothing collects adjudications for a calibration refit" on the After v1 list (733d3bc3).

**Text** a14c510a (PS16.4, PT10g, PT21.4, PT12.5, PT14), the one PS/PT commit of this round. **Tests** 530d2477 and **code** f8a219a2.

1. **Grant commands.** The two were registry commands with no mapping on the command line and no usage text; they are mapped now. `grant-revoke (--grant <instance id> | --credential <c> --db <store>) --by --key [--out]`: with `--credential`, `liveGrants` (poly-runtime) reads the store with a read-only connection and the command signs the credential's one live grant, or, with a grant for each holder (S461), prints the ids on stderr and signs nothing. Tests (`test/grant-cli.test.mjs`, 6): the request written and taken; the central case, a grant revoked at the provider is not seen (still `Granted`, still allowed) until the owner's signed revocation is taken from the approvals folder, when the `Grant` is `Revoked` before any request to the provider and the provider's revocation follows, with the intent denied `credential-unavailable` in between; the store form with one grant, with two, and with none; an agent's key refused `wrong-key`; usage errors; the usage text. **Stated limit:** the holder is named in the store by a keyed digest that is never exported, so the command cannot find a holder's grant by the holder's name; the host reads the id with `rt.grantOf(c, holder)`, and a per-owner grant is named with `--grant`.
2. **`serveIngress`** listens on 127.0.0.1 unless `opts.host` names another (`test/serve-ingress-host.test.mjs`: the default and a request to it, `0.0.0.0` named, `127.0.0.1` named).
3. **Entry guard.** `cli.js` runs `main` only when its real path is the process's entry; `main` was already exported (`test/cli-import.test.mjs`: importing prints no usage and exits 0; the entry still prints usage and exits 64).
4. **`POLY_ANCHORS_CONFIG`** (withdrawn in part, see "v1.0.1, second round" below: it is honoured only in a test process), an absolute path to the configuration file, outside a tree under version control, or `PL6410`; a test process's folder wins; the certificate's `source` stays `user` (`test/anchors-env.test.mjs`). **This weakens an earlier rule** (the anchor's location is never read from the environment, so an agent confined to the project cannot redirect it): an agent that can set the environment of the owner's `poly` and runtime processes can redirect the anchor, as one that can write the configuration file can. The text says so; the control is the owner's file permissions and the process boundary.

**Fail-first, shown.** Without the code (packages stashed, rebuilt): `grant-cli` fails 5 of 6 (the usage-error case passes, since the command was not found and exits 64 either way), `serve-ingress-host` 2 of 2, `anchors-env` 3 of 3, `cli-import` 1 of 2 (the entry case passes). With it all pass. Run one at a time with no failure: `cli`, `agent-mcp`, `agent-lsp`, `journal-cli`, `keyrings`, `person-keys`, `s210`, `grants`, `certificate`, `memory-forget`, `revocation`.

**The writer's first version, and what the release session replaced.** The ingress file was a placeholder that asserted `true`; three of the grant cases used a harness that does not exist (`rt.redirect`); and the anchors test ran `poly anchor keyrings` with the variable set and no test anchors. On the build before the code that ignores the variable, so the run wrote the real home's `~/.poly/anchors.json` (created 2026-10-11 04:18, with one entry, `anchors-env-test`). **This file is left for the owner:** it was written by a test I ran through a subagent, I did not read it beyond the name of its entry, and the permission system stopped me from reading it again. The anchors tests now probe read-only first (the same process's `readAnchorConfig`) and write only when the variable is honoured, so they cannot do it again.

## v1.0.1, second round (owner's reviewer, 2026-10-11), built

**Accepted:** items 1 to 3 of the first round. **Two changes and one item.**

1. **`POLY_ANCHORS_CONFIG` only in a test process** (one that already accepts test anchors, S194). Otherwise it is refused with `PL6410`, and the home configuration is used. This restores the old rule, that the environment cannot redirect the owner's anchor, so the "weakened rule" text is removed from the spec and the release notes. **Text** 060315e6. **Tests** f53b075d, **code** 10c7ffb4. A process that has named a test anchor folder reads the file the variable names (absolute, outside version control, or `PL6410`) as source `test`; any other process ignores the variable, prints one notice on standard error that names `PL6410`, and reads the home configuration. The test the owner asked for, "a non-test process with the variable set uses the home config, and says so", is the first of `test/anchors-env.test.mjs`; the other three cover the test process, the refusals and the CLI in a test process, and none writes outside a folder of its own. **Fail-first:** without the code all four fail. "Refuse it with `PL6410`" is read as the notice, since a refusal that stopped the process would not "use the home config"; say if it should stop.
2. **The real home is never written by a test.** The file in the owner's home is left; the owner deletes `~/.poly/anchors.json` himself. `test/fixtures/home-guard.mjs` is a guard in the test preload: it records what is under the owner's `.poly` folder at the start of a process and fails the process that changed it, naming the file. `npm test` preloads it into both runs (`node --import ./test/fixtures/home-guard.mjs --test`, which hands it to each file's process), and `runtime-helpers.mjs` and the test-anchors preload import it for a process started another way. `test/home-guard.test.mjs` (4 tests) shows it fails a writer, a changer and a remover and not a reader, that it fails a `node --test` child that writes, and that it is wired. **A cost:** if the owner deletes the file while a suite runs, every process running then reports a guard failure, since the guard cannot tell who changed it.
3. **Item 5, the calibration-map warning.** Maps are step functions, so a two-point "identity" map `{(0,0), (1000,1000)}` sends every raw probability under 1 to 0; that nearly held all of the owner's mail in the inbox dry run. **Text** 060315e6 (the map format's bullet in PT24 documents the step semantics and the warning). **Tests** f84fbfbb (`test/calibration-warning.test.mjs`, 14) and **code** f2adbcbf (`calibrationWarning` in `routing.ts`, the pipeline, `render`). `poly check` warns, beside the verdict and never in it, for each tier whose map sends two or more consecutive raw values to 0 (those below its first point included), and for a map whose points all lie on the diagonal but is more than 100 thousandths from the identity somewhere. The report's `warnings` gets `{ kind: "calibration", route, tier, map, why }`; `poly check` prints a `warning:` line; the map is used as it is. The two thresholds, two values and 100 thousandths, are my choices where the ruling said "a whole open interval" and "too few points"; say if they should differ. **Fail-first:** without the code seven of fourteen fail (the others are the cases that must not warn, the digest, the runtime's step semantics and the inbox analysis). The writer's first version had a muddled case with a non-monotone map, a tautology on the tolerance and one wrong digest assertion; the release session replaced them, so each reason is tested alone (from `(1,1)` only the raw value 0 goes to 0, which is not an interval).
   **All four committed maps of the inbox warn** (`kind-large`, `kind-small`, `triage-large`, `triage-small`: raw 0 to 499 goes to 0 because each starts `(0,0), (500, …)`). That is the warning's finding about the examples, and the examples session's to answer; no verdict changes.

**Run, one at a time, no failure:** `shadow-warning`, `routing`, `routing-decl`, `routing-rulings`, `routing-swap`, `std-routing`, and the first round's list.

## v1.0.1, third round: the calibration threshold, the inbox's maps, the tag (owner's reviewer, 2026-10-11)

**Ruled.** The calibration warning is for a band of raw values wider than 100 thousandths sent to 0, starting above raw 0, not for two consecutive values: raw 0, or a narrow band near it, sent to 0 is harmless. The second rule (points on the diagonal but more than 100 thousandths from the identity) stays. One map just under the limit stays quiet, one just over warns.

**Text** 6b78de3a (PT24). **Tests** 95dd186e (`test/calibration-warning.test.mjs`, 15): the map `[[0,0],[101,50],[1000,900]]`, whose raw values 1 to 100 go to 0, is quiet; `[[0,0],[102,50],...]`, 1 to 101, warns, with the reason `101 raw values 1 to 101`; a map from `(1,1)` and one with a band of 29 near raw 0 are quiet; the diagonal map with points 100 apart from `(0,0)`, which used to warn for its zero band of 99, is quiet. **Code** b7f89561: `calibrationWarning` takes the longest run of raw values from 1 to 1000 calibrated to 0, and warns when it is more than 100. The test edits were made by the release session, not by the test writer. The tests ran with the home guard: `~/.poly/anchors.json` was not touched by them.

**The examples' maps.** ddaa7fb5 (merged as 4ff14f97, on 6b78de3a) gives the inbox's four maps a dense low range, so no band above raw 0 goes to 0, and adds `test/ex-inbox-maps.test.mjs`. **Verified at 4ff14f97 plus the harness change below:** the inbox as a project (program and policy, checked as one) is `CLEAN` with no `warnings` (84 s); `poly check examples/inbox/inbox.poly` is `CLEAN` and prints no `warning:` line (89 s); every `ex-inbox*` file passes, one at a time, with the home guard (`ex-inbox` 3, `ex-inbox-drafts` 7, `ex-inbox-read-grant` 2, `ex-inbox-host` 3, `ex-inbox-maps` 1, `ex-inbox-no-test-anchor` 2, `ex-inbox-provider` 9, `ex-inbox-readme` 3, `ex-inbox-readonly` 4, `ex-inbox-setup` 4, `ex-inbox-startup` 1), as do `ex-gmail-source` (11) and `ex-gmail-traffic` (2); and the inbox dry run, which the maps change what the host computes for, passes (`test/after/ex-inbox-dry-run.test.mjs`, 94 s). `checkExample` now also returns the project's `warnings`.

**One thing for the owner.** `~/.poly/anchors.json` was still there, dated 04:18, when I checked at 07:54, after the message that it was deleted; nothing of mine wrote to it (the guard would have failed the process).

**Tag.** `v1.0.1`, annotated, local, on the commit this record is in; not pushed.
