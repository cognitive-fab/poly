# Change 1: votes

The node now answers vote requests from the other nodes of the cluster, `"n1"` and `"n2"`, and it votes at most once in a term.

- `voteRequested(candidate, term)`: `candidate` is `"n1"` or `"n2"`, and `term` is 1 to 3. The command returns `{ ok: true }` when the node grants its vote, and `{ ok: false, reason }` when it does not; a vote not granted changes nothing.
  - If `term` is newer than the node's term, the node becomes a follower in that term and grants its vote.
  - If `term` is the node's term, the node grants its vote only if it is a follower that has not voted in this term, or has already voted for this candidate.
  - Otherwise the vote is not granted.
- A node that starts an election votes for itself. A node that moves to a newer term by `newerTermSeen` has not voted in it yet.

`node()` now also returns `votedFor`: `"nobody"`, `"itself"`, `"n1"` or `"n2"`, the node's vote in its current term. Everything else is as before.
