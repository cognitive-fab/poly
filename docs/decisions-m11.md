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

## Conclusion

M11 is ruled. Budgets are reservations that cannot be overspent except by a provider's own overrun, which is recorded and charged against what remains.
