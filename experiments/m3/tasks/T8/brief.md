# A consensus node's role and term

A node of a consensus cluster is a **follower**, a **candidate** or the **leader**, in a numbered **term**, and it can be shut down. The events that move it arrive as commands. The system holds one node. In this exercise terms go from 0 to 3.

## Commands

Each command returns `{ ok: true }` when it takes effect, and `{ ok: false, reason }` when it is refused. A refused command changes nothing. Once the node is shut down, every command is refused.

- `electionTimeout()`: a follower or a candidate hears nothing for too long and starts an election: it becomes a candidate in the next term (the term goes up by 1). Refused for the leader, and refused in term 3.
- `electionWon()`: a candidate won its election and becomes the leader, in the same term. Refused otherwise.
- `newerTermSeen(term)`: the node sees a message from a term strictly newer than its own (1 to 3): whatever its role, it becomes a follower in that term. Refused when the term is outside 1 to 3 or not newer.
- `quorumLost()`: the leader lost contact with the majority and steps down: it becomes a follower in the same term. Refused otherwise.
- `shutdown()`: the node is **shut down**. Its term does not change.

## Query

`node()` returns `{ role, term }`, where `role` is `"follower"`, `"candidate"`, `"leader"` or `"shutdown"`. The node starts a follower in term 0.

## The interface

Implement `host.ts`. Its default export creates a fresh system: one node, a follower in term 0.

## Conclusion

The term never goes down, only an election or a newer term changes it, a leader was a candidate first in its own term, and a shut down node stays shut down.
