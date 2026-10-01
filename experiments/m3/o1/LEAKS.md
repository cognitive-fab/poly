# Leaks in the briefs

For each task and version: every sentence that names a programming language, framework, verification tool or modelling notation, or that describes how the system is built inside rather than what it does through the interface. `none` means nothing to flag.

The closing sentence every brief shares, "Implement `host.ts`. Its default export creates a fresh system ...", is the interface handed to implementers and is not listed. Status names that a query returns are observable behaviour and are not listed either.

## T1
### v0
none
### v1
none
### v2
none
### v3
none

## T2
### v0
none
### v1
none
### v2
none
### v3
none

## T3
### v0
none
### v1
none
### v2
none
### v3
none

## T4
### v0
none
### v1
none
### v2
none
### v3
none

## T5
### v0
none
### v1
none
### v2
none
### v3
none

## T6
### v0
none
### v1
none
### v2
none
### v3
none

## T7
### v0
none
### v1
none
### v2
none
### v3
none

## T8
### v0
none
### v1
none
### v2
none
### v3
none

## T9
### v0
none
### v1
none
### v2
none
### v3
none

## T10
### v0
- "A `Revoked` can arrive before the `Granted` it revokes: a client that does not hold the lease remembers the newest token revoked, and when a `Granted` with that token or an older one arrives, the client becomes **idle** instead of holding a lease that already expired." — describes internal client state (a remembered "newest token revoked") that no query exposes (the client view has only status, token, writing); the observable rule is only "a Granted whose token was already revoked leaves the client idle".
### v1
- "A `Revoked` can arrive before the `Granted` it revokes: a client that does not hold the lease remembers the newest token revoked, and when a `Granted` with that token or an older one arrives, the client becomes **idle** instead of holding a lease that already expired." — same as v0 (text carried over): internal remembered-revoked-token state not observable through the interface.
### v2
- "A `Revoked` can arrive before the `Granted` it revokes: a client that does not hold the lease remembers the newest token revoked, and when a `Granted` with that token or an older one arrives, the client becomes **idle** instead of holding a lease that already expired." — same as v0 (text carried over): internal remembered-revoked-token state not observable through the interface.
### v3
- "A `Revoked` can arrive before the `Granted` it revokes: a client that does not hold the lease remembers the newest token revoked, and when a `Granted` with that token or an older one arrives, the client becomes **idle** instead of holding a lease that already expired." — same as v0 (text carried over): internal remembered-revoked-token state not observable through the interface.

