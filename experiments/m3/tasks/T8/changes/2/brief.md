# Change 2: lose an election

A candidate can now learn that it lost its election without seeing a newer term.

- `electionLost()`: a candidate becomes a follower in the same term. It keeps its vote for itself, so it grants no other vote in that term. Refused otherwise.

Everything else is as before.
