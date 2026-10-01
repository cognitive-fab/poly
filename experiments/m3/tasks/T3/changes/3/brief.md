# Change 3: capture in parts

A payment can now be captured in several parts, for example when an order ships in two parcels.

- `capture(payment, amount)`: on an authorized payment, as before. On a captured payment that has not been refunded at all, it captures `amount` more, as long as the total captured stays at most the amount authorised; the payment stays captured. Refused otherwise.
- Once any amount has been refunded, no further capture is taken.

Everything else is as before.
