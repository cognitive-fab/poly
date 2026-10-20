# Proposal: a distinct guest outcome for an amount outside the domain

This is a proposal for the owner to decide. It changes the program. No code is written for it.

## What happens today

A guest writes `refund me 5,000`. The amount decision returns 5000. The program's type is `Amount = { value: 0..500 }` (AC30), so the runtime refuses the completion before the Desk sees it (S140). Offline, with a recorded amount of 5000, the ledger shows this:

- the intent `decision.amount` is `dead` after 1 attempt, with `the completion is outside its type (S140)`;
- the audit table holds rule `S140` with `Amounted.value is 5000, outside 0..500 (PS3.2, S140)`;
- the Desk's journal holds `Unextracted` accepted, with the data `{"reason":"exhausted"}`.

The effect's `failed -> Unextracted()` then runs, the Desk asks the reply decision for the outcome `Unsure`, and the guest hears something like "a member of staff will follow up". No request reaches the Stripe mock-up. That is the claim of AC30, and it holds. What is missing is a better thing to tell the guest: "above what can be refunded".

## Why the Desk cannot tell the two cases apart today

`Unextracted()` has no parameter. Every failure of the amount decision lands in it: a provider that fails, an ask that is cut off, a vote with no allowed answer, and an answer outside the type. The failed hook passes the Desk a `reason`, but the runtime gives it the same word for all of them (`exhausted`), and the action does not take it.

## Options

### A. The runtime names the reason; the program uses it

1. The runtime gives the failed hook the reason `outside-type` when the cause is a refusal under S140 (and keeps `exhausted` for the rest).
2. The Desk's `Unextracted` takes a `reason`, and a handler branches: for `outside-type` it asks `reply(question, outcome: OutOfRange)`, for any other reason `Unsure` as today.
3. `Outcome` gains `OutOfRange`.

This keeps the meaning of AC30 intact: the refusal is still at dispatch, and the number still never reaches the handler.

### B. The program only: widen the type and refuse in the Desk

1. `Amount` becomes a wider range (for example `0..100000`), and the Desk's `Amounted` handler compares `value` with 500: above it, `reply(question, outcome: OutOfRange)`; otherwise the refund as today.
2. The effect `refund(amount: 0..500, ...)` keeps its own type, so the handler still cannot receive more than 500.

This needs no runtime change. It moves the refusal from the dispatch of the decision to a guard of the Desk, so the sentence "a value outside the type is refused at dispatch" is no longer what Act 2 shows for this case. The proof that no value above 500 reaches the handler still holds, by the effect's type and the guard.

### C. No change

The guest hears the `Unsure` reply, and the presenter explains it. The terminal line already says `outside its domain (0 to 500)` (DF17).

## What each option touches

| Part | A | B |
|---|---|---|
| `examples/concierge/concierge.poly`, and the demo copy, which is generated from it | `Outcome`, `Unextracted`, one handler | `Amount`, `Outcome`, `Amounted` |
| The Desk machine | a new action parameter and a branch | a branch in `Amounted` |
| The instance (Desk 2114 states today) | grows: a new value in the reply outcome and a new path; it must be measured again | grows the same way, and the range of `Amount` is explored at its cuts (S458), which changes the cuts |
| The reply outcomes | `OutOfRange` is a new outcome of the reply decision | the same |
| `poly-runtime` and the semantics (PS, PT) | yes: the reason of a failed hook, its documentation, its tests | no |
| The recorded answers (`test/fixtures/concierge/answers.json`) | `replies.OutOfRange` for `refund-outside` ("Refund me 650 now.") | the same |
| The checks | the check of the Desk runs again (91 to 176 s for the concierge), the certificate and the verdict baseline are produced again | the same |
| Tests that name the old reply | the end-to-end test of the concierge, `demo-room-answers`, the runbook table of step 2.5, and the row of DS2 that says "the Desk replies that it is unsure" | the same |
| The model's side | the reply decision is told the outcome `OutOfRange`; its prompt sentence ("tells them the outcome given") already covers a new outcome | the same |

Neither option touches the policy file or the budget.

## Recommendation

Take A if a runtime change is acceptable in v1.3, because it keeps what Act 2 claims. Take B if the change must stay in the program. Take C if v1.3 is about the page and the launcher and not about the program.

Either way, decide before the program is regenerated: the demo copy, the certificate and the fixture move together.

## Decision needed

Which of A, B or C, and the wording of the reply for `OutOfRange` (for the recorded fixture): for example "That is above what we can refund in one request. A member of staff can look at it."

## Conclusion

The refusal of 5,000 works and is recorded. The guest is told too little, and the program cannot say more because its failure action carries no reason. Option A fixes that at the cause, at the cost of a runtime change. Option B fixes it in the program, at the cost of a weaker sentence for Act 2. Both change the instance and need the check to run again.

## Glossary

- **AC30:** the acceptance criterion that a number outside the strict domain never reaches the handler.
- **S140:** the rule that a completion outside its type is refused before it is a step.
- **Domain:** here, the range `0..500` of the amount.
- **Outcome:** the word the reply decision is given to say what happened (`Refunded`, `Declined`, `Unsure`, ...).
- **Instance:** the states the checker explores for a machine, printed at the launch.
