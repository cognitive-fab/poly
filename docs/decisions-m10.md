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

## Conclusion

M10 is ruled. Its one measured risk, the taint state space, is measured first and brought to the owner if it does not fit.
