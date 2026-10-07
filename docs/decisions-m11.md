# M11 decisions

Rulings on `plan-m11.md`, in the order they are made. Each entry names who ruled. M11 runs as `decisions-m9.md` sets ("how M9 to M11 run"): a ruled plan runs to its end, stopping only for semantics, security, verdict or engine changes.

## plan-m11.md ruled, jointly with plan-m10.md (owner, 2026-10-07)

The plan is accepted. M11 starts when M9 closes, in its own worktree and session, in parallel with M10.

- **S350, money and price tables: accepted.** Integer micro-units; every table carries its source URL and the date it was read (`PL6843`).
- **S351, the `Route` machine: accepted.**
- **S352, reservations: accepted, with one addition.** The property `spent + reserved <= cap + overrun` is accepted, since an overrun is a provider reporting more than the limit it was given. Every overrun is journaled and reported, the scope's remaining budget is reduced by it, and a test shows the next reservation is refused when the overrun has used the remainder. The crash test between reservation and completion is required as planned.
- **S353, reading `Budget` and `Route`: accepted, fail closed.** A missing or unreadable instance refuses the call; E11 is settled by test.
- **S354, concurrency: accepted.**
- **S355, calibration maps and the tier swap: accepted.**
- **S356, providers: accepted.** No model SDK enters poly; only the recorded provider ships, and no test calls a live model.
- **S357, usage and overruns: accepted**, with S352's addition.
- **S358, records and `poly cost`: accepted.** No prompt, completion body or key enters a record.
- **S359, work orders with budgets: deferred to M7, as proposed.**
- **Shared changes with M10:** as ruled in `decisions-m10.md`. M10 merges first where both touch the same lines; M11 rebases.

## Step 1: PS18, routes and budgets, written before the code

Section 6 of the plan, ruled, is written into `04-semantics.md` as PS18, beside `route-exhausted` among PS3.2's reserved reasons and K15 in PS10's table. Decided by the plan's rules, each with its reason:

- **Numbering.** The section is PS18, and PS17 is left to M10, which plans memory as the next surface, so the two sections merge without touching the same lines. The PT text of this milestone is `PT10r` for the same reason.
- **The modules.** As a credential means `m.c` (PS16), a route means `m.r`, `std.routing` with `Route` instantiated for the route, and a budget `m.b`, `std.routing` with `Budget`. `Route` is instantiated by four rewrites named in PS18.1 (the tier range, the tiers left, the escalation condition, and failure), so the checker and poly-ref each write it from the text. `Budget` needs no instantiation: its cap is opened at run time (`Open(cap)`), so one checked machine serves every cap.
- **The budget's check (S352).** `spent + reserved <= cap + overrun` is checked on `Budget` alone, with the cap, reservations and costs in small check domains that place a reservation below, at and above the remainder, and a cost below, at and above its reservation. The amounts at run time are micro-units far above them, so the domains are `disclosed` (PT3.4): the verdict prints its instance and says what it covered, and no silent clean is claimed for amounts it did not explore.
- **Where a tier's call is governed.** A call is an intent of the route's instance, so its trust scope is the module `m.r` (PS8.7), as a channel's sends are under `m.c`. A policy governs it by naming that scope.
- **`on exhausted escalate`.** An approval does not raise a cap: an approved intent is read again, and is denied `budget` when its reservation still does not fit, so the property holds under every approval.
- **One decision per route.** A tier's map is fitted for one decision (PD1.6a), so a route serves one decision, and its calls take that decision's labels and timeout.
- **A failed call releases its reservation.** A call that fails reports no usage, so its reservation is released, as S352 says of a dead intent. What a provider bills for a failed call is outside K15, and is listed as a limit.
- **Records.** Each answered tier's call has its own `decision` event on the route's instance, with its cost. The decision's own event repeats the answering tier's and links its hash, so `poly cost` sums the calls' events and counts each cost once.

**For the owner, not blocking: `poly try`.** Q9 was ruled on 2026-10-06 to put `poly try` (PT28.2) at the start of M11. The M11 plan, ruled on 2026-10-07, does not list it, and its scope is PT27.3's row. The session follows the later ruled plan and does not build `poly try`; it is raised again at M11's close.

## Conclusion

M11 is ruled. Budgets are reservations that cannot be overspent except by a provider's own overrun, which is recorded and charged against what remains.
