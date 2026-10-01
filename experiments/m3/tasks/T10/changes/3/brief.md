# Change 3: stop waiting for a grant

A client can now stop wanting the lease while its request is on its way. The service still answers, and if the answer is a grant, the client gives the lease straight back.

- `cancelAcquire(client)`: a requesting client becomes **abandoning**. Refused otherwise.
- On `Granted`, an abandoning client records the token and gives the lease back at once: it becomes **releasing** and sends `Release` with that token, as `release` does. On `Denied`, it becomes **idle**.
- `acquire` is refused while the client is abandoning.

`status` in the client view can now also be `"abandoning"`. Everything else is as before.
