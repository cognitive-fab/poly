# A lease with fencing tokens

Two clients, `"c0"` and `"c1"`, share a resource guarded by a lease service, `"lease"`. At most one client holds the lease at a time. Each grant carries a **fencing token**, a number that goes up with every grant, and the service takes a write only from the holder with the current token, so a client whose lease expired cannot write by mistake. The parts talk by messages. In this exercise the service grants at most 2 leases in all (tokens 1 and 2), and takes at most 2 writes in all.

## Commands

Each command returns `{ ok: true }` when it takes effect, and `{ ok: false, reason }` when it is refused. A refused command changes nothing. A command naming a client other than `"c0"` or `"c1"` is refused.

- `acquire(client)`: an idle client becomes **requesting** and asks the service for the lease. Refused otherwise.
- `release(client)`: a client holding the lease becomes **idle** and gives the lease back to the service, with its token. Refused otherwise.
- `write(client)`: a client holding the lease, with no write waiting for an answer, sends the service a write with its token. Refused otherwise.
- `expire()`: the service's lease on its current holder runs out: the service has no holder any more, and tells the former holder that its lease was revoked, with the token. Refused when no client holds the lease.

## The service

- On a request: if no client holds the lease and fewer than 2 leases were granted, the service grants it to the requester with the next token (1, then 2) and answers `Granted`; otherwise it answers `Denied`.
- On a release: if it comes from the holder with the current token, the service has no holder any more; otherwise it is ignored.
- On a write: if it comes from the holder with the current token and fewer than 2 writes were taken, the service takes it and answers `WriteDone`; otherwise it answers `WriteRefused`.

## Clients

- On `Granted`, a requesting client **holds** the lease with the token it was given. On `Denied`, it becomes **idle**.
- On `Revoked` with the client's own token, a client holding the lease becomes **idle**. A `Revoked` can arrive before the `Granted` it revokes: a client that does not hold the lease remembers the newest token revoked, and when a `Granted` with that token or an older one arrives, the client becomes **idle** instead of holding a lease that already expired. Any other `Revoked` is ignored.
- On `WriteDone` or `WriteRefused`, the client's write is answered, and it may write again.

## Queries

- `lease()` returns `{ holder, token, writes }`: the holding client's id or `null`, the last token granted (0 before any grant), and the number of writes taken.
- `client(client)` returns `{ status, token, writing }` for `"c0"` or `"c1"`, and `null` otherwise: `status` is `"idle"`, `"requesting"` or `"holding"`; `token` is the last token the client was granted (0 before any); `writing` says whether a write of the client waits for an answer.

## Messages

- from a client to the service: `Acquire` with data `{ from: <client id> }`; `Release` and `Write` with data `{ from: <client id>, token }`;
- from the service to a client: `Granted` with data `{ token }`; `Denied`, `WriteDone` and `WriteRefused` with data `{}`; `Revoked` with data `{ token }`.

## The interface

Implement `host.ts`. Its default export creates a fresh system: the service with no holder and token 0, and both clients idle. A message is not delivered until `deliver(id)` or `deliverAll()` is called, and messages may arrive in any order. `inFlight()` lists the messages in transit with the sender, the receiver, the message name as `action`, and its data.

## Conclusion

Whatever order the messages arrive in, the service takes writes only from the holder with the current token, at most one client holds the lease with the current token, and once no message is in transit, a client holds the lease exactly when the service says it does.
