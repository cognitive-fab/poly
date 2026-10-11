# The concierge

A small business answers its customers on WhatsApp. This is the program that does it, checked, with the policy that governs it and the host code that runs it. It is poly v1's release example (AC15, AC18, AC22, AC27, AC30). Everything here runs on recorded traffic: no message is a real customer's, no model is called, and nothing leaves the machine.

## What it does

- **Two channels.** Customers write on WhatsApp, and the staff are told on Slack. A WhatsApp thread has one customer, whose identity comes from the provider's verified claims and never from the message (S450). The staff channel answers each staff message with a short acknowledgement and approves nothing: an approval is a person's signed record, not a message.
- **One message at a time.** The `Desk` of a thread works on one message. A message that arrives meanwhile is acknowledged with a short reply, so every message is answered.
- **A routed decision classifies each message.** The small model answers first, and the large one when the calibrated answer is unsure. A message is a refund, a status question or something else.
- **A status question** retrieves the asking customer's orders from Postgres, and only theirs. A decision answers from them and cites the orders it used, and the reply goes to that customer.
- **A refund** retrieves the customer's orders too. A typed decision reads the message and the orders, and gives the amount, a record of one field with the strict domain 0 to 500, and cites the one order the message is about. The refund then acts on that order alone. Its handler reads the order, refuses unless the order is the requesting customer's, reads the order's charge from Stripe and refuses an amount above what was paid, and only then refunds that charge, through the merchant's Stripe grant. The program never holds the merchant: it is the grant's subject.
- **Above 100, a person decides.** The policy escalates a refund above 100. The host tells the staff's Slack thread, by intent and with nothing of the customer, and a person approves with a signed record. Two more rules deny a model call whose input is above the audience it answers: customers' decisions take nothing above the customer audience, and the staff's nothing above the staff's.

## What the check proves

The project, the program with its policy, is `CLEAN`. It was checked in 91 to 176 s in its own process, in at most 2.3 GB, and these are its counts:

| Machine or configuration | States | Transitions |
|---|---|---|
| `Desk` | 2,114 | 112,042 |
| `Notice` | 28 | 420 |
| WhatsApp conversation, Slack conversation | 342, 666 | 16,074, 41,958 |
| Stripe grant, route, budget | 13, 6, 96 | 104, 36, 2,976 |
| the `support` configuration | 29,379 global states | |
| the `staff` configuration | 3,620 global states | |

All seven stages of the policy are `CLEAN`: its types, its lowering, its consistency, its admission by the gate engine, the agreement of the lowered policy with the semantics over 118 proposals, the regions of polycheck (every path from a model call to the outside crosses a gate) and its `never` statements (there are none).

**The refund guard.** The program emits the refund only when the answer cites exactly one order, and it guards the emit with an `if`, answering Unsure otherwise. A `require` there checks `CLEAN` as well, yet a rejected completion leaves the `Desk` waiting for ever, because at run time a decision gives one completion and a rejected one consumes it. The machine check cannot see that, since it offers a decision's completions as free inputs; the generated configuration can, and reports a rejected completion of the program's own decision or effect as `PL5409` (S463). The concierge has none, and `test/ex-concierge-liveness.test.mjs` shows both sides: the `require` copy gets `PL5409` with a witness ending in the rejected `Amounted`, and the `if` copy does not. A liveness property of the `Desk` assumes that no such completion is rejected, so the absence of `PL5409` is what would discharge it. The concierge declares no liveness property of its own.

**End to end.** AC27 runs the program on recorded traffic: a status question answered with the customer's own order cited; a refund of 40 that the small model is unsure of and the large one answers, issued through the grant; a refund of 250 that is escalated, noticed to the staff and approved by a person. The program is `CLEAN` with its instance printed, and the journal replays every post-state, gate decision and tier choice: 36 runs and 231 rows, one of them the grant's, and 4 gate sessions with 43 proposals, with no divergence.

## Check it yourself

From the repository root, after `npm ci` and `npm run build`. Each of these takes minutes and wants a large heap, which is why they are in the serial group and not beside the rest of the suite.

```sh
node --max-old-space-size=8192 packages/poly-check/dist/src/cli.js check examples/concierge/concierge.poly
node --max-old-space-size=8192 --test --test-concurrency=1 test/after/serial-sources.test.mjs
node --max-old-space-size=8192 --test --test-concurrency=1 test/after/ex-concierge-e2e.test.mjs
```

The first checks the program alone, with its maps and prices beside it. The second checks the project with its policy beside it, and the program's translation validation. The third is AC27. The light tests, which check nothing heavy, are `test/ex-concierge-host.test.mjs` (the recorded providers), `test/ex-concierge-refund.test.mjs` (the refund path and the handler), `test/ex-concierge-policy.test.mjs` (the policy denies what it says) and `test/ex-concierge-liveness.test.mjs`.

## What is recorded and where

`test/fixtures/concierge/answers.json` holds the recorded model answers for seven made-up messages, with the orders and the charges they were paid with; its `PROVENANCE.md` says how each number was chosen. The host code is in `host/`: the recorded providers (`recorded.mjs`), the refund handler (`refund.mjs`) and the notice to the staff (`notice.mjs`). The price tables and calibration maps beside the program are the tests' own, not a provider's.

## Stated limits

- **The template retry is dropped.** A reply refused outside WhatsApp's window ends its exchange, and the customer's next message opens the window again. Sending a template message to reopen it is not in v1.
- **The owner refusal is shown at the handler.** The refund's handler refuses an order that is not the requesting customer's, and a test shows it. At run time the retrieval by owner stops another customer's order before it reaches the handler, so no run-time case exists to show.
- **The amount refusal reads the charge and refunds nothing.** A refund above what was paid is refused after one read of the charge. No refund is sent, and the one read is expected.
- **The amount decision's confidence is uncalibrated** until its map is fitted on adjudicated outcomes. The maps here are the tests' own.
- **Stripe's request shapes** are as its documentation gave them when the handler was written. Confirm them before a live run.
- **The check's bounds are the program's instance.** `CLEAN` is a statement about the instance printed with it, not about all customers at once.

## Conclusion

The concierge shows the four surfaces of v1 in one program: channels with verified customers, credentials that no program holds, memory that keeps one customer's orders from another, and routed decisions under a budget. It is checked `CLEAN` with its policy, and its journal replays on recorded traffic. What it cannot show is a live provider: those runs are the owner's.

## Glossary

- **Audience:** the class of reader a piece of data may reach; a model call is denied when its input is above the audience of the answer.
- **Charge:** the payment an order was paid with; a refund names one.
- **Desk:** the machine that works one customer's thread.
- **Escalation:** the gate's decision that a person must approve an intent before it runs.
- **Generated configuration:** the checked model of a channel's application with its conversation and its pending intents.
- **Grant:** the one authorisation of a credential, requested by a person's signed record and revocable.
- **Item set:** the orders a retrieval returned, passed to a decision or an effect and never stored.
- **Liveness assumption:** that every completion of the program's own intents is accepted, which the check of the configuration discharges.
- **Recorded traffic:** answers written down in advance, so that a run needs no provider.
- **Serial group:** the checks that run one at a time, apart from the rest of the suite.
