# M10 decisions

Rulings on `plan-m10.md`, in the order they are made. Each entry names who ruled. M10 runs as `decisions-m9.md` sets ("how M9 to M11 run"): a ruled plan runs to its end, stopping only for semantics, security, verdict or engine changes.

## plan-m10.md ruled, jointly with plan-m11.md (owner, 2026-10-07)

The plan is accepted. M10 starts when M9 closes, in its own worktree and session, in parallel with M11.

- **S300, the taint domain: accepted as proposed**, `(class, owners)` with owners a subset of the explored principal representatives. The alternative (a count of owners) cannot prove AC22 and is refused. Step 1 measures the cost on the concierge. If the taint space does not fit the checker's bounds, M10 stops and brings the numbers; it is not reduced silently.
- **S301, the flow rule as a step property: accepted.**
- **S302, enforcement at run time: accepted, fail closed.** The runtime's `audience` refusal is final, content with no taint record is refused, and E10 is settled by test.
- **S303, `Items` and retrieval: accepted**, with `PL6833` to `PL6835`.
- **S304, citations: accepted.**
- **S305, the recipient's class: accepted.** A recipient with no claimed class and no channel default is `public`, the most restricted reader, so it fails closed.
- **S306, forgetting: accepted.** The subject may be a principal or a whole source (for example one mail account), so the inbox assistant's `poly forget --account` is the same mechanism.
- **S307, freshness: accepted.**
- **S308, source adapters: accepted as proposed** (Postgres through a host-supplied query function, OpenSearch over recorded traffic). The Gmail and SES sources of the inbox assistant are not M10 scope: they are built with that example, on the same pattern.
- **S309, remembering, and S310, what a record may hold: accepted.**
- **Q3: a total order of audiences for v1: accepted.**
- **Shared changes with M11 (section 6): accepted.** Each milestone adds its own clause, reserved reason and proposal field in its own function or file; the decision completion path keeps one ordered list of checks that each appends to; where both touch the same lines, M10 merges first and M11 rebases.

## Step 0: generated host types and edit-and-check, before the memory plan (owner, 2026-10-07)

Q9 (decisions-m9.md) placed generated host types (PT28.1) and `poly_edit_check` (PT28.4) at the start of M10, and `plan-m10.md` did not list them. Asked, the owner ruled: build both as M10 step 0, then go on with the memory plan. New codes come from PL6833 to PL6839 and spec issues from S300 to S349; `poly_edit_check` never admits, signs or runs anything (PT28.4d).

Spec issues S300 to S310 are the plan's, so step 0's are numbered from S311. Each is decided by the plan's rules and recorded with its reason:

- **S311, the declarations' form.** PT28.1 does not fix how a type is written. A small integer range is the union of its literals, so a host that passes 7 to a `0..5` parameter fails to compile, and a widened parameter is visible to the read-back; above 64 values it is `number`, to keep the file readable. The state is the flat form of PS9.1b, since that is what `rt.dispatch` and `rt.getState` return. poly-ref writes the file it expects from its own model and compares the two, which is the standing rule's read-back for a text artefact.
- **S312, the host check.** PT28.1d leaves its code to the ruling: it is `PL6836 HOST_TYPE_ERROR`, a finding. PL6833 to PL6835 stay with S303, as planned. The compiler is the `typescript` package, the one npm package outside poly the boundary already allows, loaded in process, since a check package may not start a subprocess. A host check that cannot run is listed as not run and the verdict is at best `INCONCLUSIVE` (no silent clean).
- **S313, edit-and-check.** PT28.4a's "optional configuration" is read as the project whose `poly.json` names the program the module is checked with. PT28.4c says a "refused or failing" edit leaves the project unchanged: an edit is written only when its verdict is not `REFUSED`, `ERROR` or `NONDETERMINISM`, so an agent can keep an edit that leaves a finding to fix next, and never one that does not check.

The PT text is PT10h, written first.

## Conclusion

M10 is ruled. Its one measured risk, the taint state space, is measured first and brought to the owner if it does not fit.
