# Subscription cancel

A subscriber asks to cancel. The service may make one retention offer first, and the subscriber may keep the subscription, decline the offer, or say nothing, in which case the offer lapses after a week and the cancellation goes ahead. Cancellation is an irreversible call to billing, attempted once. The example calls no model: what is recorded is the answers of the marketing and billing services, as the end-to-end test's fake transport, so nothing leaves the machine. The spec is `docs/examples/subscription-cancel.md`.

## What it shows

- **Liveness.** `request-ends`: a request to cancel always ends, in a cancellation, in the subscriber's choice to keep, or in `Stuck` (a person's), under the assumption that the timer and the effects' completions are taken, and that a person resolves an offer or a cancellation whose answer was lost (`Resolve` is in the fair set). The subscriber's own actions (`Keep`, `Decline`) are not assumed: the lapse is what makes the request end when nobody acts.
- **An offer at most once.** The path property `offer-at-most-once` and the field `offers : 0..1` hold; a failed offer does not block the subscriber, who is cancelled without a second offer.
- **An irreversible cancellation, attempted once.** Neither billing nor marketing documents an idempotency key, so the offer and the cancellation are `retry { attempts 1 }`: a retry whose first answer was lost could send either twice, which v1.3's retry-safety rule reports as `PL4003` (finding 31). The path property `cancel-at-most-once` holds. A cancellation billing refuses ends `Stuck`, for a person; an offer or a cancellation the program cannot read goes to `OfferUnknown` or `CancelUnknown`, and a person's `Resolve(done)` says which.
- **A seeded defect.** `subscription-cancel-defect.poly` makes `Decline` offer again, in place of cancelling: a subscriber who declines is offered again, without end.

## Run it

From the repository root, after `npm ci` and `npm run build`:

```sh
node packages/poly-check/dist/src/cli.js check examples/subscription-cancel/subscription-cancel.poly
node packages/poly-check/dist/src/cli.js check examples/subscription-cancel/subscription-cancel-defect.poly
node packages/poly-check/dist/src/cli.js check examples/subscription-cancel/subscription-cancel.poly --root examples/subscription-cancel --host examples/subscription-cancel/host/tsconfig.json
node --test test/ex-subscription-cancel.test.mjs
node --test test/after/ex-subscription-cancel-e2e.test.mjs
```

The tests check each program with its policy beside it, as a project.

## What is checked

| Check | Result |
|---|---|
| Program with its policy | `CLEAN`; `Subscription` over 9 states; the liveness stage ran under weak fairness; about 1 s |
| Policy | all seven stages `CLEAN` |
| Defect copy | `FINDINGS`, exactly `PL3301 LIVENESS_LASSO` (`request-ends`), a lasso of 6 steps: `Request`, `OfferSent`, then a cycle through an offer whose answer is lost, `Decline`, `OfferUncertain`, `Resolve`, `Decline`; and `PL4001 PATH_PROPERTY` (`offer-at-most-once`), a witness of 3 steps: `Request`, `OfferSent`, `Decline`, the last offering again |
| Host handlers | compile under `poly check --host`; a wrong payload field is `PL6836` |
| End to end | 11 tests: admission, a decline that cancels, a keep, a lapse after 168 hours, a refusal of a second request and of a keep before an offer, a failed offer that still cancels, an unknown cancellation and an unknown offer each resolved either way, two subscriptions sending different keys, a refused cancellation ending `Stuck`, and a journal that replays (3 runs, 17 rows, 1 gate session, no divergence) |

## What is not checked

- **Time.** The check does not compare durations: 168 hours is only "a timer that may fire". That the offer lapses after a week is the end-to-end test's, on a clock it moves.
- **"Always reachable" is not "always reached".** The property says a request ends if the services answer and the timer fires. That cancellation is reachable from every state (a path exists) is shown by deadlock freedom and by the program's shape, not by a possibility property of its own.
- **The offer.** That it is worth making, or lawful, is not a property of the machine.
- **Domains.** One subscription, one offer. Nothing was reduced; `CLEAN` is a statement about 9 states.

## Conclusion

Liveness is what a retention flow owes the subscriber: whatever the service does, a request ends. The check finds the loop in six steps, and the one-line fix is what the property says: a decline cancels. What no check can say is that the offer is worth making.

## Glossary

- **Liveness:** a property that something eventually happens, under a stated fairness assumption.
- **Lasso:** a path that reaches a cycle it can repeat for ever; the counterexample to a liveness property.
- **Retention offer:** an offer made to a subscriber who asked to cancel.
- **Stuck:** a terminal state that waits for a person.
- **Recorded services:** the answers of the marketing and billing services written down in advance.
