# Example spec: order-fulfilment

Batch 2, example 2. Written before any test or code (rule 7a). The tests are written by someone who has read only this page, so everything a test needs is on it.

## Purpose

An order is fulfilled by a saga of three steps: reserve the stock, charge the customer, ship the goods. Each step after the first has a compensation: a failed charge gives the stock back, and a failed shipment gives the stock back and refunds the charge. The charge is irreversible in practice and is keyed, so a retry cannot charge twice. Orders share one stock, so the example is checked as a configuration of two orders and one stock. The point of the example is the **compensation**: an order that ends `Cancelled` holds no stock and no charge. The seeded defect skips the compensation after a failed shipment.

The example calls no model, so it has no recorded model answers. What it records is the answers of the payment and carrier services, as the end-to-end test's fake transport.

## Files

All paths are under `examples/order-fulfilment/`. The names are fixed.

| File | Content |
|---|---|
| `order-fulfilment.poly` | module `fulfilment`, first line `// expected: CLEAN` |
| `order-fulfilment.policy.poly` | module `fulfilment_policy`, policy `orders`, scope `"fulfilment"` |
| `order-fulfilment-defect.poly` | the program with the compensation after a failed shipment removed, first line `// expected: FINDING PL3001` |
| `host/handlers.ts` | the certified handler file; exports `charge`, `ship` and `refund` |
| `host/tsconfig.json` | compiles `host/handlers.ts` for `poly check --host`; run with `--root examples/order-fulfilment` |
| `host/recorded.mjs` | the recorded services: exports `recordedServices(script)`, a fake egress transport that answers by URL from a script and records each request |
| `README.md` | what it shows, how to run it, what is checked, what is not, a conclusion, a glossary |

Tests: `test/ex-order-fulfilment.test.mjs` (light) and `test/after/ex-order-fulfilment-e2e.test.mjs` (admission and a run). The shared helper is `test/ex-kit.mjs`.

## Machines

Module `fulfilment`. No audience is needed (no decision).

`service machine Stock`: state `onHand : 0..1` (1). `Reserve(from: Ref<Order>)`: when `onHand > 0`, decrements it and sends `Reserved()` to `from`; otherwise sends `OutOfStock()`. `Release()`: rejects `"nothing-reserved"` unless `onHand < 1`; otherwise increments it.

`machine Order`: enum `St { Placed, Reserving, Charging, Shipping, Refunding, Done, Cancelled, Rejected, Stuck }`. State: `st` (`Placed`), `stock : Ref<Stock>` (none), `held : 0..1` (0), `charged : bool` (false). `terminal st in { Done, Cancelled, Rejected, Stuck }`.

- `Place(warehouse: Ref<Stock>)`: `"not-placed"` unless `Placed`; `"no-warehouse"` when `warehouse` is none. Goes to `Reserving`, records `stock` as `warehouse`, sends `Reserve(from: self)` to it. The host wires an order to the stock by this action, so a `Ref` field needs no creation data.
- `Reserved()`: `"not-reserving"` unless `Reserving`. Goes to `Charging`, sets `held` to 1, emits `charge()`.
- `OutOfStock()`: `"not-reserving"` unless `Reserving`. Goes to `Rejected`.
- `Charged()`: `"not-charging"` unless `Charging`. Goes to `Shipping`, sets `charged`, emits `ship()`.
- `ChargeFailed()`: `"not-charging"` unless `Charging`. Goes to `Cancelled`, clears `held`, sends `Release()` to `stock`.
- `Shipped()`: `"not-shipping"` unless `Shipping`. Goes to `Done`.
- `ShipFailed()`: `"not-shipping"` unless `Shipping`. The compensations: goes to `Refunding`, clears `held`, sends `Release()` to `stock`, emits `refund()`.
- `Refunded()`: `"not-refunding"` unless `Refunding`. Goes to `Cancelled`, clears `charged`.
- `RefundFailed()`: `"not-refunding"` unless `Refunding`. Goes to `Stuck` (still charged; a person must refund).

## Effects

Each has labels `egress:external`, retry `attempts 3, base 200ms, timeout 10s`, no payload, and `ok`, `failed` and `exhausted` outcomes as below.

| Effect | Kind | Target (exact URL) | Class | ok | failed and exhausted |
|---|---|---|---|---|---|
| `charge()` | `payments.charge` | `https://payments.example/v1/charges` | `compensable` | `Charged` | `ChargeFailed` |
| `ship()` | `carrier.ship` | `https://carrier.example/v1/shipments` | `irreversible` | `Shipped` | `ShipFailed` |
| `refund()` | `payments.refund` | `https://payments.example/v1/refunds` | `irreversible` | `Refunded` | `RefundFailed` |

## Host handlers

`host/handlers.ts` exports `charge`, `ship` and `refund`, each `(payload, caps, ctx)`, with a type-only import from `../.poly/build/fulfilment.Order/types.js`. Each posts `{ order: ctx.instanceId }` through `caps.egress.post` to its URL with the header `idempotency-key` set to `ctx.idempotencyKey`. Status 200 or 201 returns `{ ok: true }`. A status from 400 to 499 other than 429 throws an error with `permanent: true` (a declined card is permanent); any other status or a transport error throws an ordinary error and is retried. **Keyed:** every attempt of one intent sends the same key, and the charge of one order and the charge of another send different keys.

## Recorded services

`host/recorded.mjs` exports `recordedServices(script)`, where `script` maps a URL to a status or a list of statuses (the nth request to that URL gets the nth status; the last is repeated; a URL not in the script gets 201). It returns `{ sent, transports }`: `sent` lists each request `{ url, body, headers }` and `transports.egress` is the fake the runtime's `load` takes.

## Policy

Policy `orders`, scope `"fulfilment"`: three rules, each `else deny` with `on unknown deny`, for `proposal.kind == "effect"` and an effect kind, requiring `machine("fulfilment.Order").st` to be `Charging` for `payments.charge`, `Shipping` for `carrier.ship`, and `Refunding` for `payments.refund`. Obligation names: `charge-while-charging`, `ship-while-shipping`, `refund-while-refunding`. The policy is signed as a person signs it.

## Properties

On `Order`:

1. **Invariant `cancelled-holds-nothing`**: `st == Cancelled implies held == 0 && !charged`.
2. **Invariant `done-is-charged`**: `st == Done implies charged`.
3. **Path property `charge-at-most-once`**: `count("payments.charge") <= 1`.
4. **Path property `refund-needs-charge`**: `before("payments.charge", "payments.refund")`.

The configuration `two-orders`: instances `stock : Stock` and `order[2] : Order { stock: stock }`; inputs `order[*].Place` (with its `warehouse` parameter) and the completions `order[*].Charged`, `ChargeFailed`, `Shipped`, `ShipFailed`, `Refunded`, `RefundFailed`; bounds `transit 4`; invariant **`never-oversold`**: `sum(order[*].held) <= init(stock.onHand)`. Stock is never negative by its range, which is the automatic invariant `domain:onHand`.

The program and its policy check `CLEAN`; the configuration has 126 global states, 2,107 global steps.

## Seeded defect

`order-fulfilment-defect.poly` is the program whose `ShipFailed` goes straight to `Cancelled` with no `held` change, no `Release` and no `refund`. The check rejects it with exactly one code, `PL3001 INVARIANT_REACHABLE`, naming `cancelled-holds-nothing`. The witness has **4 steps**: `Place`, `Reserved`, `Charged`, `ShipFailed`. The configuration still checks `CLEAN` (one unit and two orders cannot oversell even when the unit is never given back), which the README says: the leak is the machine invariant's to find.

## What the tests must show

Light test:

- the program with its policy is `CLEAN`; the report prints the instance for `Stock`, `Order` and the configuration (126 global states);
- the defect is `FINDINGS` with exactly `PL3001`, the invariant named, a witness of 4 steps ending in `ShipFailed`;
- `poly check --host` is `CLEAN`, and a handler with a wrong body field is `PL6836`;
- the handlers: 201 ok; 402 throws with `permanent: true`; 503 throws without it; every request carries `idempotency-key`; the body carries `ctx.instanceId`; a missing throw fails the test;
- `recordedServices`: answers by URL and by call count; defaults to 201; records requests.

End-to-end test, over recorded services, nothing on the network. The stock is a `fulfilment.Stock` instance created first (`rt.create(kind, { id })`); each order is a `fulfilment.Order` instance created with `{ id }` and then `Place` with `{ warehouse: <the stock instance id> }`; messages between instances are delivered by the runtime, so settle between steps:

- main path: `Place` on one order reserves, charges, ships: `Done`, one request to each of charge and ship, none to refund; stock `onHand` 0;
- refusal: a second order placed against the one unit ends `Rejected` with no request; a charge answered 402 ends `Cancelled`, held 0, charged false, stock back to 1, no ship;
- compensation: a shipment answered 500 three times (exhausted) ends `Cancelled` through `Refunding` with one refund request, `held` 0, `charged` false and stock back to 1;
- a refund that fails ends `Stuck` (still charged);
- keyed: the charge answered 503 then 201 sends two requests with the same `idempotency-key`; two orders' charges send different keys;
- the journal replays with no divergence (`replayRuntime`, `replaySessions`).

The example has no escalation to a person other than `Stuck`, which leaves an order for one.

## Conclusion

The compensation is the thing a saga is for, and the check finds its absence on the machine in four steps. What the configuration shows is that the stock cannot be oversold; what neither shows is that a refund reached the customer, which the end-to-end test shows on the recorded services.

## Glossary

- **Saga:** a sequence of steps each with a compensation that undoes it.
- **Compensation:** the step that gives back what an earlier step took.
- **Keyed charge:** a charge whose request carries the intent's idempotency key.
- **Stuck:** a terminal state that waits for a person.
