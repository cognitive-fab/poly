# Appointment booker

A small clinic books appointments from free text. A typed decision reads "Can I get Tuesday at nine?" and answers a day and an hour. The program books that slot through an irreversible, keyed calendar write, and refuses a slot that is already taken. Everything here runs on recorded answers: no model is called and nothing leaves the machine. The spec is `docs/examples/appointment-booker.md`.

## What it shows

- **A typed decision.** `parse` returns a record, `When = { day: 0..1, hour: 0..1 }`. The runtime gives a confidence for each field, and the program books only when both are at least 0.8. A vague request ends `Unclear` and books nothing.
- **A property against double-booking.** The step property `free-slot-only` says that the calendar enters `Booking` only for a slot that was free. Two invariants say that `Booking` and `Booked` hold their slot.
- **An irreversible, keyed write.** `calendar.write` is class `irreversible`. The handler sends the intent's idempotency key, the same on every attempt, so a retry whose answer was lost is one booking. When the write is tried three times with no answer, the slot stays taken (`Uncertain`) and only a person's `Resolve` frees it.
- **A policy.** The calendar write is allowed only while the calendar is `Booking`, and the model is asked only while it is `Parsing`. The second rule is also what satisfies polycheck's region for a decision that sends private text out (`PL7001` without it).
- **A seeded defect.** `appointment-booker-defect.poly` has the overlap check removed. The check rejects it with a witness.

## Run it

From the repository root, after `npm ci` and `npm run build`:

```sh
node packages/poly-check/dist/src/cli.js check examples/appointment-booker/appointment-booker.poly
node packages/poly-check/dist/src/cli.js check examples/appointment-booker/appointment-booker-defect.poly
node packages/poly-check/dist/src/cli.js check examples/appointment-booker/appointment-booker.poly --root examples/appointment-booker --host examples/appointment-booker/host/tsconfig.json
node --test test/ex-appointment-booker.test.mjs
node --test test/after/ex-appointment-booker-e2e.test.mjs
```

The first two check the program alone. The tests check it with its policy beside it, as a project. The third compiles the handler against the generated `types.d.ts`.

## What is checked

| Check | Result |
|---|---|
| Program with its policy | `CLEAN`; `Calendar` over 380 states, 2 content representatives, 4 slots; about 5 s |
| Policy | all seven stages `CLEAN`, including the regions |
| Defect copy | `FINDINGS`, exactly `PL3002 STEP_PROPERTY` (`free-slot-only`), witness of 6 steps: `Ask`, `Parsed(0, 0, 800, 800)`, `Written`, `Reset`, `Ask`, `Parsed(0, 0, 800, 800)`; 320 states |
| Host handler | compiles under `poly check --host`; a wrong payload field is `PL6836` |
| End to end | 7 tests: main path, a refusal (taken slot) and an unclear request, a keyed retry, a refused write, an unanswered write and its resolution, and a journal that replays (3 runs, 16 rows, 1 gate session, no divergence) |

## What is not checked

- **The calendar itself.** The check says the program never asks for a taken slot. It cannot say the real calendar agrees about which slots are taken.
- **The model.** The recorded answers stand in for it. The confidences are the ones the fixture's distributions give, with no calibration map.
- **A larger calendar.** The calendar has 4 slots, 2 days of 2 hours, to keep the check small (380 states). A week of 8 slots was not tried; `CLEAN` is a statement about these 4 slots.
- **One person's slots.** There is one calendar with four slots, and `CLEAN` is a statement about that instance.
- **The escalation to a person.** This example has none; `Resolve` is the owner's dispatch, not a gated approval. Expense approval shows the gate.

## Conclusion

One comparison in `Parsed` is all that stands between the calendar and a double booking, and the check finds its absence in six steps. What the check cannot see, a lost answer to an irreversible write, the key and the held slot cover, and the end-to-end test shows it.

## Glossary

- **Slot:** one of four times, `day * 2 + hour`.
- **Keyed write:** an irreversible effect whose request carries the intent's idempotency key.
- **Uncertain:** the write was tried to its limit with no answer; the slot stays taken until a person resolves it.
- **Recorded answers:** a model's answers written down in advance, so a run needs no provider.
- **Witness:** the shortest sequence of steps that violates a property.
