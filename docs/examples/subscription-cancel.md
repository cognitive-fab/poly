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

One `machine Subscription` in module `subscription`, one instance per subscriber. `enum Status { Active, Offering, Offered, Cancelling, Cancelled, Retained, Stuck }`. State: `status` (`Active`), `offers : 0..1` (0). `terminal status in { Cancelled, Retained, Stuck }`.

- `Request()`: `"not-active"` unless `Active`. When `offers == 0`: sets `offers` to 1, goes to `Offering`, emits `offer()`. Otherwise goes to `Cancelling` and emits `cancel()`.
- `OfferSent()`: `"not-offering"` unless `Offering`. Goes to `Offered` and arms the timer `lapse` for 168h to fire `Lapse`. `OfferFailed()`: same guard; goes to `Cancelling` and emits `cancel()` (a failed offer does not block the subscriber).
- `Keep()`: `"not-offered"` unless `Offered`. Goes to `Retained`, cancels `lapse`.
- `Decline()`: `"not-offered"` unless `Offered`. Goes to `Cancelling`, cancels `lapse`, emits `cancel()`.
- `Lapse()`: `"not-offered"` unless `Offered`. Goes to `Cancelling` and emits `cancel()`.
- `Billed()`: `"not-cancelling"` unless `Cancelling`; goes to `Cancelled`. `BillFailed()`: same guard; goes to `Stuck` (a person must cancel it).

## Effects

Each has labels `egress:external`, class `irreversible`, retry `attempts 3, base 200ms, timeout 10s`, and the outcomes `ok`, `failed`, `exhausted`:

| Effect | Kind | Target (exact URL) | ok | failed and exhausted |
|---|---|---|---|---|
| `offer()` | `retention.offer` | `https://marketing.example/v1/offers` | `OfferSent` | `OfferFailed` |
| `cancel()` | `billing.cancel` | `https://billing.example/v1/subscriptions/cancel` | `Billed` | `BillFailed` |

## Host handlers and recorded services

`host/handlers.ts` exports `offer` and `cancel`, each `(payload, caps, ctx)`, with a type-only import from `../.poly/build/subscription.Subscription/types.js`. Each posts `{ subscription: ctx.instanceId }` through `caps.egress.post` to its URL with the header `idempotency-key` set to `ctx.idempotencyKey`. Status 200 or 201 returns `{ ok: true }`; a status from 400 to 499 other than 429 throws an error with `permanent: true`; any other status or a transport error throws an ordinary error and is retried.

`host/recorded.mjs` exports `recordedServices(script)`, where `script` maps a URL to a status or a list of statuses (the nth request to that URL gets the nth status, the last repeating; a URL not in the script gets 201). It returns `{ sent, transports }`: `sent` lists each request `{ url, body, headers }`, and `transports.egress` is the fake the runtime's `load` takes.

## Policy

Policy `retention`, scope `"subscription"`: two obligations, each `else deny` with `on unknown deny`, for `proposal.kind == "effect"`: `offer-while-offering` (`retention.offer` requires `machine("subscription.Subscription").status == Offering`) and `cancel-while-cancelling` (`billing.cancel` requires `status == Cancelling`). The policy is signed as a person signs it.

## Properties

1. **Path property `offer-at-most-once`**: `count("retention.offer") <= 1`.
2. **Path property `cancel-at-most-once`**: `count("billing.cancel") <= 1`.
3. **Liveness `request-ends`**: `status == Offering || status == Offered leads to status == Cancelled || status == Retained || status == Stuck under fair { OfferSent, OfferFailed, Lapse, Billed, BillFailed }`. The subscriber's own actions (`Keep`, `Decline`) are not fair: nobody is assumed to act, and the lapse is what makes the request end when nobody does.

The program and its policy check `CLEAN` over **7 states**, with the liveness stage run and deadlock freedom.

## Seeded defect

`subscription-cancel-defect.poly` is the program whose `Decline` goes to `Offering` and emits `offer()`, in place of going to `Cancelling`: a subscriber who declines is offered again, without end. The check rejects it with exactly two codes. **`PL3301 LIVENESS_LASSO`** (`request-ends`), a lasso of **5 steps**: a prefix of one (`Request`) and a cycle of four (`OfferSent`, `Decline`, `OfferSent`, `Decline`, as the printer unrolls it). **`PL4001 PATH_PROPERTY`** (`offer-at-most-once`), a witness of **3 steps**: `Request`, `OfferSent`, `Decline`, the last emitting `retention.offer` a second time. The check of the defect copy beside the same policy gives the same findings.

## What the tests must show

Light test:

- the program with its policy is `CLEAN`, the liveness stage ran, and the instance is printed (7 states);
- the defect is `FINDINGS` with exactly `PL3301` and `PL4001`, each naming its property, the lasso of 5 steps and the path witness of 3;
- `poly check --host` is `CLEAN`, and a handler with a wrong field is `PL6836`;
- the handlers: 201 ok; 422 permanent; 503 not permanent; the header is the context's key and the body carries `ctx.instanceId`; a missing throw fails the test (a flag after the catch, not `assert.fail` inside the `try`);
- `recordedServices` answers by URL and call count, defaults to 201, and records requests.

End-to-end test, over recorded services, nothing on the network. Timers fire when the test advances the clock (`clock.advance(ms)` from `loadExample`) and settles; one settle carries a run to its end, so assert end states and requests:

- main path: `Request`, the offer is sent once, `Decline`, the cancellation is sent once with a key: `Cancelled`; exactly one request to each URL;
- keep: `Request`, the offer, `Keep`: `Retained`, no request to billing;
- lapse: `Request`, the offer, no reply, advance 168 hours: the cancellation goes ahead, `Cancelled`;
- refusal: a second `Request` on a subscription that is `Offered` is rejected `not-active`, and so is a `Keep` on an `Active` one `not-offered`; a failed offer (the marketing service answers 422) still cancels, with no second offer;
- keyed: a cancellation answered 503 then 201 sends two requests with the same `idempotency-key`; two subscriptions' cancellations send different keys;
- escalation to a person: a cancellation refused by billing (422) ends `Stuck`;
- the journal replays with no divergence (`replayRuntime`, `replaySessions`).

## Amendments made when the code existed

- **One settle carries a request through its offer.** After `Request` and a settle the subscription is `Offered` (the offer was sent in the same settle), not `Offering`; the writer's end-to-end file asserted the middle state (language findings 11) and dispatched `OfferFailed` by hand, which a test must not do. The failed-offer test now scripts the marketing service to answer 422 and asserts the end: `Cancelled` with the offer attempted once. The tests were corrected for this after the code existed.
- The defect's lasso is 5 steps and its path witness 3, as predicted; `Subscription` has 7 states in both programs.

## Conclusion

Liveness is what a retention flow owes the subscriber: whatever the service does, a request ends. The check finds the loop in five steps, and the one-line fix is what the property says: a decline cancels. What no check can say is that the offer is worth making.

## Glossary

- **Liveness:** a property that something eventually happens, under a stated fairness assumption.
- **Lasso:** a path that reaches a cycle it can repeat for ever; the counterexample to a liveness property.
- **Retention offer:** an offer made to a subscriber who asked to cancel.
- **Stuck:** a terminal state that waits for a person.
