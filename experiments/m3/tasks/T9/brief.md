# Electing a leader among three nodes

Three nodes, `"n0"`, `"n1"` and `"n2"`, elect a leader by messages. In this exercise there is one election round, term 1: every node starts in term 0 as a follower, and a node can start at most one election.

## Commands

Each command returns `{ ok: true }` when it takes effect, and `{ ok: false, reason }` when it is refused. A refused command changes nothing.

- `timeout(node)`: the node heard nothing for too long and starts an election: a follower in term 0 becomes a **candidate** in term 1, votes for itself, and sends each of the other two nodes `RequestVote`. Refused otherwise, and refused for an id that is not a node.

## How nodes vote

A node that receives `RequestVote` for term 1 from a candidate:

- if the node is in term 0, it moves to term 1 as a follower, votes for that candidate, and answers `VoteReply` with `granted: true`;
- if the node is already in term 1, it grants its vote only if it is a follower that has not voted, or already voted for that candidate; it answers `VoteReply` with `granted` true or false accordingly.

A node votes at most once in a term. A candidate that receives a granted `VoteReply` for its term counts the vote; once it has 2 votes, its own included, it becomes the **leader**. Any other `VoteReply` is ignored.

## Query

`node(node)` returns `{ role, term, votedFor }` for `"n0"`, `"n1"` or `"n2"`, and `null` for any other id: `role` is `"follower"`, `"candidate"` or `"leader"`, and `votedFor` is the id of the node it voted for in its term, or `null`.

## Messages

- from a candidate to another node, `RequestVote` with data `{ from: <candidate id>, term: 1 }`;
- from a node to a candidate, `VoteReply` with data `{ term: 1, granted }`.

## The interface

Implement `host.ts`. Its default export creates a fresh system: the three nodes, followers in term 0 with no vote. A message is not delivered until `deliver(id)` or `deliverAll()` is called, and messages may arrive in any order. `inFlight()` lists the messages in transit with the sender, the receiver, the message name as `action`, and its data.

## Conclusion

Whatever order the messages arrive in, at most one node becomes leader in a term, a leader holds the votes of a majority, and no node votes twice in a term.
