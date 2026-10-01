# Change 3: pause a follower

An operator can now pause a follower, for example during maintenance, so that it starts no election.

- `pause()`: a follower that is not paused becomes paused. Refused otherwise.
- `resume()`: a paused node is no longer paused. Refused otherwise.
- `electionTimeout()` is refused while the node is paused. A paused node still answers vote requests and still moves to a newer term; it stays paused.

`node()` now also returns `paused`, a boolean. Everything else is as before.
