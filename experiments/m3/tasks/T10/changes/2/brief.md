# Change 2: acknowledge a release

A client that gives the lease back now waits until the service has taken it back.

- `release(client)`: a client holding the lease becomes **releasing** (not idle) and sends `Release` as before.
- On a release, the service now always answers `Released` with data `{}`, whether it took the lease back or ignored the release.
- On `Released`, a releasing client becomes **idle**. `acquire` is refused while the client is releasing, and a releasing client ignores `Revoked`.

`status` in the client view can now also be `"releasing"`. Everything else is as before.
