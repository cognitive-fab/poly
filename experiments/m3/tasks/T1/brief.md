# Order lifecycle

A shop keeps orders. Each order is named by the caller with a string id. An order is created empty, filled with items, placed, paid for, and shipped, and it can be cancelled on the way. Placing an order asks the payment provider to charge the customer, and cancelling an order that was paid for asks the provider to refund the customer. The provider's answer arrives later as a command.

## Commands

Each command returns `{ ok: true }` when it takes effect, and `{ ok: false, reason }` when it is refused. A refused command changes nothing. Any command on an order id that was never created is refused.

- `create(order)`: creates the order, empty, as a **draft**. Refused if an order with that id exists.
- `addItem(order)`: adds one item to a draft. Refused unless the order is a draft, and refused when the draft already holds 3 items.
- `removeItem(order)`: removes one item from a draft. Refused unless the order is a draft holding at least one item.
- `place(order)`: places a draft that holds at least one item. The order becomes **placed** and one charge is requested from the payment provider. Refused otherwise.
- `paymentSucceeded(order)`: the provider reports that the charge went through. A placed order becomes **paid**. Refused otherwise.
- `paymentFailed(order)`: the provider reports that the charge failed. A placed order becomes **failed**. Refused otherwise.
- `ship(order)`: a paid order becomes **shipped**. Refused otherwise.
- `cancel(order)`: a draft becomes **cancelled**. A paid order becomes **cancelled** and one refund is requested from the payment provider. Refused while the order is placed (the payment is in progress), and refused once it is shipped, failed or cancelled.

## Query

`order(order)` returns `{ status, items, charges, refunds }` for an order that exists, and `null` otherwise:

- `status`: one of `"draft"`, `"placed"`, `"paid"`, `"shipped"`, `"cancelled"`, `"failed"`;
- `items`: the number of items, 0 to 3;
- `charges`: how many charges were requested for the order;
- `refunds`: how many refunds were requested for the order.

## The interface

Implement `host.ts`. Its default export creates a fresh system, with no orders.

## Conclusion

An order is charged at most once, only when it is placed with at least one item, and refunded exactly when it is cancelled after being paid. It ships only when paid, and a shipped, failed or cancelled order accepts no further command.
