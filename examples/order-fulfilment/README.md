# Order fulfilment

An order is fulfilled by a saga of three steps: reserve the stock, charge the customer, ship the goods. A failed charge gives the stock back, and a failed shipment gives the stock back and refunds the charge. The charge, the shipment and the refund are keyed. The example calls no model, so what is recorded is the answers of the payment and carrier services; nothing leaves the machine. The spec is `docs/examples/order-fulfilment.md`.

## What it shows

- **A saga with compensations.** `ChargeFailed` releases the stock. `ShipFailed` releases the stock and refunds the charge. A refund that fails leaves the order `Stuck`, still charged, for a person.
- **An invariant on the compensation.** `cancelled-holds-nothing`: a cancelled order holds no stock and no charge. `done-is-charged` and the path properties `charge-at-most-once` and `refund-needs-charge` hold too.
- **A configuration.** Two orders share one stock in `two-orders`, with messages in any order within a transit bound of 4. The invariant `never-oversold` says the orders hold no more units than the stock began with, and the stock is never negative by its range.
- **A keyed charge.** The handlers send the intent's idempotency key, the same on every attempt of one intent and different for different orders.
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
| Program with its policy | `CLEAN`; `Stock` 2 states, `Order` 17 states; the configuration `two-orders` 126 global states and 2,107 global steps; about 1 s |
| Policy | all seven stages `CLEAN` |
| Defect copy | `FINDINGS`, exactly `PL3001 INVARIANT_REACHABLE` (`cancelled-holds-nothing`), a witness of 4 steps: `Place`, `Reserved`, `Charged`, `ShipFailed`; `Order` 15 states, the configuration 72 global states |
| Host handlers | compile under `poly check --host`; a wrong body field is `PL6836` |
| End to end | 8 tests: main path, an order refused for lack of stock, a declined charge, a shipment that fails and is compensated, a refund that fails, keyed retries, and a journal that replays (4 runs, 19 rows, 1 gate session, no divergence) |

## What is not checked

- **A larger world.** The configuration has one unit of stock, two orders and a transit bound of 4. `CLEAN` is a statement about that instance; three orders or two units were not tried. Nothing else was reduced.
- **The leak in the defect.** The configuration still checks `CLEAN` on the defect: one unit and two orders cannot be oversold even when the unit is never given back. The leak is the machine invariant's to find, which it does.
- **The services.** That a refund reached the customer, or that the carrier dedupes on the key, is the services'. The end-to-end test shows what the program asks for, on recorded answers.
- **Settlement of the whole saga.** There is no liveness property: that every order ends `Done`, `Cancelled`, `Rejected` or `Stuck` is the deadlock check's (a non-terminal state with no accepting action), not a fairness argument.

## Conclusion

The compensation is the thing a saga is for, and the check finds its absence on the machine in four steps. The configuration shows that the stock cannot be oversold, and, by checking the defect `CLEAN`, shows what it does not see. The checks here take about a second each.

## Glossary

- **Saga:** a sequence of steps each with a compensation that undoes it.
- **Compensation:** the step that gives back what an earlier step took.
- **Keyed:** a request that carries the intent's idempotency key.
- **Stuck:** a terminal state that waits for a person.
- **Recorded services:** the answers of the payment and carrier services written down in advance.
