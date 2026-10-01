# Change 3: reduce a confirmed order

A customer can now take one unit fewer on a confirmed order of 2 units.

- `reduce(order)`: a confirmed order for 2 units keeps its status, now for 1 unit, and gives 1 unit back to the inventory with `Release` and data `{ qty: 1 }`. Refused for any other order.

Everything else is as before: cancelling or expiring the order later gives back the units it still holds.
