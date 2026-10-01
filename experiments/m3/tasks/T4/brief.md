# Checkout across cart, inventory and payments

A shop sells one product. Its checkout has three parts that talk by messages: the carts, one inventory, and one payment service. Carts are named by the caller with a string id.

## The inventory

The inventory starts with 2 units available and none reserved. `stock()` returns `{ available, reserved }`.

## The payment service

The payment service charges carts. It either accepts every charge or declines every charge, as the caller sets it; it starts accepting. It keeps the total amount charged, 1 per unit, and it declines any charge that would take the total above 4.

- `declineCards()`: the payment service declines every charge from now on. Refused if it already declines.
- `acceptCards()`: the payment service accepts every charge from now on. Refused if it already accepts.
- `payments()` returns `{ charged, declining }`: the total charged, and whether it declines.

## Carts

Each command returns `{ ok: true }` when it takes effect, and `{ ok: false, reason }` when it is refused. A refused command changes nothing. A command on a cart id that was never opened is refused.

- `open(cart)`: creates the cart, **open** and empty. Refused if a cart with that id exists.
- `add(cart)`: adds one unit to an open cart, at most 2. Refused otherwise.
- `checkout(cart)`: an open cart with at least one unit becomes **reserving**, and asks the inventory to reserve its units. Refused otherwise.
- When the inventory answers that the units are reserved, a reserving cart becomes **paying** and asks the payment service to charge it. When the inventory answers that they are out of stock, the cart becomes **failed**.
- When the payment service answers that the charge went through, a paying cart becomes **paid**: its units stay reserved for it. When it answers that the charge was declined, the cart becomes **failed** and gives its units back to the inventory.
- `cancel(cart)`: an open cart becomes **cancelled**. A reserving cart becomes **cancelling**: it waits for the inventory's answer, then becomes **cancelled**, giving back the units if they were reserved. Refused for a paying cart (the payment is in progress) and for a cart that is paid, failed, cancelling or cancelled.
- `cart(cart)` returns `{ status, items }` for a cart that exists, and `null` otherwise. `status` is one of `"open"`, `"reserving"`, `"paying"`, `"paid"`, `"failed"`, `"cancelling"`, `"cancelled"`.

## Messages

The inventory's id is `"inventory"`, the payment service's id is `"payments"`, and a cart's id is its cart id. The messages are:

- from a cart to the inventory, `Reserve` with data `{ from: <cart id>, qty }`: the inventory reserves `qty` units if that many are available and answers `Reserved`, or else answers `OutOfStock` and changes nothing;
- from the inventory to a cart, `Reserved` or `OutOfStock`, with data `{}`;
- from a cart to the payment service, `Charge` with data `{ from: <cart id>, amount }`: the service adds `amount` to its total and answers `Charged`, or, when it declines, answers `Declined` and changes nothing;
- from the payment service to a cart, `Charged` or `Declined`, with data `{}`;
- from a cart to the inventory, `Release` with data `{ qty }`: the units move from reserved back to available.

## The interface

Implement `host.ts`. Its default export creates a fresh system: the inventory, the payment service, and no carts. A message is not delivered until `deliver(id)` or `deliverAll()` is called, and messages may arrive in any order. `inFlight()` lists the messages in transit with the sender, the receiver, the message name as `action`, and its data.

## Conclusion

Once no message is in transit, the reserved units are exactly the units of the paid carts, and the total charged is exactly their units too. A cart is paid only after its units were reserved and its charge went through, and every cart that fails or is cancelled gives back whatever was reserved for it.
