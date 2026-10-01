# Change 1: returns

A customer can now return a paid cart.

- `returnCart(cart)`: a paid cart becomes **returned**. It asks the payment service to refund it, with the message `Refund` and data `{ amount }` (its units), and gives its units back to the inventory with `Release`. Refused for a cart that is not paid.
- On `Refund`, the payment service subtracts `amount` from its total charged. It sends no answer.

`status` in the view can now also be `"returned"`. A returned cart accepts no command. Everything else is as before.
