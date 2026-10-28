# Order fulfilment

An order is fulfilled by a saga of three steps: reserve the stock, charge the customer, ship the goods. A failed charge gives the stock back, and a failed shipment gives the stock back and refunds the charge. The shipment and the refund are attempted once, and an answer the program cannot read goes to a person. The example calls no model, so what is recorded is the answers of the payment and carrier services; nothing leaves the machine. The spec is `docs/examples/order-fulfilment.md`.

## What it shows

- **A saga with compensations.** `ChargeFailed` releases the stock. `ShipFailed` releases the stock and refunds the charge. A refund that fails leaves the order `Stuck`, still charged, for a person. A shipment or a refund whose one attempt ends with no answer the program can trust goes to `ShipUnknown` or `RefundUnknown`, and a person's `Resolve(done)` says which, running the compensations only for a shipment that did not happen.
- **An invariant on the compensation.** `cancelled-holds-nothing`: a cancelled order holds no stock and no charge. `done-is-charged` and the path properties `charge-at-most-once` and `refund-needs-charge` hold too.
- **A configuration.** Two orders share one stock in `two-orders`, with messages in any order within a transit bound of 4. The invariant `never-oversold` says the orders hold no more units than the stock began with, and the stock is never negative by its range.
- **One attempt for what cannot be undone (finding 31).** The carrier and the payment service document no idempotency key, so the irreversible shipment and refund are `retry { attempts 1 }`: a retry whose first answer was lost could ship or refund twice, which v1.3's retry-safety rule reports as `PL4003`. The charge is `compensable`, which that rule does not cover, and keeps three attempts. The handlers send the intent's idempotency key, the same on every attempt of one intent and different for different orders; no service documents that it honours the key, so nothing relies on it.
- **A seeded defect.** `order-fulfilment-defect.poly` sends a failed shipment straight to `Cancelled`, with no release and no refund.

## Run it

From the repository root, after `npm ci` and `npm run build`:

```sh
node packages/poly-check/dist/src/cli.js check examples/order-fulfilment/order-fulfilment.poly
node packages/poly-check/dist/src/cli.js check examples/order-fulfilment/order-fulfilment-defect.poly
node packages/poly-check/dist/src/cli.js check examples/order-fulfilment/order-fulfilment.poly --root examples/order-fulfilment --host examples/order-fulfilment/host/tsconfig.json
node --test test/ex-order-fulfilment.test.mjs
node --test test/after/ex-order-fulfilment-e2e.test.mjs
```

The tests check the program with its policy beside it, as a project.

## What is checked

| Check | Result |
|---|---|
| Program with its policy | `CLEAN`; `Stock` 2 states, `Order` 21 states; the configuration `two-orders` 180 global states; about 1 s |
| Policy | all seven stages `CLEAN` |
| Defect copy | `FINDINGS`, exactly `PL3001 INVARIANT_REACHABLE` (`cancelled-holds-nothing`), a witness of 4 steps: `Place`, `Reserved`, `Charged`, `ShipFailed`; `Order` 23 states, the configuration 196 global states |
| Host handlers | compile under `poly check --host`; a wrong body field is `PL6836` |
| End to end | 13 tests: admission, main path, an order refused for lack of stock, a declined charge, a refused shipment that is compensated, an unknown shipment resolved either way, a refused refund ending `Stuck`, an unknown refund resolved either way, a `Resolve` refused on an order that is not unknown, the charge's keyed retries, and a journal that replays (4 runs, 19 rows, 1 gate session, no divergence) |

## What is not checked

- **A larger world.** The configuration has one unit of stock, two orders and a transit bound of 4. `CLEAN` is a statement about that instance; three orders or two units were not tried. Nothing else was reduced.
- **The leak in the defect.** The configuration still checks `CLEAN` on the defect: one unit and two orders cannot be oversold even when the unit is never given back. The leak is the machine invariant's to find, which it does.
- **The services.** That a refund reached the customer is the payment service's. No service documents that it dedupes on the key.
- **The charge.** It is `compensable` and keeps three attempts with an undocumented key, so a lost answer can still charge twice, and an exhausted charge still cancels the order as if nothing was taken. v1.3's retry-safety rule covers irreversible effects only (finding 31). The end-to-end test shows what the program asks for, on recorded answers.
- **Settlement of the whole saga.** There is no liveness property: that every order ends `Done`, `Cancelled`, `Rejected` or `Stuck` is the deadlock check's (a non-terminal state with no accepting action), not a fairness argument.

## Conclusion

The compensation is the thing a saga is for, and the check finds its absence on the machine in four steps. The configuration shows that the stock cannot be oversold, and, by checking the defect `CLEAN`, shows what it does not see. The checks here take about a second each.

## Glossary

- **Saga:** a sequence of steps each with a compensation that undoes it.
- **Compensation:** the step that gives back what an earlier step took.
- **Keyed:** a request that carries the intent's idempotency key.
- **Stuck:** a terminal state that waits for a person.
- **Recorded services:** the answers of the payment and carrier services written down in advance.
