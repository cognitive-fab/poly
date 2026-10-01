// T8 v1: end-to-end tests of the brief through the host interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { default: createHost } = await import(pathToFileURL(process.env.M3_IMPL).href);

const VERSION = 1;
const FIELDS = ["role","term","votedFor"];

/** The fields of node() the brief defines at this version. */
async function snap(h) {
  const n = await h.node();
  const o = {};
  for (const f of FIELDS) o[f] = n[f];
  return o;
}

/** Runs a command that the brief says is refused, and checks that it changed nothing. */
async function refusedUnchanged(h, call) {
  const before = await snap(h);
  const r = await call();
  assert.equal(r.ok, false);
  assert.deepEqual(await snap(h), before);
}

/** Makes a fresh node the leader in term 1. */
async function toLeader(h) {
  assert.equal((await h.electionTimeout()).ok, true);
  assert.equal((await h.electionWon()).ok, true);
}

/** Every command of the interface, as thunks. */
function allCommands(h) {
  return [
    () => h.electionTimeout(),
    () => h.electionWon(),
    () => h.newerTermSeen(1),
    () => h.newerTermSeen(2),
    () => h.newerTermSeen(3),
    () => h.quorumLost(),
    () => h.shutdown(),
    () => h.voteRequested('n1', 1),
    () => h.voteRequested('n2', 2),
    () => h.voteRequested('n1', 3),
  ];
}

// ---------------------------------------------------------------- initial state

test('a fresh node is a follower', async () => {
  const h = await createHost();
  const n = await h.node();
  assert.equal(n.role, 'follower');
});

test('a fresh node is in term 0', async () => {
  const h = await createHost();
  const n = await h.node();
  assert.equal(n.term, 0);
});

test('two fresh systems are independent', async () => {
  const h1 = await createHost();
  await h1.electionTimeout();
  const h2 = await createHost();
  const n = await h2.node();
  assert.equal(n.role, 'follower');
  assert.equal(n.term, 0);
});

// ---------------------------------------------------------------- electionTimeout

test('electionTimeout is accepted for a fresh follower', async () => {
  const h = await createHost();
  const r = await h.electionTimeout();
  assert.equal(r.ok, true);
});

test('electionTimeout makes a follower a candidate', async () => {
  const h = await createHost();
  await h.electionTimeout();
  assert.equal((await h.node()).role, 'candidate');
});

test('electionTimeout raises the term by 1 from 0 to 1', async () => {
  const h = await createHost();
  await h.electionTimeout();
  assert.equal((await h.node()).term, 1);
});

test('electionTimeout is accepted for a candidate', async () => {
  const h = await createHost();
  await h.electionTimeout();
  const r = await h.electionTimeout();
  assert.equal(r.ok, true);
});

test('electionTimeout keeps a candidate a candidate', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.electionTimeout();
  assert.equal((await h.node()).role, 'candidate');
});

test('electionTimeout for a candidate raises the term by 1', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.electionTimeout();
  assert.equal((await h.node()).term, 2);
});

test('three electionTimeouts reach a candidate in term 3', async () => {
  const h = await createHost();
  for (let i = 0; i < 3; i++) assert.equal((await h.electionTimeout()).ok, true);
  const n = await h.node();
  assert.equal(n.role, 'candidate');
  assert.equal(n.term, 3);
});

test('electionTimeout is refused for a candidate in term 3 and changes nothing', async () => {
  const h = await createHost();
  for (let i = 0; i < 3; i++) await h.electionTimeout();
  await refusedUnchanged(h, () => h.electionTimeout());
  const n = await h.node();
  assert.equal(n.role, 'candidate');
  assert.equal(n.term, 3);
});

test('electionTimeout is refused for a follower in term 3 and changes nothing', async () => {
  const h = await createHost();
  assert.equal((await h.newerTermSeen(3)).ok, true);
  await refusedUnchanged(h, () => h.electionTimeout());
  const n = await h.node();
  assert.equal(n.role, 'follower');
  assert.equal(n.term, 3);
});

test('electionTimeout is refused for the leader and changes nothing', async () => {
  const h = await createHost();
  await toLeader(h);
  await refusedUnchanged(h, () => h.electionTimeout());
  const n = await h.node();
  assert.equal(n.role, 'leader');
  assert.equal(n.term, 1);
});

test('electionTimeout is refused for a leader in term 2', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.electionTimeout();
  await h.electionWon();
  await refusedUnchanged(h, () => h.electionTimeout());
});

test('electionTimeout is accepted for a follower that stepped down as leader', async () => {
  const h = await createHost();
  await toLeader(h);
  await h.quorumLost();
  const r = await h.electionTimeout();
  assert.equal(r.ok, true);
  const n = await h.node();
  assert.equal(n.role, 'candidate');
  assert.equal(n.term, 2);
});

test('electionTimeout from a follower in term 2 makes a candidate in term 3', async () => {
  const h = await createHost();
  await h.newerTermSeen(2);
  const r = await h.electionTimeout();
  assert.equal(r.ok, true);
  const n = await h.node();
  assert.equal(n.role, 'candidate');
  assert.equal(n.term, 3);
});

test('electionTimeout from a follower in term 1 makes a candidate in term 2', async () => {
  const h = await createHost();
  await h.newerTermSeen(1);
  await h.electionTimeout();
  const n = await h.node();
  assert.equal(n.role, 'candidate');
  assert.equal(n.term, 2);
});

// ---------------------------------------------------------------- electionWon

test('electionWon is refused for a fresh follower and changes nothing', async () => {
  const h = await createHost();
  await refusedUnchanged(h, () => h.electionWon());
});

test('electionWon is accepted for a candidate', async () => {
  const h = await createHost();
  await h.electionTimeout();
  const r = await h.electionWon();
  assert.equal(r.ok, true);
});

test('electionWon makes a candidate the leader', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.electionWon();
  assert.equal((await h.node()).role, 'leader');
});

test('electionWon keeps the term of the candidate', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.electionTimeout();
  await h.electionWon();
  assert.equal((await h.node()).term, 2);
});

test('electionWon is accepted for a candidate in term 3', async () => {
  const h = await createHost();
  for (let i = 0; i < 3; i++) await h.electionTimeout();
  const r = await h.electionWon();
  assert.equal(r.ok, true);
  const n = await h.node();
  assert.equal(n.role, 'leader');
  assert.equal(n.term, 3);
});

test('electionWon is refused for the leader and changes nothing', async () => {
  const h = await createHost();
  await toLeader(h);
  await refusedUnchanged(h, () => h.electionWon());
});

test('electionWon is refused for a follower that stepped down as leader', async () => {
  const h = await createHost();
  await toLeader(h);
  await h.quorumLost();
  await refusedUnchanged(h, () => h.electionWon());
});

test('electionWon is refused for a candidate that saw a newer term', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.newerTermSeen(2);
  await refusedUnchanged(h, () => h.electionWon());
  assert.equal((await h.node()).role, 'follower');
});

test('electionWon is refused for a follower in a newer term', async () => {
  const h = await createHost();
  await h.newerTermSeen(1);
  await refusedUnchanged(h, () => h.electionWon());
});

// ---------------------------------------------------------------- newerTermSeen

test('newerTermSeen(1) is accepted for a fresh follower', async () => {
  const h = await createHost();
  const r = await h.newerTermSeen(1);
  assert.equal(r.ok, true);
});

test('newerTermSeen(1) puts a fresh follower in term 1 as follower', async () => {
  const h = await createHost();
  await h.newerTermSeen(1);
  const n = await h.node();
  assert.equal(n.role, 'follower');
  assert.equal(n.term, 1);
});

test('newerTermSeen can jump from term 0 straight to term 3', async () => {
  const h = await createHost();
  const r = await h.newerTermSeen(3);
  assert.equal(r.ok, true);
  const n = await h.node();
  assert.equal(n.role, 'follower');
  assert.equal(n.term, 3);
});

test('newerTermSeen(2) puts a fresh follower in term 2', async () => {
  const h = await createHost();
  await h.newerTermSeen(2);
  assert.equal((await h.node()).term, 2);
});

test('newerTermSeen accepts successive newer terms', async () => {
  const h = await createHost();
  assert.equal((await h.newerTermSeen(1)).ok, true);
  assert.equal((await h.newerTermSeen(2)).ok, true);
  assert.equal((await h.newerTermSeen(3)).ok, true);
  const n = await h.node();
  assert.equal(n.role, 'follower');
  assert.equal(n.term, 3);
});

test('newerTermSeen is refused for the same term and changes nothing', async () => {
  const h = await createHost();
  await h.newerTermSeen(2);
  await refusedUnchanged(h, () => h.newerTermSeen(2));
});

test('newerTermSeen is refused for an older term and changes nothing', async () => {
  const h = await createHost();
  await h.newerTermSeen(3);
  await refusedUnchanged(h, () => h.newerTermSeen(1));
  assert.equal((await h.node()).term, 3);
});

test('newerTermSeen(2) is refused in term 3', async () => {
  const h = await createHost();
  await h.newerTermSeen(3);
  await refusedUnchanged(h, () => h.newerTermSeen(2));
});

test('newerTermSeen(3) is refused in term 3', async () => {
  const h = await createHost();
  await h.newerTermSeen(3);
  await refusedUnchanged(h, () => h.newerTermSeen(3));
});

test('newerTermSeen turns a candidate into a follower in the newer term', async () => {
  const h = await createHost();
  await h.electionTimeout();
  const r = await h.newerTermSeen(3);
  assert.equal(r.ok, true);
  const n = await h.node();
  assert.equal(n.role, 'follower');
  assert.equal(n.term, 3);
});

test('newerTermSeen turns the leader into a follower in the newer term', async () => {
  const h = await createHost();
  await toLeader(h);
  const r = await h.newerTermSeen(2);
  assert.equal(r.ok, true);
  const n = await h.node();
  assert.equal(n.role, 'follower');
  assert.equal(n.term, 2);
});

test('newerTermSeen is refused for a candidate seeing its own term', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await refusedUnchanged(h, () => h.newerTermSeen(1));
  assert.equal((await h.node()).role, 'candidate');
});

test('newerTermSeen is refused for the leader seeing its own term', async () => {
  const h = await createHost();
  await toLeader(h);
  await refusedUnchanged(h, () => h.newerTermSeen(1));
  assert.equal((await h.node()).role, 'leader');
});

test('newerTermSeen is refused for the leader seeing an older term', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.electionTimeout();
  await h.electionWon();
  await refusedUnchanged(h, () => h.newerTermSeen(1));
});

test('newerTermSeen is refused for a candidate seeing an older term', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.electionTimeout();
  await refusedUnchanged(h, () => h.newerTermSeen(1));
});

// ---------------------------------------------------------------- quorumLost

test('quorumLost is accepted for the leader', async () => {
  const h = await createHost();
  await toLeader(h);
  const r = await h.quorumLost();
  assert.equal(r.ok, true);
});

test('quorumLost makes the leader a follower', async () => {
  const h = await createHost();
  await toLeader(h);
  await h.quorumLost();
  assert.equal((await h.node()).role, 'follower');
});

test('quorumLost keeps the term', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.electionTimeout();
  await h.electionWon();
  await h.quorumLost();
  assert.equal((await h.node()).term, 2);
});

test('quorumLost is refused for a fresh follower and changes nothing', async () => {
  const h = await createHost();
  await refusedUnchanged(h, () => h.quorumLost());
});

test('quorumLost is refused for a candidate and changes nothing', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await refusedUnchanged(h, () => h.quorumLost());
});

test('quorumLost is refused for a follower that already stepped down', async () => {
  const h = await createHost();
  await toLeader(h);
  await h.quorumLost();
  await refusedUnchanged(h, () => h.quorumLost());
});

test('a leader that stepped down can be elected again in a later term', async () => {
  const h = await createHost();
  await toLeader(h);
  await h.quorumLost();
  await h.electionTimeout();
  assert.equal((await h.electionWon()).ok, true);
  const n = await h.node();
  assert.equal(n.role, 'leader');
  assert.equal(n.term, 2);
});

// ---------------------------------------------------------------- shutdown

test('shutdown is accepted for a fresh follower', async () => {
  const h = await createHost();
  const r = await h.shutdown();
  assert.equal(r.ok, true);
});

test('shutdown makes the role shutdown', async () => {
  const h = await createHost();
  await h.shutdown();
  assert.equal((await h.node()).role, 'shutdown');
});

test('shutdown of a fresh follower keeps term 0', async () => {
  const h = await createHost();
  await h.shutdown();
  assert.equal((await h.node()).term, 0);
});

test('shutdown is accepted for a candidate and keeps its term', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.electionTimeout();
  const r = await h.shutdown();
  assert.equal(r.ok, true);
  const n = await h.node();
  assert.equal(n.role, 'shutdown');
  assert.equal(n.term, 2);
});

test('shutdown is accepted for the leader and keeps its term', async () => {
  const h = await createHost();
  await toLeader(h);
  const r = await h.shutdown();
  assert.equal(r.ok, true);
  const n = await h.node();
  assert.equal(n.role, 'shutdown');
  assert.equal(n.term, 1);
});

test('shutdown is accepted for a follower in term 3 and keeps term 3', async () => {
  const h = await createHost();
  await h.newerTermSeen(3);
  assert.equal((await h.shutdown()).ok, true);
  assert.equal((await h.node()).term, 3);
});

test('shutdown is refused for a node already shut down', async () => {
  const h = await createHost();
  await h.shutdown();
  await refusedUnchanged(h, () => h.shutdown());
});

test('electionTimeout is refused once shut down', async () => {
  const h = await createHost();
  await h.shutdown();
  await refusedUnchanged(h, () => h.electionTimeout());
});

test('electionTimeout is refused for a shut down candidate', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.shutdown();
  await refusedUnchanged(h, () => h.electionTimeout());
});

test('electionWon is refused for a shut down candidate', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.shutdown();
  await refusedUnchanged(h, () => h.electionWon());
  assert.equal((await h.node()).role, 'shutdown');
});

test('newerTermSeen is refused once shut down, for every term', async () => {
  const h = await createHost();
  await h.shutdown();
  for (const t of [1, 2, 3]) await refusedUnchanged(h, () => h.newerTermSeen(t));
  assert.equal((await h.node()).term, 0);
});

test('quorumLost is refused for a shut down leader', async () => {
  const h = await createHost();
  await toLeader(h);
  await h.shutdown();
  await refusedUnchanged(h, () => h.quorumLost());
  assert.equal((await h.node()).role, 'shutdown');
});

test('a shut down node stays shut down after every command is tried', async () => {
  const h = await createHost();
  await toLeader(h);
  await h.shutdown();
  for (const call of allCommands(h)) {
    const r = await call();
    assert.equal(r.ok, false);
    const n = await h.node();
    assert.equal(n.role, 'shutdown');
    assert.equal(n.term, 1);
  }
});

// ---------------------------------------------------------------- conclusion

test('a leader is reached only through candidacy in the same term', async () => {
  const h = await createHost();
  await h.electionTimeout();
  const c = await h.node();
  assert.equal(c.role, 'candidate');
  await h.electionWon();
  const l = await h.node();
  assert.equal(l.role, 'leader');
  assert.equal(l.term, c.term);
});

test('a follower in a newer term cannot become leader without a new election', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.newerTermSeen(2);
  assert.equal((await h.electionWon()).ok, false);
  assert.equal((await h.electionTimeout()).ok, true);
  assert.equal((await h.electionWon()).ok, true);
  const n = await h.node();
  assert.equal(n.role, 'leader');
  assert.equal(n.term, 3);
});

test('a full life cycle moves the term up only through elections and newer terms', async () => {
  const h = await createHost();
  const terms = [];
  const step = async (call) => { await call(); terms.push((await h.node()).term); };
  await step(() => h.electionTimeout()); // 1
  await step(() => h.electionWon()); // 1
  await step(() => h.quorumLost()); // 1
  await step(() => h.newerTermSeen(1)); // refused, 1
  await step(() => h.newerTermSeen(2)); // 2
  await step(() => h.electionWon()); // refused, 2
  await step(() => h.electionTimeout()); // 3
  await step(() => h.electionTimeout()); // refused, 3
  await step(() => h.electionWon()); // 3
  await step(() => h.shutdown()); // 3
  assert.deepEqual(terms, [1, 1, 1, 1, 2, 2, 3, 3, 3, 3]);
  assert.equal((await h.node()).role, 'shutdown');
});

// ---------------------------------------------------------------- change 1: votedFor follows the role commands

test('a fresh node has voted for nobody', async () => {
  const h = await createHost();
  assert.equal((await h.node()).votedFor, 'nobody');
});

test('starting an election votes for itself', async () => {
  const h = await createHost();
  await h.electionTimeout();
  assert.equal((await h.node()).votedFor, 'itself');
});

test('a candidate starting a new election votes for itself in the new term', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.electionTimeout();
  const n = await h.node();
  assert.equal(n.term, 2);
  assert.equal(n.votedFor, 'itself');
});

test('a follower that voted for n1 votes for itself when it starts an election', async () => {
  const h = await createHost();
  await h.voteRequested('n1', 1);
  await h.electionTimeout();
  const n = await h.node();
  assert.equal(n.role, 'candidate');
  assert.equal(n.term, 2);
  assert.equal(n.votedFor, 'itself');
});

test('the leader keeps its vote for itself', async () => {
  const h = await createHost();
  await toLeader(h);
  assert.equal((await h.node()).votedFor, 'itself');
});

test('a leader that steps down keeps its vote for itself', async () => {
  const h = await createHost();
  await toLeader(h);
  await h.quorumLost();
  const n = await h.node();
  assert.equal(n.role, 'follower');
  assert.equal(n.votedFor, 'itself');
});

test('newerTermSeen leaves a follower with no vote in the new term', async () => {
  const h = await createHost();
  await h.newerTermSeen(2);
  assert.equal((await h.node()).votedFor, 'nobody');
});

test('newerTermSeen clears a candidate vote for itself', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.newerTermSeen(2);
  assert.equal((await h.node()).votedFor, 'nobody');
});

test('newerTermSeen clears a leader vote for itself', async () => {
  const h = await createHost();
  await toLeader(h);
  await h.newerTermSeen(3);
  assert.equal((await h.node()).votedFor, 'nobody');
});

test('newerTermSeen clears a vote granted to n1 in an older term', async () => {
  const h = await createHost();
  await h.voteRequested('n1', 1);
  await h.newerTermSeen(2);
  const n = await h.node();
  assert.equal(n.term, 2);
  assert.equal(n.votedFor, 'nobody');
});

test('a refused newerTermSeen keeps the vote', async () => {
  const h = await createHost();
  await h.voteRequested('n2', 2);
  await refusedUnchanged(h, () => h.newerTermSeen(2));
  assert.equal((await h.node()).votedFor, 'n2');
});

// ---------------------------------------------------------------- voteRequested: newer term

test('voteRequested from n1 in a newer term is granted', async () => {
  const h = await createHost();
  const r = await h.voteRequested('n1', 1);
  assert.equal(r.ok, true);
});

test('voteRequested in a newer term records the vote for n1', async () => {
  const h = await createHost();
  await h.voteRequested('n1', 1);
  assert.equal((await h.node()).votedFor, 'n1');
});

test('voteRequested in a newer term records the vote for n2', async () => {
  const h = await createHost();
  assert.equal((await h.voteRequested('n2', 1)).ok, true);
  assert.equal((await h.node()).votedFor, 'n2');
});

test('voteRequested in a newer term moves the node to that term', async () => {
  const h = await createHost();
  await h.voteRequested('n1', 2);
  assert.equal((await h.node()).term, 2);
});

test('voteRequested can jump from term 0 to term 3', async () => {
  const h = await createHost();
  assert.equal((await h.voteRequested('n2', 3)).ok, true);
  const n = await h.node();
  assert.equal(n.role, 'follower');
  assert.equal(n.term, 3);
  assert.equal(n.votedFor, 'n2');
});

test('voteRequested in a newer term keeps a follower a follower', async () => {
  const h = await createHost();
  await h.voteRequested('n1', 1);
  assert.equal((await h.node()).role, 'follower');
});

test('voteRequested in a newer term makes a candidate a follower and grants', async () => {
  const h = await createHost();
  await h.electionTimeout();
  const r = await h.voteRequested('n1', 2);
  assert.equal(r.ok, true);
  const n = await h.node();
  assert.equal(n.role, 'follower');
  assert.equal(n.term, 2);
  assert.equal(n.votedFor, 'n1');
});

test('voteRequested in a newer term makes the leader a follower and grants', async () => {
  const h = await createHost();
  await toLeader(h);
  const r = await h.voteRequested('n2', 3);
  assert.equal(r.ok, true);
  const n = await h.node();
  assert.equal(n.role, 'follower');
  assert.equal(n.term, 3);
  assert.equal(n.votedFor, 'n2');
});

test('voteRequested in a newer term is granted after voting for another candidate in an older term', async () => {
  const h = await createHost();
  await h.voteRequested('n1', 1);
  const r = await h.voteRequested('n2', 2);
  assert.equal(r.ok, true);
  const n = await h.node();
  assert.equal(n.term, 2);
  assert.equal(n.votedFor, 'n2');
});

test('voteRequested in a newer term is granted to a follower that stepped down as leader', async () => {
  const h = await createHost();
  await toLeader(h);
  await h.quorumLost();
  assert.equal((await h.voteRequested('n1', 2)).ok, true);
  const n = await h.node();
  assert.equal(n.term, 2);
  assert.equal(n.votedFor, 'n1');
});

// ---------------------------------------------------------------- voteRequested: the node's own term

test('voteRequested in its own term is granted by a follower that has not voted', async () => {
  const h = await createHost();
  await h.newerTermSeen(2);
  const r = await h.voteRequested('n1', 2);
  assert.equal(r.ok, true);
});

test('a vote granted in its own term records the candidate and keeps term and role', async () => {
  const h = await createHost();
  await h.newerTermSeen(2);
  await h.voteRequested('n2', 2);
  const n = await h.node();
  assert.equal(n.role, 'follower');
  assert.equal(n.term, 2);
  assert.equal(n.votedFor, 'n2');
});

test('voteRequested in its own term is granted again to the same candidate', async () => {
  const h = await createHost();
  await h.voteRequested('n1', 1);
  const r = await h.voteRequested('n1', 1);
  assert.equal(r.ok, true);
  const n = await h.node();
  assert.equal(n.role, 'follower');
  assert.equal(n.term, 1);
  assert.equal(n.votedFor, 'n1');
});

test('voteRequested in its own term is refused when the follower voted for the other candidate', async () => {
  const h = await createHost();
  await h.voteRequested('n1', 1);
  await refusedUnchanged(h, () => h.voteRequested('n2', 1));
  assert.equal((await h.node()).votedFor, 'n1');
});

test('voteRequested from n1 is refused after voting for n2 in the same term', async () => {
  const h = await createHost();
  await h.newerTermSeen(3);
  await h.voteRequested('n2', 3);
  await refusedUnchanged(h, () => h.voteRequested('n1', 3));
});

test('voteRequested in its own term is refused by a follower that voted for itself', async () => {
  const h = await createHost();
  await toLeader(h);
  await h.quorumLost();
  await refusedUnchanged(h, () => h.voteRequested('n1', 1));
  await refusedUnchanged(h, () => h.voteRequested('n2', 1));
});

test('voteRequested in its own term is refused by a candidate', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await refusedUnchanged(h, () => h.voteRequested('n1', 1));
  assert.equal((await h.node()).role, 'candidate');
});

test('voteRequested in its own term is refused by the leader', async () => {
  const h = await createHost();
  await toLeader(h);
  await refusedUnchanged(h, () => h.voteRequested('n2', 1));
  assert.equal((await h.node()).role, 'leader');
});

test('voteRequested in its own term is refused by a candidate in term 3', async () => {
  const h = await createHost();
  for (let i = 0; i < 3; i++) await h.electionTimeout();
  await refusedUnchanged(h, () => h.voteRequested('n1', 3));
});

// ---------------------------------------------------------------- voteRequested: older term, shut down

test('voteRequested for an older term is refused by a follower', async () => {
  const h = await createHost();
  await h.newerTermSeen(2);
  await refusedUnchanged(h, () => h.voteRequested('n1', 1));
  assert.equal((await h.node()).votedFor, 'nobody');
});

test('voteRequested for an older term is refused by a candidate', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.electionTimeout();
  await refusedUnchanged(h, () => h.voteRequested('n2', 1));
});

test('voteRequested for an older term is refused by the leader', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.electionTimeout();
  await h.electionWon();
  await refusedUnchanged(h, () => h.voteRequested('n1', 1));
});

test('voteRequested for an older term is refused even after voting for that candidate then', async () => {
  const h = await createHost();
  await h.voteRequested('n1', 1);
  await h.newerTermSeen(2);
  await refusedUnchanged(h, () => h.voteRequested('n1', 1));
});

test('voteRequested is refused once shut down', async () => {
  const h = await createHost();
  await h.shutdown();
  for (const c of ['n1', 'n2']) for (const t of [1, 2, 3]) {
    await refusedUnchanged(h, () => h.voteRequested(c, t));
  }
  const n = await h.node();
  assert.equal(n.role, 'shutdown');
  assert.equal(n.term, 0);
});

test('voteRequested is refused by a shut down node that had voted in its term', async () => {
  const h = await createHost();
  await h.voteRequested('n1', 1);
  await h.shutdown();
  await refusedUnchanged(h, () => h.voteRequested('n1', 1));
  await refusedUnchanged(h, () => h.voteRequested('n2', 2));
});

// ---------------------------------------------------------------- votes interacting with other commands

test('at most one vote per term: n1 then n2 in term 1, n2 granted only in term 2', async () => {
  const h = await createHost();
  assert.equal((await h.voteRequested('n1', 1)).ok, true);
  assert.equal((await h.voteRequested('n2', 1)).ok, false);
  assert.equal((await h.voteRequested('n2', 2)).ok, true);
  const n = await h.node();
  assert.equal(n.term, 2);
  assert.equal(n.votedFor, 'n2');
});

test('a node that voted in term 3 cannot start an election', async () => {
  const h = await createHost();
  await h.voteRequested('n1', 3);
  await refusedUnchanged(h, () => h.electionTimeout());
});

test('a candidate that granted a vote in a newer term cannot win', async () => {
  const h = await createHost();
  await h.electionTimeout();
  await h.voteRequested('n1', 2);
  await refusedUnchanged(h, () => h.electionWon());
});

test('a leader that granted a vote in a newer term cannot lose its quorum', async () => {
  const h = await createHost();
  await toLeader(h);
  await h.voteRequested('n2', 2);
  await refusedUnchanged(h, () => h.quorumLost());
});

test('a candidate in term 1 that voted for itself refuses n1 in term 1 but grants n1 in term 2', async () => {
  const h = await createHost();
  await h.electionTimeout();
  assert.equal((await h.voteRequested('n1', 1)).ok, false);
  assert.equal((await h.voteRequested('n1', 2)).ok, true);
  const n = await h.node();
  assert.equal(n.role, 'follower');
  assert.equal(n.votedFor, 'n1');
});

test('shutdown keeps the term after a granted vote', async () => {
  const h = await createHost();
  await h.voteRequested('n1', 2);
  assert.equal((await h.shutdown()).ok, true);
  const n = await h.node();
  assert.equal(n.role, 'shutdown');
  assert.equal(n.term, 2);
});

test('a refused electionTimeout keeps the vote', async () => {
  const h = await createHost();
  await h.voteRequested('n1', 3);
  await h.electionTimeout();
  assert.equal((await h.node()).votedFor, 'n1');
});

// ---------------------------------------------------------------- conclusion: invariants over command sequences

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pickCommand(rand) {
  const options = [
    ['electionTimeout', []], ['electionTimeout', []], ['electionTimeout', []],
    ['electionWon', []], ['electionWon', []],
    ['newerTermSeen', [1]], ['newerTermSeen', [2]], ['newerTermSeen', [3]],
    ['quorumLost', []], ['quorumLost', []],
  ];
  if (VERSION >= 1) {
    for (const c of ['n1', 'n2']) for (const t of [1, 2, 3]) options.push(['voteRequested', [c, t]]);
  }
  if (VERSION >= 2) options.push(['electionLost', []], ['electionLost', []]);
  if (VERSION >= 3) options.push(['pause', []], ['pause', []], ['resume', []], ['resume', []]);
  if (rand() < 0.03) return ['shutdown', []];
  return options[Math.floor(rand() * options.length)];
}

const ROLES = ['follower', 'candidate', 'leader', 'shutdown'];
const VOTES = ['nobody', 'itself', 'n1', 'n2'];

async function checkedStep(h, name, args) {
  const b = await snap(h);
  const r = await h[name](...args);
  const a = await snap(h);
  const where = name + '(' + args.join(',') + ') from ' + JSON.stringify(b);
  assert.ok(ROLES.includes(a.role), 'role in range after ' + where);
  assert.ok(Number.isInteger(a.term) && a.term >= 0 && a.term <= 3, 'term 0..3 after ' + where);
  if (b.role === 'shutdown') {
    assert.equal(r.ok, false, 'shut down node refuses ' + where);
  }
  if (r.ok !== true) {
    assert.equal(r.ok, false);
    assert.deepEqual(a, b, 'refused command changes nothing: ' + where);
    return;
  }
  assert.ok(a.term >= b.term, 'term never goes down: ' + where);
  if (a.term !== b.term) {
    const byElection = name === 'electionTimeout' && a.term === b.term + 1;
    const byNewer = name === 'newerTermSeen' && a.term === args[0];
    const byVote = name === 'voteRequested' && a.term === args[1];
    assert.ok(byElection || byNewer || byVote, 'term changes only by an election or a newer term: ' + where);
  }
  if (a.role === 'leader' && b.role !== 'leader') {
    assert.equal(name, 'electionWon', 'only electionWon makes a leader: ' + where);
    assert.equal(b.role, 'candidate', 'a leader was a candidate first: ' + where);
    assert.equal(a.term, b.term, 'a leader was a candidate in its own term: ' + where);
  }
  if (a.role === 'shutdown') {
    assert.equal(a.term, b.term, 'shutdown keeps the term: ' + where);
  }
  if (VERSION >= 1 && a.role !== 'shutdown' && b.role !== 'shutdown') {
    assert.ok(VOTES.includes(a.votedFor), 'votedFor in range after ' + where);
    if (a.role === 'candidate' || a.role === 'leader') {
      assert.equal(a.votedFor, 'itself', 'a candidate or leader voted for itself: ' + where);
    }
    if (a.term === b.term && b.votedFor !== 'nobody') {
      assert.equal(a.votedFor, b.votedFor, 'at most one vote per term: ' + where);
    }
  }
  if (VERSION >= 3 && a.role !== 'shutdown' && b.role !== 'shutdown') {
    assert.equal(typeof a.paused, 'boolean');
    if (a.paused !== b.paused) {
      assert.ok(name === 'pause' || name === 'resume', 'only pause and resume change paused: ' + where);
    }
    if (a.paused) assert.equal(a.role, 'follower', 'a paused node is a follower: ' + where);
  }
}

for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
  test('invariants hold over a mixed command sequence (seed ' + seed + ')', async () => {
    const h = await createHost();
    const rand = rng(seed);
    for (let i = 0; i < 40; i++) {
      const [name, args] = pickCommand(rand);
      await checkedStep(h, name, args);
    }
  });
}

test('invariants hold when the node is shut down midway and commands keep coming', async () => {
  const h = await createHost();
  const rand = rng(777);
  for (let i = 0; i < 10; i++) {
    const [name, args] = pickCommand(rand);
    if (name !== 'shutdown') await checkedStep(h, name, args);
  }
  await checkedStep(h, 'shutdown', []);
  const frozen = await snap(h);
  assert.equal(frozen.role, 'shutdown');
  for (let i = 0; i < 20; i++) {
    const [name, args] = pickCommand(rand);
    const r = await h[name](...args);
    assert.equal(r.ok, false);
    assert.deepEqual(await snap(h), frozen);
  }
});
