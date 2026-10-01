# Change 1: raise the authorised amount

A customer can now add to an order before it is captured, so the authorised amount can be raised.

- `increase(payment)`: an authorized payment that was not captured raises its authorised amount by 1 unit, up to 3 units. Refused otherwise.
- `capture(payment, amount)` now takes 1 to 3 units, still at most the amount authorised.

`authorized` in the view is the amount authorised so far. Everything else is as before.
