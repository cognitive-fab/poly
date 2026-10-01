# Change 1: announce the leader

A node that becomes the leader now tells the others.

- When a candidate becomes the leader, it sends each of the other two nodes `Leader` with data `{ from: <leader id>, term: 1 }`.
- A node that receives `Leader` records the sender as its leader. If it is in term 0, it moves to term 1 as a follower, without voting. If it is a candidate, it steps down: it becomes a follower, and keeps its vote for itself.
- A leader never receives `Leader`, since only one node leads in a term.

`node(node)` now also returns `leader`: the id of the leader it knows in its term, or `null`; a leader knows itself. Everything else is as before.
