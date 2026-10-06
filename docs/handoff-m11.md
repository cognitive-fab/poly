# M11 planning brief: Routing and budgets

M11 is planned while M9 is built, and built in parallel with M10 once M9 closes (`decisions-m9.md`, "how M9 to M11 run"). The first deliverable is `docs/plan-m11.md`, for the owner's ruling. No code before the plan is ruled.

## 1. Scope

As `docs/proposals/v1-technical-spec.md` sets it (PT24): `route`, `budget`; the `Route` and `Budget` machines; reservations; `poly cost`; the tier swap rule. Gate: AC25 and AC26, with every provider call recorded.

## 2. What the plan must settle

- **Budgets as reservations (PT24.3).** A reservation is taken before the effect and settled after, so no budget is ever overspent, including under retries and crashes. State the property the checker proves, and the crash case the runtime test covers.
- **E11.** M9 settles E11 for grants by having poly-runtime read the `Grant` machine itself (S199). The plan says whether `Budget` and `Route` are read the same way, settled by test, fail closed.
- **Calibration and tier swaps (PT24.1b, PT24.5).** `PL6841` and `PL6842`: what a calibration map is, where it is stored, how a model change is detected, and how a refitted map is certified.
- **Provider calls.** Every model call is recorded and replayed from the record; no test calls a live provider and no test spends money. The owner's monthly API limit applies to anything the plan runs.
- **`poly cost`** reads the records only. No price is hard-coded without its source and date.
- **What a record may hold.** No prompt, completion body or key enters the journal, the ledger or a certificate; bodies are `Content` by digest.

## 3. Numbering and shared files

Spec issues S350 to S399. New codes from PL6843 to PL6849, beside PL6841 and PL6842. List every change to `04-semantics.md` and to shared packages in the plan, so it can be ruled together with M10's.

## 4. How it runs

As `decisions-m9.md` sets: a ruled plan runs to its end, stopping only for semantics, security, verdict or engine changes. Rulings in `docs/decisions-m11.md`. Commits as `kizo-core`, never pushed.

## Conclusion

M11 gives poly routing and budgets that cannot be overspent. Its plan must prove the reservation property, keep every provider call recorded and replayable, and spend nothing live in tests.
