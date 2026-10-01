# Change 1: reservations expire

A confirmed order's reservation can now expire, for example when the customer does not complete the purchase in time. The shop reports it with a command.

- `expire(order)`: a confirmed order becomes **expired** and gives its units back to the inventory, as a cancelled order does. Refused otherwise.

`status` in the view can now also be `"expired"`. An expired order accepts no command. Everything else is as before.
