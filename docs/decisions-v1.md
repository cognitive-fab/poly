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
