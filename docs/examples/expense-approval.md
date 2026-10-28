# Example spec: expense-approval

Batch 1, example 2. Written before any test or code (rule 7a). The tests are written by someone who has read only this page, so everything a test needs is on it.

## Purpose

An employee submits an expense claim: an amount and a receipt. A typed decision reads the receipt and gives a category. A manager approves or declines the claim, and an approved claim is paid through an irreversible, keyed payment. A payment above 200 waits for a second person, finance, who approves it with a signed record. The point of the example is the property: **the approver of a claim is never its submitter**.

## Files

All paths are under `examples/expense-approval/`. The names below are fixed.

| File | Content |
|---|---|
| `expense-approval.poly` | module `expenses`, first line `// expected: CLEAN` |
| `expense-approval.policy.poly` | module `expenses_policy`, policy `payments`, scope `"expenses"` |
| `expense-approval-defect.poly` | the program with the submitter check removed, first line `// expected: FINDING PL3001` |
| `host/handlers.ts` | the certified handler file; exports `pay` |
| `host/tsconfig.json` | compiles `host/handlers.ts` for `poly check --host`; run with `--root examples/expense-approval` |
| `host/recorded.mjs` | exports `loadAnswers(file)`, `recordedExpenses(fixture)` and `provideRecorded(rt, recorded)` |
| `recorded/answers.json` | the recorded answers of the decision |
| `README.md` | what it shows, how to run it, what is checked, what is not, a conclusion, a glossary |

The tests are `test/ex-expense-approval.test.mjs` (light) and `test/after/ex-expense-approval-e2e.test.mjs` (admission and a run). The shared helper is `test/ex-kit.mjs`.

## Machine

One `machine Expense` in module `expenses`, one instance per claim. Claims types: `claims Employee { principal: Principal }` and `claims Approver { principal: Principal }`. Enums: `Category { Travel, Meals, Equipment, Other }` and `Status { Draft, Categorizing, Submitted, Paying, Settled, Declined, Failed, Held }`.

State: `status` (`Draft`), `submitter : Principal` (none), `approver : Principal` (none), `amount : 0..500` (0), `large : bool` (false), `category : Category` (`Other`). `terminal status in { Settled, Declined, Failed }`. `Held` is not terminal: it waits for a person (finding 31).

Actions and handlers:

- `Submit(amount: 0..500, receipt: Content) by s: Employee`: rejects `"not-draft"` unless `Draft`; rejects `"empty"` when the amount is 0. Records `submitter` from `s.principal`, the `amount`, and `large` as `amount > 200`. Goes to `Categorizing` and issues `decide categorize(receipt: receipt)`.
- `Categorized(category, conf: Conf, margin: Conf)`: rejects `"not-categorizing"` unless `Categorizing`. Records the category when `conf >= 0.8` and `Other` otherwise. Goes to `Submitted`.
- `Uncategorized()`: the decision failed. Rejects `"not-categorizing"` unless `Categorizing`. Goes to `Submitted` with `Other`.
- `Approve() by a: Approver`: rejects `"not-submitted"` unless `Submitted`; rejects `"own-claim"` when `a.principal == submitter`. Records `approver`, goes to `Paying` and emits `pay(amount: amount)`.
- `Decline() by a: Approver`: rejects `"not-submitted"` unless `Submitted`; rejects `"own-claim"` when `a.principal == submitter`. Goes to `Declined`.
- `Paid()`, `PayFailed()`, `PayHeld()`: each rejects `"not-paying"` unless `Paying`, and goes to `Settled`, `Failed` and `Held` respectively. `PayFailed` is a refusal the payroll service made (nothing was paid). `PayHeld` is the one attempt ending with no answer the program can trust: the claim may have been paid, so it is held for a person.
- `Resolve(paid: bool) by a: Approver`: a person's reading of the payroll service for a held claim. Rejects `"not-held"` unless `Held`; rejects `"own-claim"` when `a.principal == submitter`. When `paid`, goes to `Settled`; otherwise goes to `Failed`. It emits nothing: the person reports what happened, and the program does not pay again.

## Decision

`decision categorize(receipt: Content) -> Category`, provider `"small"`, labels `egress:external` and `read:private`, timeout 2s. `ok` dispatches `Categorized` with the answer, `r.conf` and `r.margin`. `failed` dispatches `Uncategorized`.

## Effect

`effect pay(amount: 0..500)`: kind `"payroll.pay"`, labels `egress:external`, target `egress` the exact URL `https://payroll.example/v1/reimbursements`, class `irreversible`, retry `attempts 1, base 200ms, timeout 10s`. Outcomes: `ok` to `Paid`, `failed` to `PayFailed`, `exhausted` to `PayHeld`.

**Attempted once (G1, PS23.4; finding 31).** The payroll service documents no idempotency key, so the payment is not retried: a retry whose first answer was lost could pay the claim twice, which the check reports as `PL4003 UNGUARDED_RETRY` (PS23.5). The handler still sends the intent's idempotency key (`ctx.idempotencyKey`) as the header `idempotency-key`; nothing documents that the service honours it, so the program does not rely on it.

## Host handler

`host/handlers.ts` exports `pay(payload, caps, ctx)`, with a type-only import from `../.poly/build/expenses.Expense/types.js`. It posts `{ amount }` through `caps.egress.post` to the payroll URL with the header `idempotency-key`. Status 200 or 201 returns `{ ok: true }`. A status from 400 to 499 other than 429 throws an error with `permanent: true`. Any other status, or a transport error, throws an ordinary error; the payment has one attempt, so it ends `exhausted` and is not sent again.

## Recorded provider

`recorded/answers.json` is `{ "models": { "small": "<id>" }, "receipts": [ { "id", "text", "answer", "distribution": [ [ category, p ], ... ], "usage" } ] }`. `recordedExpenses(fixture)` returns `{ asked, decisions: { categorize: { provider, model } } }`. The provider finds the receipt whose `text` is among the bodies the decision was given, records `{ decision, receipt: id }` in `asked`, and returns `{ answer, distribution, reported, latencyMs: 0 }`. A text the fixture does not hold throws.

| id | text | answer | distribution |
|---|---|---|---|
| `taxi` | "Taxi from the airport, 120 euros." | `Travel` | Travel 0.93, Other 0.07 |
| `laptop` | "Laptop stand and keyboard, 350 euros." | `Equipment` | Equipment 0.9, Other 0.1 |
| `blurry` | "Receipt photo, unreadable." | `Meals` | Meals 0.4, Travel 0.35, Other 0.25 |

## Policy

Policy `payments`, scope `"expenses"`: one obligation `large-payment-reviewed`, a rule that, for `proposal.kind == "effect" && effect.kind == "payroll.pay" && machine("expenses.Expense").large`, requires `false` and otherwise escalates, with `on unknown escalate`. A person approves with a signed record (`approvalFor` and `rt.approve`). The manager's `Approve` is a dispatch with claims; it is not the person's approval.

## Properties

1. **Invariant `approver-not-submitter`**: `approver != none implies approver != submitter`.
2. **Invariant `large-flag`**: `amount > 200 implies large`.
3. **Path property `pay-at-most-once`**: `count("payroll.pay") <= 1`.

The program and its policy together check `CLEAN`, including deadlock freedom (every non-terminal state has an accepting action).

## Seeded defect

`expense-approval-defect.poly` is the program with the `"own-claim"` requirement removed from `Approve` only (`Decline` keeps it): the same principal can approve its own claim. The check rejects it with exactly one code, `PL3001 INVARIANT_REACHABLE`, naming `approver-not-submitter`. The shortest witness has **3 steps**: `Submit` by one principal, `Categorized`, and `Approve` by the same principal. The check of the defect copy beside the same policy gives the same finding.

## What the tests must show

Light test (`test/ex-expense-approval.test.mjs`):

- the program, checked with its policy, is `CLEAN`, and the report prints the instance (the amount's cut points, the principals, the state count);
- the defect is `FINDINGS` with exactly `PL3001`, the invariant named, a witness of 3 steps whose last step is `Approve`;
- `poly check --host` is `CLEAN`, and a handler with a wrong payload field is `PL6836`;
- the handler: 201 returns ok; 422 throws with `permanent: true`; 503 throws without it; the header is the context's key and the body is the amount;
- the recorded provider answers each receipt and throws on an unknown text.

End-to-end test (`test/after/ex-expense-approval-e2e.test.mjs`), over recorded traffic, nothing on the network. Claims are given as `{ credentials: { principal: "<name>" } }` with the verifier `(c) => (c ? { principal: c.principal } : null)`:

- main path: `alice` submits 120 with the `taxi` receipt; the category is `Travel`; `bob` approves; one POST carrying a key; the claim is `Settled`;
- refusal: `alice` approving her own claim is rejected `own-claim` with no POST; an amount of 600 is rejected `outside-check-domain` before the handler; `blurry` leaves the category `Other`;
- escalation: `carol` submits 350 with `laptop`; `dave` approves; the payment is proposed and **escalated**, with no POST; a person's signed approval releases it, then one POST; the claim is `Settled`;
- one attempt and a held claim: with the payroll service scripted to answer 503 then 201, `alice` submits 120 and `bob` approves; exactly one POST is sent and the claim is `Held`; `Resolve(paid: true)` by `alice` is rejected `own-claim`; `Resolve(paid: true)` by `bob` ends `Settled` with no second POST; on a second held claim, `Resolve(paid: false)` by `bob` ends `Failed` with no second POST; a `Resolve` on a claim that is not held is rejected `not-held`;
- a refused payment: the payroll service answering 422 ends `Failed` after one POST;
- the journal replays with no divergence (`replayRuntime`, `replaySessions`).

## Amendments made when the code existed

- **The amount is in units of 50 euros, `0..10`, and `large` is `amount > 4`.** With `0..500` the check did not finish: a ranged value that a handler stores is not cut at its comparison constants (S458 cuts only parameters the state never keeps), so the field took all 501 values. At `0..10` the check takes about 25 s. Read every amount above as units: 120 euros is 3 (150 euros), 350 euros is 7, 600 euros is 12 and outside the domain. The receipts say 150 and 350 euros.
- **The strict domain is a check clause.** `Submit(amount: int check 0..10, ...)`: a range type refuses an outside value as a dispatch that is no step (S140, a thrown `RefusedDispatch`), where a `check` clause gives the journaled rejection `outside-check-domain` the e2e test asserts. The state field is `cost` and the `Categorized` parameter is `picked`, since a parameter named after a field is a warning (S19).
- The handler posts `{ euros: amount * 50 }`.
- The program declares `audience { public < staff }` (S302, as in the booker), and the policy holds a second obligation, `categorize-while-categorizing`, naming `decision.categorize` (PL7001, as in the booker).
- The recorded answers are read from `examples/expense-approval/recorded/answers.json`. Test assertions about amounts and the POST body were changed to match after the code existed.

## Amendment on v1.3.1 (finding 31)

v1.4 is built on v1.3.1, whose retry-safety rule (PS23.5) reports an irreversible effect that may be attempted more than once with no documented key as `PL4003`. The payment was `attempts 3`, with a key the handler sent and no service documentation behind it, so the program and its defect copy were `FINDINGS` with `PL4003` beside their expected lines. The owner ruled: a target that documents an idempotency key is declared with its window; otherwise the effect is attempted once and an uncertain outcome goes to a person. The payroll service documents no key, so the payment is `attempts 1`. Its uncertain outcome already went to `Held`, but `Held` was terminal, so nobody could act on it: it is now a state a person leaves with `Resolve(paid)`, signed with an approver's claims and never the submitter's. The defect copy changes in the same way. The expected lines, the defect's witness (3 steps) and the properties do not change; the state count does, and the README records it.

## Conclusion

The property is one comparison on the approving step, and the check finds its absence in three steps. What the check cannot see is who the principals are; the example shows that the verifier supplies them, and that a manager's approval of a claim and a person's approval of a payment are two different records.

## Glossary

- **Submitter / approver:** the principals, from verified claims, that submitted and approved a claim.
- **Escalation:** the gate's decision that a person must approve an intent before it runs.
- **Strict domain:** an amount outside 0..500 is refused at dispatch.
- **Held:** a claim whose one payment attempt ended with no answer the program can trust; a person says whether it was paid.
