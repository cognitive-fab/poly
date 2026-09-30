# Change 3: hold a paid order

The warehouse can now hold a paid order back from shipping, for example while an address is checked.

- `hold(order)`: a paid order that is not held becomes held. Refused otherwise.
- `release(order)`: a held order is no longer held. Refused otherwise.
- `ship(order)`: refused while the order is held.
- `cancel(order)`: a held paid order can be cancelled, as any paid order; it is then no longer held.

The view gains `held`, a boolean, false for every order that is not held. Everything else is as before.
