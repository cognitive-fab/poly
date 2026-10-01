# Change 2: give up an election

A candidate can now give up its election, for example when an operator wants another node to lead.

- `giveUp(node)`: a candidate becomes a follower in the same term. It keeps its vote for itself, so it grants no other vote in the term, and it ignores any `VoteReply` that arrives later. Refused otherwise.

Everything else is as before.
