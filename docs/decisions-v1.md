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
