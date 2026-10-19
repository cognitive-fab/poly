# Act 1: the same prompt, two builds

This is the script of Act 1. It has three parts: the experiment, the difference, and an illustration. The first two parts are records. The third is a chosen scenario, and the screen says so.

## Part 1: The experiment

Both agents got the same prompt. Both built a WhatsApp refund agent that talks to Stripe. The replay drives each kept build in an offline container against a Stripe stand-in. The stand-in applies the first refund request and loses the answer, so the build must retry.

Both kept builds refund once under the lost answer. The retry of each carried the same idempotency key, and the stand-in replayed its first response. Both chose an idempotency key. Nothing in the prompt asked for one.

| Build | Refund objects after the lost answer | Retry | Outcome |
|---|---|---|---|
| `ts-kept` (TypeScript) | 1 | same key, replayed | O2, refunds once |
| `poly-kept` (poly) | 1 | same key, replayed | O2, refunds once |

Both refund the wrong amount (observation A1). The customer asked for 40.00 of a 100.00 order. `ts-kept` refunded 100.00, the whole order. `poly-kept` refunded 60.00, the blender, because it read "blender" in the request as an item. The checker does not cover the amount. In the poly build the machine carries which lines are refunded, and `poly check` checks, over its finite model, that no line is refunded twice. The amount is computed in a JavaScript handler, outside the machine. What `poly check` says is about repetition, not about how much.

The records are `docs/demo/step10-replay.md` and `docs/demo/step10-replay/`.

## Part 2: The difference

In TypeScript, the key is a choice that nothing enforces. In poly, the build is not admitted without the key.

**Mutation (b): `ts-kept` without the `Idempotency-Key` header.** One line is removed from `src/stripe.ts`. Its own `npm test` still mostly passes: 18 of 20 pass, and 2 fail. Nothing else notices. The build starts, listens and answers. The key was a choice, and the choice can be undone by one line.

**Mutation (a): `poly-kept` without `idempotent header "Idempotency-Key" window 24h`.** One line is removed from the effect `stripe.refund`. `poly check src/support.poly` answers `FINDINGS`, with `PL4003 UNGUARDED_RETRY refund`. The summary line reads `retry-safe stripe.refund irreversible, attempts 3, none`. The witness has three steps:

```
Open(1)          New -> Idle
RequestAll(true) Idle -> Confirming                  emits whatsapp.ticket
Confirm()        Confirming -> Refunding             emits stripe.refund
delivery on runtime3.OutboxIntent: Propose, GateAllow, Start (target may execute), HandlerFailed,
  Start (target may execute), HandlerOk, SettleOk
executions of the target: 2, idempotency key: unchanged, deduplication declared: none
```

The delivery part is the defect: the target may execute twice. The runtime does not admit the build. On start it stops with `not admitted: the verdict is FINDINGS, and support.Ticket PL4003 refund (witness 2de37158e45d) has no signed acceptance (PT12.5)`. No customer can reach it.

The full check output is `docs/demo/step10-replay/mutations/poly-kept-nokey.check.txt`. Both mutations were made on copies. No committed tree was edited.

## Part 3: The illustration (a chosen scenario, not part of the experiment)

The experiment's request was 40.00 of a 100.00 order. Under that request the unkeyed TypeScript build did not refund twice. It refunded the whole order (A1), and Stripe refuses a second refund of a charge refunded in full. The key was not what saved it. To show what the key is for, the request is changed to one where Stripe has no reason to reject the second refund. This is a scenario chosen for the screen. It is not a pre-registered request and it is not a result of the experiment.

The order `ORD-1001` is 100.00: `BLENDER-1` at 60.00 and `CUPS-4` at 40.00. The request names the order and one item:

- "Please refund CUPS-4 from order ORD-1001." (40.00). After a first refund of 40.00, 60.00 remains, so a second refund of 40.00 is valid.
- "Please refund BLENDER-1 from order ORD-1001." (60.00). After a first refund of 60.00, 40.00 remains, so a second refund of 60.00 is invalid. Stripe rejects it on its own.

The bare sentence "refund the blender" did not work. `ts-kept` answered with the list of orders and asked for an order number. `poly-kept` also made no refund. A build needs the order and the item to be named.

Each run is the control (no fault) and then the fault run (the first refund is applied, the answer is lost), in the offline container, on a copy of the tree. What the stand-in saw:

| Request | Tree | POSTs in the fault run | Refund objects | Refunded | Outcome |
|---|---|---|---|---|---|
| `CUPS-4` | `ts-kept` | 200 with key, then 200 replayed (same key) | 1 | 40.00 of 100.00 | O2 |
| `CUPS-4` | `ts-kept` without the key | 200 with no key, then 200 with no key | **2** | **80.00** of 100.00 | **O1** |
| `CUPS-4` | `poly-kept` | 200 with key, then 200 replayed (same key) | 1 | 40.00 of 100.00 | O2 |
| `CUPS-4` | `poly-kept` without the key | none: the build is not admitted | 0 | 0.00 | O3 |
| `BLENDER-1` | `ts-kept` | 200 with key, then 200 replayed (same key) | 1 | 60.00 of 100.00 | O2 |
| `BLENDER-1` | `ts-kept` without the key | 200 with no key, then 400 with no key | 1 | 60.00 of 100.00 | O2 |
| `BLENDER-1` | `poly-kept` | 200 with key, then 200 replayed (same key) | 1 | 60.00 of 100.00 | O2 |
| `BLENDER-1` | `poly-kept` without the key | none: the build is not admitted | 0 | 0.00 | O3 |

For `CUPS-4`, the unkeyed TypeScript build refunds the customer twice. The stand-in recorded two refund objects (`re_standin_0001` and `re_standin_0002`) and 80.00 refunded on a charge of 100.00, for a request of 40.00. The customer was told: "Done! Your refund of $40.00 for ORD-1001 has been issued (ref re_standin_0002)." The build did not know.

For `BLENDER-1`, the unkeyed build is saved by Stripe's own limit, not by anything it did. The second request returned 400, and the customer was told that the refund was flagged for the support team, after the refund had gone through.

The unkeyed poly build was never driven. In the control it exits with `AdmitError` before it listens, so the stand-in saw no request at all. The check, which finds the defect with no corpus and no run, is what stopped it.

The records are in `docs/demo/step10-replay/illustration/`, one file per tree and request. The driver is `demo/demo.mjs replay` with `--request-text` and `--request-amount` (DB6 item 10).

## What Act 1 proves, and what it does not

It proves that two builds from the same prompt both chose a key, and that in poly the choice is enforced by the toolchain and in TypeScript it is not. It shows that removing the key from the TypeScript build produces a double refund when the request lets Stripe accept the second refund. It does not prove that an agent will omit the key: in this experiment neither did. It does not show that poly checks the amount: it does not. It does not generalise beyond one prompt, two kept builds and one fault.

## Conclusion

The experiment found no difference in what the two builds did: both kept builds refund once, and both refund the wrong amount. The difference is in what holds the key in place. In TypeScript, one removed line leaves a build that starts, answers, and, when the request allows it, refunds a customer twice. In poly, the same removal is a finding with a witness, and the build is not admitted. The checker is silent on the amount, and the script says so.

## Glossary

- **Idempotency key:** a value sent with a request so that the target treats a repeat of the request as the same request. Here the header `Idempotency-Key`.
- **Lost answer:** the fault of the replay. The first refund request is applied by the target and its answer never reaches the build, so the build retries.
- **Kept build:** the build kept as the result of the run of an arm (`ts-kept`, `poly-kept`). A pilot is not a kept build.
- **Stand-in:** the local program that plays Stripe in the replay. It records every request and every refund object.
- **O1, O2, O3:** the outcomes of the replay. O1 is a second refund. O2 is one refund. O3 is a build that could not be driven.
- **A1:** the observation that the builds refund an amount other than the one asked.
- **Mutation:** a copy of a kept build with one line removed.
- **`PL4003`:** an irreversible effect may be retried with no guarantee that the target runs it once.
- **Witness:** the steps, listed by the checker, by which a property is broken.
- **Admitted:** accepted by the runtime at start. A build with an unaccepted finding is not admitted.
