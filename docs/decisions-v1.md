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
