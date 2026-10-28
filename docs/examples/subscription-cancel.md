# Example spec: subscription-cancel

Batch 5, example 1. Written before any test or code (rule 7a). The tests are written by someone who has read only this page, so everything a test needs is on it.

## Purpose

A subscriber asks to cancel. The service may make one retention offer first, and the subscriber may keep the subscription, decline the offer, or say nothing, in which case the offer lapses after a week and the cancellation goes ahead. Cancellation is an irreversible, keyed call to billing. The point of the example is **liveness**: a request to cancel always ends, in a cancellation or in the subscriber's own choice to keep, and **the offer is made at most once**. The seeded defect is an offer loop that blocks cancellation: declining makes another offer.

The example calls no model. What is recorded is the answers of the marketing and billing services, as the end-to-end test's fake transport.

## Files

All paths are under `examples/subscription-cancel/`. The names are fixed.

| File | Content |
|---|---|
| `subscription-cancel.poly` | module `subscription`, first line `// expected: CLEAN` |
| `subscription-cancel.policy.poly` | module `subscription_policy`, policy `retention`, scope `"subscription"` |
| `subscription-cancel-defect.poly` | the program whose `Decline` makes another offer, first line `// expected: FINDING PL3301 PL4001` |
| `subscription-cancel-defect.policy.poly` | the defect's policy beside it; the same text as the program's |
| `host/handlers.ts` | the certified handler file; exports `offer` and `cancel` |
| `host/tsconfig.json` | compiles `host/handlers.ts` for `poly check --host`; run with `--root examples/subscription-cancel` |
| `host/recorded.mjs` | the recorded services: exports `recordedServices(script)` |
| `README.md` | what it shows, how to run it, what is checked, what is not, a conclusion, a glossary |

Tests: `test/ex-subscription-cancel.test.mjs` (light) and `test/after/ex-subscription-cancel-e2e.test.mjs` (admission and a run). The shared helper is `test/ex-kit.mjs`.

## Machine

One `machine Subscription` in module `subscription`, one instance per subscriber. `enum Status { Active, Offering, OfferUnknown, Offered, Cancelling, CancelUnknown, Cancelled, Retained, Stuck }`. State: `status` (`Active`), `offers : 0..1` (0). `terminal status in { Cancelled, Retained, Stuck }`.

- `Request()`: `"not-active"` unless `Active`. When `offers == 0`: sets `offers` to 1, goes to `Offering`, emits `offer()`. Otherwise goes to `Cancelling` and emits `cancel()`.
- `OfferSent()`: `"not-offering"` unless `Offering`. Goes to `Offered` and arms the timer `lapse` for 168h to fire `Lapse`. `OfferFailed()`: same guard; goes to `Cancelling` and emits `cancel()` (a failed offer does not block the subscriber).
- `Keep()`: `"not-offered"` unless `Offered`. Goes to `Retained`, cancels `lapse`.
- `Decline()`: `"not-offered"` unless `Offered`. Goes to `Cancelling`, cancels `lapse`, emits `cancel()`.
- `Lapse()`: `"not-offered"` unless `Offered`. Goes to `Cancelling` and emits `cancel()`.
- `Billed()`: `"not-cancelling"` unless `Cancelling`; goes to `Cancelled`. `BillFailed()`: same guard; billing refused the cancellation, so goes to `Stuck` (a person must cancel it).
- `OfferUncertain()`: `"not-offering"` unless `Offering`. The one attempt of the offer ended with no answer the program can trust: the subscriber may have the offer. Goes to `OfferUnknown`.
- `BillUncertain()`: `"not-cancelling"` unless `Cancelling`. The one attempt of the cancellation ended with no answer the program can trust: the subscription may be cancelled. Goes to `CancelUnknown`.
- `Resolve(done: bool)`: a person's reading of the marketing or the billing service. `"not-unknown"` unless `OfferUnknown` or `CancelUnknown`. From `OfferUnknown`: when `done`, goes to `Offered` and arms the timer `lapse` for 168h to fire `Lapse`, as `OfferSent` does; otherwise goes to `Cancelling` and emits `cancel()`, as `OfferFailed` does. From `CancelUnknown`: when `done`, goes to `Cancelled`; otherwise goes to `Stuck`. It never sends the offer or the cancellation again.

## Effects

Each has labels `egress:external`, class `irreversible`, retry `attempts 1, base 200ms, timeout 10s`, and the outcomes `ok`, `failed`, `exhausted`:

| Effect | Kind | Target (exact URL) | ok | failed | exhausted |
|---|---|---|---|---|---|
| `offer()` | `retention.offer` | `https://marketing.example/v1/offers` | `OfferSent` | `OfferFailed` | `OfferUncertain` |
| `cancel()` | `billing.cancel` | `https://billing.example/v1/subscriptions/cancel` | `Billed` | `BillFailed` | `BillUncertain` |

**Attempted once (G1, PS23.4; finding 31).** Neither the marketing nor the billing service documents an idempotency key, so neither call is retried: a retry whose first answer was lost could send the offer or the cancellation twice, which the check reports as `PL4003 UNGUARDED_RETRY` (PS23.5). With one attempt, `failed` is a refusal the service made and `exhausted` is an end the program cannot read, which goes to a person through `OfferUnknown` or `CancelUnknown` and `Resolve`.

## Host handlers and recorded services

`host/handlers.ts` exports `offer` and `cancel`, each `(payload, caps, ctx)`, with a type-only import from `../.poly/build/subscription.Subscription/types.js`. Each posts `{ subscription: ctx.instanceId }` through `caps.egress.post` to its URL with the header `idempotency-key` set to `ctx.idempotencyKey` (nothing documents that either service honours it, so the program does not rely on it). Status 200 or 201 returns `{ ok: true }`; a status from 400 to 499 other than 429 throws an error with `permanent: true`; any other status or a transport error throws an ordinary error, and since each effect has one attempt it ends `exhausted` and is not sent again.

`host/recorded.mjs` exports `recordedServices(script)`, where `script` maps a URL to a status or a list of statuses (the nth request to that URL gets the nth status, the last repeating; a URL not in the script gets 201). It returns `{ sent, transports }`: `sent` lists each request `{ url, body, headers }`, and `transports.egress` is the fake the runtime's `load` takes.

## Policy

Policy `retention`, scope `"subscription"`: two obligations, each `else deny` with `on unknown deny`, for `proposal.kind == "effect"`: `offer-while-offering` (`retention.offer` requires `machine("subscription.Subscription").status == Offering`) and `cancel-while-cancelling` (`billing.cancel` requires `status == Cancelling`). The policy is signed as a person signs it.

## Properties

1. **Path property `offer-at-most-once`**: `count("retention.offer") <= 1`.
2. **Path property `cancel-at-most-once`**: `count("billing.cancel") <= 1`.
3. **Liveness `request-ends`**: `status == Offering || status == Offered leads to status == Cancelled || status == Retained || status == Stuck under fair { OfferSent, OfferFailed, Lapse, Billed, BillFailed, Resolve }`. The subscriber's own actions (`Keep`, `Decline`) are not fair: nobody is assumed to act, and the lapse is what makes the request end when nobody does. `Resolve` is fair: the person who is told that an offer or a cancellation is unknown is assumed to look, as the timer is assumed to fire, and the fair set says so. The uncertain completions (`OfferUncertain`, `BillUncertain`) are not fair: nothing forces an answer to be lost.

The program and its policy check `CLEAN` over **9 states** (the 7 before finding 31, and `OfferUnknown` and `CancelUnknown`), with the liveness stage run and deadlock freedom.

## Seeded defect

`subscription-cancel-defect.poly` is the program whose `Decline` goes to `Offering` and emits `offer()`, in place of going to `Cancelling`: a subscriber who declines is offered again, without end. The check rejects it with exactly two codes. **`PL3301 LIVENESS_LASSO`** (`request-ends`), a lasso of **5 steps**: a prefix of one (`Request`) and a cycle of four (`OfferSent`, `Decline`, `OfferSent`, `Decline`, as the printer unrolls it). **`PL4001 PATH_PROPERTY`** (`offer-at-most-once`), a witness of **3 steps**: `Request`, `OfferSent`, `Decline`, the last emitting `retention.offer` a second time. The check of the defect copy beside the same policy gives the same findings.

## What the tests must show

Light test:

- the program with its policy is `CLEAN`, the liveness stage ran, and the instance is printed (9 states);
- the defect is `FINDINGS` with exactly `PL3301` and `PL4001`, each naming its property, the lasso of 5 steps and the path witness of 3;
- `poly check --host` is `CLEAN`, and a handler with a wrong field is `PL6836`;
- the handlers: 201 ok; 422 permanent; 503 not permanent; the header is the context's key and the body carries `ctx.instanceId`; a missing throw fails the test (a flag after the catch, not `assert.fail` inside the `try`);
- `recordedServices` answers by URL and call count, defaults to 201, and records requests.

End-to-end test, over recorded services, nothing on the network. Timers fire when the test advances the clock (`clock.advance(ms)` from `loadExample`) and settles; one settle carries a run to its end, so assert end states and requests:

- main path: `Request`, the offer is sent once, `Decline`, the cancellation is sent once with a key: `Cancelled`; exactly one request to each URL;
- keep: `Request`, the offer, `Keep`: `Retained`, no request to billing;
- lapse: `Request`, the offer, no reply, advance 168 hours: the cancellation goes ahead, `Cancelled`;
- refusal: a second `Request` on a subscription that is `Offered` is rejected `not-active`, and so is a `Keep` on an `Active` one `not-offered`; a failed offer (the marketing service answers 422) still cancels, with no second offer;
- one attempt, an unknown cancellation: a cancellation answered 503 then 201 sends exactly one request to billing and ends `CancelUnknown`; `Resolve(done: true)` ends `Cancelled` with no second request; on another subscription `Resolve(done: false)` ends `Stuck`; a `Resolve` on an `Offered` subscription is rejected `not-unknown`;
- one attempt, an unknown offer: an offer answered 503 then 201 sends exactly one request to marketing and ends `OfferUnknown`, with no request to billing; `Resolve(done: true)` ends `Offered`, and advancing 168 hours then cancels (`Cancelled`, one request to billing); on another subscription `Resolve(done: false)` cancels at once (`Cancelled`, one request to billing), with no second offer;
- two subscriptions' cancellations send different `idempotency-key` values;
- escalation to a person: a cancellation refused by billing (422) ends `Stuck`;
- the journal replays with no divergence (`replayRuntime`, `replaySessions`).

## Amendments made when the code existed

- **One settle carries a request through its offer.** After `Request` and a settle the subscription is `Offered` (the offer was sent in the same settle), not `Offering`; the writer's end-to-end file asserted the middle state (language findings 11) and dispatched `OfferFailed` by hand, which a test must not do. The failed-offer test now scripts the marketing service to answer 422 and asserts the end: `Cancelled` with the offer attempted once. The tests were corrected for this after the code existed.
- The defect's lasso is 5 steps and its path witness 3, as predicted; `Subscription` has 7 states in both programs.

## Amendment on v1.3.1 (finding 31)

v1.4 is built on v1.3.1, whose retry-safety rule (PS23.5) reports an irreversible effect that may be attempted more than once with no documented key as `PL4003`. The offer and the cancellation were `attempts 3`, with a key the handlers sent and no service documentation behind it, so the program and its defect copy were `FINDINGS` with `PL4003` twice beside their expected lines. The owner ruled: a target that documents an idempotency key is declared with its window; otherwise the effect is attempted once and an uncertain outcome goes to a person. Neither service documents a key, so both are `attempts 1`, and each `exhausted` now has its own completion. Before, an exhausted offer cancelled as if no offer had been made, and an exhausted cancellation ended `Stuck`, as if billing had refused it. Now each goes to an unknown state that a person leaves with `Resolve(done)`, and `Resolve` joins the fair set of `request-ends`. The defect copy changes in the same way. The expected lines and the defect's witnesses (the lasso of 5 steps, the path witness of 3) do not change: the new completions are not fair, and `Resolve` is enabled only in the unknown states, which the decline cycle never enters. The state count is 9.

**When the code existed (finding 31).** The state count is 9, as predicted, and the path witness is 3 steps. The lasso prediction was wrong: the check prints a lasso of **6 steps**, `Request`, `OfferSent`, `Decline`, `OfferUncertain`, `Resolve(done: true)`, `Decline`. The defect has that cycle too, since a declined subscription is offered again and that offer's answer can be lost every time, and the check's search reaches it first. The finding is still exactly `PL3301` and `PL4001`. The light test now asserts 6. Two end-to-end tests were corrected after the code existed: the recorded services answer by call count across the runtime, so a second subscription's one request is the second call, and the scripts are `503, 503, 201`.

## Conclusion

Liveness is what a retention flow owes the subscriber: whatever the service does, a request ends. The check finds the loop in five steps, and the one-line fix is what the property says: a decline cancels. What no check can say is that the offer is worth making.

## Glossary

- **Liveness:** a property that something eventually happens, under a stated fairness assumption.
- **Lasso:** a path that reaches a cycle it can repeat for ever; the counterexample to a liveness property.
- **Retention offer:** an offer made to a subscriber who asked to cancel.
- **Stuck:** a terminal state that waits for a person.
- **Unknown (offer or cancellation):** the one attempt ended with no answer the program can trust; a person says what happened.
