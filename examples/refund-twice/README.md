# Refund twice: one mistake, before and after

A support desk issues refunds through Stripe. A customer asks for the refund of an order, and it is issued. The customer writes again: "I still don't see it, please refund me." The second message is a new request with a new idempotency key, so Stripe's key does not stop it: the key covers the retries of one request, not a second request. A desk that keeps a ledger of refunds and does not consult it before paying pays the order twice.

This example shows that one mistake twice: in TypeScript, where the desk's own tests pass and it would merge, and in poly, where the rule is written once and `poly check` refuses the same mistake with the path that pays twice. The spec is `docs/examples/refund-twice.md` (S588).

## What it shows

### The before: TypeScript, and its tests pass

`before/refunds.ts` pays, then writes the ledger, and never reads the ledger first:

```ts
  // The message's id is the idempotency key, so a message delivered twice is paid once.
  const refund = await deps.stripe.refunds.create(
    { charge: order.charge, amount: order.amount },
    { idempotencyKey: request.messageId },
  );
  deps.ledger.set(order.id, refund.id);
  return { status: 'refunded', refundId: refund.id };
```

`before/refunds.test.ts` holds the tests its author wrote: a known order is refunded once for its amount, another customer's order is refused, the ledger holds the refund, and one message delivered twice pays once. `npm test` passes:

```
✔ a request for a known order of its customer issues one refund of its amount
✔ a request for another customer's order, or for no order, is refused and pays nothing
✔ the ledger holds the refund under the order
✔ the same message delivered twice pays once, since its key stops the second
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

### The bug

`before/twice.test.ts` is the test nobody wrote. The same customer asks for order 9011 in two messages. Stripe's stand-in records two calls, with two keys (`wamid.1`, `wamid.2`), each for the full 450. The test passes because it asserts the double payment: it is the record of the bug, not a test the desk should pass. `npm test` does not run it.

### The after: poly, and the check refuses it

`after/refunds.poly` is the same desk in poly, cut down from the concierge's Desk to the refund alone. One Desk is one order of one customer. The rule is written once, in the machine:

```poly
never no-reissue: emit refund while refund != None
```

The two files differ only in `on Ask` (and their leading comments). `after/refunds-unguarded.poly` makes the before's mistake, and pays every time:

```poly
  on Ask {
    refund' = Pending
    emit refund(amount)
  }
```

`after/refunds.poly` consults the refund it already asked for, and answers that it is on its way:

```poly
  on Ask {
    if refund == None {
      refund' = Pending
      reply' = Silent
      emit refund(amount)
    } else {
      reply' = Already
    }
  }
```

`poly check refunds-unguarded.poly` reports `FINDINGS`. It does not need a test of the second request: it explores every order of requests and completions, and prints the path that pays twice, a request that pays and a second request, while the first refund is still pending, that pays again:

```
refunds-unguarded.poly:40  PL3002 STEP_PROPERTY  no-reissue
  never no-reissue is violated by Ask
  witness (2 steps):
    Ask(0)   None/Silent    -> Pending/Silent   emits payments.refund
    Ask(0)   Pending/Silent -> Pending/Silent   emits payments.refund
```

It reports the same step a second time, as `PL4002 EMIT_WITHOUT_STATE_CHANGE` on `Ask`: the second request leaves the state as it was and pays, so nothing stops a third. That finding needs no rule at all.

`poly check refunds.poly`, the guarded desk, is `CLEAN`:

```
verdict: CLEAN (exit 0)  refunds.Desk  over Ask.amount ∈ 0..500 at {0} (S458); 8 states; kernel assumptions K7, K17
```

## Run it

The before needs Node 24, which runs the `.ts` files as they are:

```
cd examples/refund-twice/before
npm test                       # the author's tests: 4 pass
node --test twice.test.ts      # the test nobody wrote: it passes by showing two refunds
```

The after, from the repository's root after `npm run build`:

```
cd examples/refund-twice/after
node ../../../packages/poly-check/dist/src/cli.js check refunds-unguarded.poly   # FINDINGS: PL3002, PL4002
node ../../../packages/poly-check/dist/src/cli.js check refunds.poly             # CLEAN
```

## What is checked

- `no-reissue` holds in `refunds.poly` for every order of requests and completions (`Refunded`, `RefundFailed`, `RefundUnknown`) the Desk can take, and the check prints the instance it explored: `Ask.amount ∈ 0..500 at {0}`. The amount is explored at its cut, the one value the program compares it with (S458), since no rule reads it.
- The guarded desk reaches 8 states, and every step that emits `payments.refund` is checked against the rule. The rule is tested in that instance, not vacuous.
- The unguarded desk's findings come with their witnesses, which `poly witness <id> --trace` exports and replays.

## What is not checked

- **The before was written by hand** to show the mistake. It is not taken from an agent's run, and this example measures nothing. The comparison of poly and TypeScript on one prompt, under a pre-registration, is the [demo baseline](../../demo/baseline/README.md).
- A refund made outside the program, in Stripe's dashboard, is not seen by the Desk.
- Stripe's behaviour here is the stand-in's, in memory: it honours idempotency keys as Stripe documents them, and nothing reaches the network. The after names Stripe's address only as its effect's declared target, and `poly check` runs nothing.
- One Desk is one order. Two Desks for one order, or a refund split across orders, are outside this example; the concierge (`examples/concierge`) carries the rest.

## Conclusion

The before's tests are the ones its author would write, and they pass; the money goes out twice. The after states the rule once, and the check finds the second payment on its own, with the path, before anything runs. A rule an agent cannot see is a test it did not write; a rule in the program is checked whether or not anyone thought of the case.

## Glossary

- **Desk:** the machine that answers one customer's refund requests for one order.
- **Idempotency key:** the key Stripe uses to make the retries of one request one refund. It does not join two requests.
- **Before / after:** the TypeScript desk with the mistake, and the poly desk where the check refuses it.
- **Stand-in:** an in-memory Stripe that records each call and honours idempotency keys.
- **Witness:** the shortest path of steps the check found that breaks a rule.
- **Cut:** the values of a parameter the check explores, those the program compares it with (S458).
