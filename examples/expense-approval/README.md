# Expense approval

An employee submits an expense claim: an amount and a receipt. A typed decision reads the receipt and gives a category. A manager approves or declines, and an approved claim is paid through an irreversible, keyed payment. A payment above 200 euros waits for a second person, who approves it with a signed record. Everything here runs on recorded answers: no model is called and nothing leaves the machine. The spec is `docs/examples/expense-approval.md`.

## What it shows

- **A strict domain.** The amount is `int check 0..10`, in units of 50 euros. A value outside it is refused at dispatch with the reason `outside-check-domain`, before the handler runs.
- **Verified claims.** The submitter and the approver are principals from the host's verifier (`claims Employee`, `claims Approver`), never from an action's data.
- **A property about who.** The invariant `approver-not-submitter` says that an approver is never the submitter. `Approve` and `Decline` both refuse the submitter with `own-claim`.
- **Two different approvals.** A manager's `Approve` is a dispatch with claims. A payment above 200 euros is proposed to the gate, which escalates it, and only a person's signed record releases it (`approvalFor` and `rt.approve`). The manager's approval of the claim does not stand for it.
- **A keyed payment.** `payroll.pay` is irreversible and carries the intent's idempotency key. The path property `pay-at-most-once` holds.
- **A seeded defect.** `expense-approval-defect.poly` lets `Approve` skip the submitter check.

## Run it

From the repository root, after `npm ci` and `npm run build`:

```sh
node packages/poly-check/dist/src/cli.js check examples/expense-approval/expense-approval.poly
node packages/poly-check/dist/src/cli.js check examples/expense-approval/expense-approval-defect.poly
node packages/poly-check/dist/src/cli.js check examples/expense-approval/expense-approval.poly --root examples/expense-approval --host examples/expense-approval/host/tsconfig.json
node --test test/ex-expense-approval.test.mjs
node --test test/after/ex-expense-approval-e2e.test.mjs
```

The tests check the program with its policy beside it, as a project.

## What is checked

| Check | Result |
|---|---|
| Program with its policy | `CLEAN`; `Expense` over 1,231 states, 3 principal representatives, 2 content representatives; about 25 s |
| Policy | all seven stages `CLEAN` |
| Defect copy | `FINDINGS`, exactly `PL3001 INVARIANT_REACHABLE` (`approver-not-submitter`), witness of 3 steps: `Submit` by one principal, `Categorized`, `Approve` by the same principal; 1,711 states |
| Host handler | compiles under `poly check --host`; a wrong payload field is `PL6836` |
| End to end | 7 tests: main path, the submitter refused, an amount outside the domain refused, a blurry receipt left in `Other`, a payment above 200 euros escalated and released by a person, and a journal that replays (3 runs, 17 rows, 1 gate session, no divergence) |

## What is not checked

- **Who the principals are.** The check explores three representatives. That the verifier gives `alice` and `bob` distinct names is the host's.
- **Collusion.** Two people approving each other's claims is outside the property.
- **The finance person.** The gate checks that a signed record is a person's, not that the person is the right one.
- **The model.** The recorded answers stand in for it, with no calibration map.
- **Amounts in single euros.** Amounts are in units of 50 euros, `0..10`, not `0..500`: a stored `0..500` compared with two thresholds exhausted memory (3.3 GB, no verdict), because the check does not cut a stored value at its comparison constants. `CLEAN` is a statement about 11 amounts, 0 to 500 euros in steps of 50. See `docs/examples/language-findings.md`, item 3.

## Conclusion

The property is one comparison on the approving step, and the check finds its absence in three steps. The cost of the check was in the amount: a ranged field that a handler stores is not cut at its comparison constants, so a domain of 501 values made the check too large to finish, and the amount is in units of 50 euros, 11 values. What the check cannot see is who the principals are; the example shows that the verifier supplies them, and that a manager's approval of a claim and a person's approval of a payment are two different records.

## Glossary

- **Submitter / approver:** the principals, from verified claims, that submitted and approved a claim.
- **Escalation:** the gate's decision that a person must approve an intent before it runs.
- **Strict domain:** a `check` clause that refuses a value outside it at dispatch.
- **Unit:** 50 euros; the amount of a claim is a whole number of units.
- **Recorded answers:** a model's answers written down in advance, so a run needs no provider.
- **Witness:** the shortest sequence of steps that violates a property.
