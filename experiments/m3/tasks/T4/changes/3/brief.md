# Change 3: give up on a slow payment

The shop can now give up on a payment that takes too long. The payment service may still answer afterwards, and its answer decides whether money must be returned.

- `paymentTimeout(cart)`: a paying cart becomes **abandoning** and gives its units back to the inventory at once. Refused otherwise.
- When the payment service answers an abandoning cart that the charge went through, the cart asks for the money back with `Refund`, as a returned cart does, and becomes **failed**. When it answers that the charge was declined, the cart becomes **failed**.
- An abandoning cart accepts no command.

`status` in the view can now also be `"abandoning"`. Everything else is as before.
