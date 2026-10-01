# Change 2: retry a declined card

A declined card no longer ends the checkout at once: the customer can try again or give up.

- When the payment service answers that the charge was declined, a paying cart now becomes **declined** and keeps its units reserved.
- `retry(cart)`: a declined cart becomes **paying** and asks the payment service to charge it again. Refused otherwise.
- `abandon(cart)`: a declined cart becomes **failed** and gives its units back to the inventory. Refused otherwise.

`status` in the view can now also be `"declined"`. A declined cart accepts no command other than `retry` and `abandon`. Everything else is as before.
