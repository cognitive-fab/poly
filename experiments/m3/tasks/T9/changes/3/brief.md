# Change 3: crash and recover

A node can now crash and recover. What it wrote down before the crash, its term, its vote and the leader it knows, survives the crash.

- `crash(node)`: a node that is not down becomes **down**. A down node ignores every message delivered to it. Refused for a node that is down.
- `recover(node)`: a down node becomes a follower in the same term, with the same vote and the same known leader. A leader that crashed recovers as a follower. Refused for a node that is not down.
- `timeout(node)` is refused for a node that is down.

`role` in the view can now also be `"down"`. Everything else is as before.
