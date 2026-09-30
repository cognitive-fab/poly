# Change 1: retry a declined payment

A payment that fails on the first charge can now be retried once.

- `paymentFailed(order)`: when the order's first charge fails, the placed order becomes **declined**. When its second charge fails, it becomes **failed**, as before.
- `retryPayment(order)`: a declined order becomes **placed** again, and one more charge is requested from the payment provider. Refused otherwise.
- A declined order accepts no command other than `retryPayment`; in particular it cannot be cancelled.

`status` in the view can now also be `"declined"`, and `charges` is at most 2. Everything else is as before.
