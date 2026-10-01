# Orders and inventory

A shop sells one product from one inventory. Orders are named by the caller with a string id, and each order asks for 1 or 2 units. The order and the inventory are separate parts of the system that talk by messages, so an order does not know at once whether its units are available.

## The inventory

The inventory starts with 1 unit available and none reserved, and it holds at most 3 units in all (available plus reserved).

- `restock()`: adds 1 available unit. Refused when the inventory already holds 3 units.
- `stock()` returns `{ available, reserved }`.

## Orders

Each command returns `{ ok: true }` when it takes effect, and `{ ok: false, reason }` when it is refused. A refused command changes nothing. A command on an order id that was never placed is refused.

- `place(order, qty)`: creates the order for `qty` units (1 or 2) as **pending**, and asks the inventory to reserve them. Refused if an order with that id exists.
- When the inventory answers that the units are reserved, a pending order becomes **confirmed**. When it answers that they are out of stock, a pending order becomes **rejected**.
- `cancel(order)`:
  - a confirmed order becomes **cancelled** and gives its units back to the inventory;
  - a pending order becomes **cancelling**: it waits for the inventory's answer, then becomes **cancelled**, giving back the units if they were reserved;
  - refused for an order that is cancelling, cancelled or rejected.
- `order(order)` returns `{ status, qty }` for an order that exists, and `null` otherwise. `status` is one of `"pending"`, `"confirmed"`, `"rejected"`, `"cancelling"`, `"cancelled"`.

## Messages

The inventory's id is `"inventory"`, and an order's id is its order id. The messages are:

- from an order to the inventory, `Reserve` with data `{ from: <order id>, qty }`: the inventory reserves `qty` units if that many are available (they move from available to reserved) and answers `Reserved`, or else answers `OutOfStock` and changes nothing;
- from the inventory to the order, `Reserved` or `OutOfStock`, with data `{}`;
- from an order to the inventory, `Release` with data `{ qty }`, when the order gives its units back: they move from reserved to available.

## The interface

Implement `host.ts`. Its default export creates a fresh system: the inventory and no orders. The parts of the system talk by messages. A message is not delivered until `deliver(id)` or `deliverAll()` is called, and messages may arrive in any order. `inFlight()` lists the messages in transit with the sender, the receiver, the message name as `action`, and its data.

## Conclusion

Units are never lost or invented: once no message is in transit, the reserved units are exactly those of the confirmed orders. An order is confirmed only with its units reserved, and every order that is cancelled gives back whatever was reserved for it, whenever the inventory's answer arrives.
