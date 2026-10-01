# Change 1: one write per grant

The service now takes at most one write per grant.

- On a write from the holder with the current token, the service takes it only if no write was taken since that grant (and, as before, fewer than 2 writes were taken in all); otherwise it answers `WriteRefused`.

Everything else is as before.
