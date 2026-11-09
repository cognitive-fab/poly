# Example spec: refund-twice

S588, from the plan `docs/proposals/guide-before-after.md`, approved by the owner on 2026-11-08 with its defaults: the example is `examples/refund-twice`, the before is TypeScript run by Node 24 with no build step, and the guide's text is `packages/poly-check/GUIDE.md`. Written before any test or code (rule 7a). The tests are written by someone who has read only this page and `poly guide` as built in PT14, so everything a test needs is on them.

## Purpose

One mistake, shown twice. A support desk issues refunds through Stripe. A customer asks for the refund of an order, it is issued, and the customer writes again. The second message is a new request with a new idempotency key, so Stripe's key does not stop it: the key covers the retries of one request, not a second request (S526). A program that keeps a ledger of refunds and does not consult it before paying pays the order twice.

The before is that program in TypeScript. Its own tests pass, so it would merge. The after is the same desk in poly, where the rule is written once and `poly check` refuses the same mistake with the path that pays twice.

The before was written by hand to show the mistake. It is not taken from an agent's run, and the example measures nothing: the demo baseline (`demo/baseline`) is where poly and TypeScript are compared on one prompt.

Nothing in the example reaches the network. The before's Stripe is a stand-in in memory. The after names Stripe's address as its effect's declared target, and `poly check` runs nothing: it reads the program and explores it.

## Files

```
examples/refund-twice/
  README.md
  before/
    package.json          "test": "node --test refunds.test.ts"
    refunds.ts            the desk
    stripe-stand-in.ts    a Stripe that records each call
    refunds.test.ts       the tests the desk's author wrote
    twice.test.ts         the test nobody wrote: the same order refunded twice
  after/
    refunds.poly          the desk in poly, guarded: CLEAN
    refunds-unguarded.poly the same mistake as the before: FINDINGS
```

## The before (`before/`)

TypeScript for Node 24, run by Node's type stripping: only syntax that erases (type annotations, `type` and `interface` declarations), imports written with their `.ts` extension, no `enum`, no namespace, no parameter property. No dependency: `package.json` has none, and no file imports anything but Node's built-ins and the example's own files.

- **`stripe-stand-in.ts`** exports `standInStripe()`, which returns `{ calls, refunds }`.
  - `calls` is an array, one entry per refund created: `{ charge: string, amount: number, idempotencyKey: string, id: string }`.
  - `refunds.create(params: { charge: string; amount: number }, options: { idempotencyKey: string })` returns a promise of `{ id: string, amount: number, status: 'succeeded' }`. A key it has seen returns the refund it made for that key and records no new call, as Stripe does. A new key makes a new refund, with a new `id` (`re_1`, `re_2`, ...), and records a call.
- **`refunds.ts`** exports:
  - `type Order = { id: string; customer: string; charge: string; amount: number }`;
  - `type Ledger = Map<string, string>` (order id to refund id);
  - `handleRefund(request: { customer: string; order: string; messageId: string }, deps: { orders: Order[]; stripe: <the stand-in's type>; ledger: Ledger }): Promise<{ status: 'refunded'; refundId: string } | { status: 'unknown-order' }>`.

  It finds the order by id and customer, and answers `unknown-order` when there is none. Otherwise it calls `stripe.refunds.create({ charge, amount }, { idempotencyKey: request.messageId })`, records `ledger.set(order.id, refund.id)` after the call, and answers `refunded` with the refund's id. **It never reads the ledger before the call.** That is the mistake. A comment at the top of the file says so, and that the file is kept that way on purpose.
- **`refunds.test.ts`** holds the tests such a desk's author writes and stops at, run by `npm test`:
  - a request for a known order of its customer issues one refund of the order's amount, through one call;
  - a request for an order of another customer, or for no order, answers `unknown-order` and calls nothing;
  - the ledger holds the refund's id under the order's id;
  - the same message delivered twice (one `messageId`) makes one call, since the key stops it.

  All pass.
- **`twice.test.ts`**, not run by `npm test`: the same customer asks for the same order in two messages (two `messageId`s). It asserts that the stand-in recorded **two** calls for that order, each for the full amount, with two keys, and that both answers are `refunded`. It passes, because it asserts the double payment: it is the record of the bug, not a test the desk should pass. A comment at its top says so.

## The after (`after/`)

Module `refunds`, one machine `Desk`, the concierge's Desk (`examples/concierge`, DF19) cut down to the refund alone. One Desk stands for one order of one customer.

- **State.** `refund : Refund = None`, with `enum Refund { None, Pending, Issued, Unknown }`; `reply : Reply = Silent`, with `enum Reply { Silent, Already }`.
- **Actions.** `Ask(amount: 0..500)`, the customer's request; `Refunded()`, `RefundFailed()` and `RefundUnknown()`, the refund's completions.
- **The rule, written once.** `never no-reissue: emit refund while refund != None`.
- **The effect.** `effect refund(amount: 0..500)` of kind `payments.refund`, `labels { egress:external }`, the target `https://api.stripe.com/v1/refunds`, `class irreversible`, `idempotent header "Idempotency-Key" window 24h`, with `ok -> Refunded()`, `failed -> RefundFailed()` and `exhausted -> RefundUnknown()`.
- **`refunds.poly`, guarded.** `on Ask`: if `refund == None`, then `refund' = Pending`, `reply' = Silent` and `emit refund(amount)`; otherwise `reply' = Already`, and nothing is paid. (`reply` is the answer to the latest request, so a request that pays sets it back to `Silent`.) `on Refunded`: `refund' = Issued`; `on RefundFailed`: `refund' = None`; `on RefundUnknown`: `refund' = Unknown`; each requires `refund == Pending` and rejects otherwise. `poly check` reports `CLEAN`, exit 0, and prints its checked instance (PT12.3a).
- **`refunds-unguarded.poly`, the same mistake as the before.** The same module, except that `on Ask` has no guard: it sets `refund' = Pending` and emits the refund every time, without consulting `refund`. `poly check` reports `FINDINGS`, exit 1, with:
  - `PL3002` on `no-reissue`, whose witness is a path of `Ask` steps of which at least two emit `payments.refund`: the second request pays again;
  - `PL4002` on `Ask`: the second request leaves the state unchanged and emits, so it can pay without limit (S33).

  The two files are the same text except for their leading comment block (every line before the first line that is neither blank nor a `//` comment) and the `on Ask` handler (from its `on Ask` line to the brace that closes it). No other comment differs, including one just above `on Ask`.

## The example's README

`examples/refund-twice/README.md`, in the house style. Its second-level headings include, as every example README's (`test/ex-readmes.test.mjs`), `## What it shows`, `## Run it`, `## What is checked`, `## What is not checked`, `## Conclusion` and `## Glossary`, with `## Glossary` last and `## Conclusion` before it. The contents below go under them: the scene, the before, the bug and the after under *What it shows*; how to run both under *Run it*; what the check covers under *What is checked*; what it does not, and the note that the before was written by hand, under *What is not checked*.

- It starts with the scene of the *Purpose* above.
- **The before.** The lines of `handleRefund` that call Stripe and then write the ledger, and the output of `npm test` passing.
- **The bug.** What `twice.test.ts` shows: two calls, two keys, one order.
- **The after.** The `never` line; `on Ask` of both files side by side; the `PL3002` diagnostic and its witness exactly as `poly check refunds-unguarded.poly` prints them today, in a fenced block that starts with the line naming `PL3002`; the `verdict:` line of `poly check refunds.poly`.
- It says the before was written by hand, and points to `demo/baseline` for the measured comparison.
- It says what the check covers: `no-reissue` holds for every order of requests and completions, with the amount explored at its cut (the instance `poly check` prints names it, `Ask.amount ∈ 0..500 at {0}`, S458), and the instance is printed. It says what it does not cover: a refund made outside the program (in Stripe's dashboard) is not seen, and Stripe's behaviour is the stand-in's.
- It says how to run both: `npm test` and `node --test twice.test.ts` in `before/`; `poly check` on each file of `after/`.

## poly's README

- The status line (`> Status: specification, draft v0.6 (after five reviews). No code yet.`) is replaced by one naming the current release, v1.6.0, and pointing to `docs/release-notes-v1.6.md`.
- A section `## Before and after`, before `## Hello, world`, says in a few sentences what the example shows and links to `examples/refund-twice/README.md`.
- The section `## Using poly with a coding agent` of `poly guide` as built (PT14).
- The examples index (`examples/README.md`) lists `refund-twice/`.

## What the tests must show

1. `npm test` in `before/` exits 0; the tests of `refunds.test.ts` all pass.
2. `twice.test.ts` passes, and the stand-in records two calls for one order with different keys and the full amount each.
3. No file of `before/` imports a module that reaches the network (`node:http`, `node:https`, `node:net`, `node:dgram`, `node:tls`) or calls `fetch`.
4. `poly check after/refunds.poly` reports `CLEAN` with exit 0 and prints its instance.
5. `poly check after/refunds-unguarded.poly` reports `FINDINGS` with exit 1, with `PL3002` naming `no-reissue` and a witness of `Ask` steps in which at least two emit `payments.refund`, and with `PL4002` on `Ask`.
6. The two `.poly` files are the same text except for their leading comment blocks and their `on Ask` handlers, as *The after* defines them.
7. The example's README holds the `PL3002` block exactly as `poly check refunds-unguarded.poly` prints it, run from `after/` (compared, so that a change to the check's output fails the test); the `verdict:` line exactly as `poly check refunds.poly` prints it, run from `after/`; the `never` line; the `on Ask` handler of each file as it is in the file; the words "written by hand"; a link to `demo/baseline`; the instance `Ask.amount ∈ 0..500 at {0}`; and the words "dashboard" and "stand-in" under `## What is not checked`. Its headings are those of *The example's README*.
8. poly's README holds the four lines of `poly guide` as built word for word, under `## Using poly with a coding agent`; has `## Before and after` before `## Hello, world`, linking to the example; no longer holds "No code yet"; and its status line names v1.6.0 and links to `docs/release-notes-v1.6.md`.
9. `examples/README.md` lists `refund-twice/`.
10. House style in every new text file: no em dash, and none of the words the house style bans.

## Acceptance criteria

- **RB1** The before's own tests pass and its twice test shows the double payment (tests 1 to 3).
- **RB2** The after's guarded desk is `CLEAN` and its unguarded desk is `FINDINGS` with `PL3002` on `no-reissue` (tests 4 to 6).
- **RB3** The READMEs show the two and say what is and is not claimed (tests 7 to 10).

## Amendment 1 (2026-11-08, before any code)

From the separate writer's report and the review of this page. The README's headings are those every example README has, which `test/ex-readmes.test.mjs` holds; the coverage sentence names the amount's cut; the files' sameness is defined to the character; `reply` is set back to `Silent` by a request that pays; nothing in the example reaches the network, the after only naming Stripe's address as a declared target; test 7 holds every content the README section asks for, and test 8 the status line. The guide's command needs its published schemas (`schemas/guide.input.json` and `schemas/guide.output.json`, made by `scripts/publish-schemas.mjs`) and a place in PT14's registry paragraph, as every registry command has.

## Conclusion

The example is small on purpose: one rule, one mistake, two languages. The before's tests are the ones its author would write, and they pass; the money goes out twice. The after states the rule once, and the check finds the second payment on its own, with the path, before anything runs.

## Glossary

- **Desk:** the machine that answers one customer's refund requests for one order.
- **Idempotency key:** a key Stripe uses to make the retries of one request one refund; it does not join two requests.
- **Before / after:** the TypeScript desk with the mistake, and the poly desk where the check refuses it.
- **Stand-in:** an in-memory Stripe that records each call and honours idempotency keys.
