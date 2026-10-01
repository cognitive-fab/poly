# Change 2: authorisations expire

A hold on a card does not last for ever. The provider reports when it lapses.

- `expire(payment)`: an authorized payment that was not captured becomes **expired**, and accepts no further command. Refused otherwise; in particular a captured payment does not expire.

`status` in the view can now also be `"expired"`. Everything else is as before.
