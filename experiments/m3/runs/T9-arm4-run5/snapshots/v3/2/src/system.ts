// Electing a leader among three nodes: one election round, term 1. Nodes may crash and recover; the term,
// the vote and the known leader survive a crash.
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, invariant, implies,
  configuration, instance,
} from '@cognitive-fab/poly/embed';

export default module('election', [
  enumType('Role', ['follower', 'candidate', 'leader', 'down']),
  machine('Node', {
    service: true,
    state: {
      role: field(t.named('Role'), ($) => $.follower),
      term: field(t.range(0, 1), () => 0),
      votedFor: field(t.ref('Node'), ($) => $.none),
      // Votes counted as a candidate; 2 records that the node won the term, even after it crashed.
      votes: field(t.range(0, 2), () => 0),
      // The leader the node knows in its term (the query's `leader`).
      knownLeader: field(t.ref('Node'), ($) => $.none),
      // The node's own address and its two peers, set when the system is created.
      me: field(t.ref('Node'), ($) => $.none),
      peerA: field(t.ref('Node'), ($) => $.none),
      peerB: field(t.ref('Node'), ($) => $.none),
    },
    items: [
      action('Timeout', {}),
      action('GiveUp', {}),
      action('Crash', {}),
      action('Recover', {}),
      action('RequestVote', { from: t.ref('Node'), term: t.range(1, 1) }),
      action('VoteReply', { term: t.range(1, 1), granted: t.bool }),
      action('Leader', { from: t.ref('Node'), term: t.range(1, 1) }),

      on('Timeout', ($) => [
        require($.role === $.follower && $.term === 0, 'not-a-follower-in-term-0'),
        set('role', $.candidate),
        set('term', 1),
        set('votedFor', $.me),
        set('votes', 1),
        send($.peerA, 'RequestVote', { from: $.me, term: 1 }),
        send($.peerB, 'RequestVote', { from: $.me, term: 1 }),
      ]),

      // The node keeps its vote for itself, so it grants no other vote in the term; as a follower it
      // ignores any VoteReply that arrives later.
      on('GiveUp', ($) => [
        require($.role === $.candidate, 'not-a-candidate'),
        set('role', $.follower),
      ]),

      on('Crash', ($) => [
        require($.role !== $.down, 'already-down'),
        set('role', $.down),
      ]),

      // Term, vote and known leader are kept; a leader or a candidate comes back as a follower.
      on('Recover', ($) => [
        require($.role === $.down, 'not-down'),
        set('role', $.follower),
      ]),

      on('RequestVote', ($) => [
        require($.role !== $.down, 'down'),
        when($.pre.term === 0, [
          set('term', 1),
          set('votedFor', $.from),
          send($.from, 'VoteReply', { term: 1, granted: true }),
        ], [
          when($.role === $.follower && ($.votedFor === $.none || $.votedFor === $.from), [
            set('votedFor', $.from),
            send($.from, 'VoteReply', { term: 1, granted: true }),
          ], [
            send($.from, 'VoteReply', { term: 1, granted: false }),
          ]),
        ]),
      ]),

      on('VoteReply', ($) => [
        require($.role === $.candidate && $.pre.term === 1 && $.granted, 'vote-ignored'),
        set('votes', 2),
        set('role', $.leader),
        set('knownLeader', $.me),
        send($.peerA, 'Leader', { from: $.me, term: 1 }),
        send($.peerB, 'Leader', { from: $.me, term: 1 }),
      ]),

      // A leader never receives Leader: only one node leads in a term.
      on('Leader', ($) => [
        require($.role !== $.leader && $.role !== $.down, 'leader-ignored'),
        set('knownLeader', $.from),
        when($.pre.term === 0, [set('term', 1)]),
        when($.role === $.candidate, [set('role', $.follower)]),
      ]),

      invariant('leader-knows-itself', ($) => implies($.votes === 2, $.knownLeader === $.me)),
      invariant('term-0-knows-no-leader', ($) => implies($.term === 0, $.knownLeader === $.none)),

      invariant('leader-has-majority', ($) => implies($.role === $.leader, $.votes === 2 && $.votedFor === $.me)),
      invariant('candidate-voted-for-itself', ($) => implies($.role === $.candidate, $.votedFor === $.me && $.term === 1)),
      invariant('term-0-has-no-vote', ($) =>
        implies($.term === 0, $.votedFor === $.none && $.votes === 0 && $.role !== $.candidate && $.role !== $.leader)),
    ],
  }),
  configuration('three', {
    instances: [
      instance('n0', 'Node', { init: ($) => ({ me: $.n0, peerA: $.n1, peerB: $.n2 }) }),
      instance('n1', 'Node', { init: ($) => ({ me: $.n1, peerA: $.n0, peerB: $.n2 }) }),
      instance('n2', 'Node', { init: ($) => ({ me: $.n2, peerA: $.n0, peerB: $.n1 }) }),
    ],
    inputs: [
      'n0.Timeout', 'n1.Timeout', 'n2.Timeout', 'n0.GiveUp', 'n1.GiveUp', 'n2.GiveUp',
      'n0.Crash', 'n1.Crash', 'n2.Crash', 'n0.Recover', 'n1.Recover', 'n2.Recover',
    ],
    bounds: { transit: 6 },
    // `votes == 2` marks the node that won term 1, whether it still leads or crashed since.
    properties: [
      invariant('known-leader-is-n0-winner', ($) =>
        implies($.n1.knownLeader === $.n0.me || $.n2.knownLeader === $.n0.me, $.n0.votes === 2)),
      invariant('known-leader-is-n1-winner', ($) =>
        implies($.n0.knownLeader === $.n1.me || $.n2.knownLeader === $.n1.me, $.n1.votes === 2)),
      invariant('known-leader-is-n2-winner', ($) =>
        implies($.n0.knownLeader === $.n2.me || $.n1.knownLeader === $.n2.me, $.n2.votes === 2)),
      invariant('at-most-one-winner', ($) =>
        !($.n0.votes === 2 && $.n1.votes === 2) &&
        !($.n0.votes === 2 && $.n2.votes === 2) &&
        !($.n1.votes === 2 && $.n2.votes === 2)),
      invariant('n0-winner-holds-majority', ($) =>
        implies($.n0.votes === 2, $.n0.votedFor === $.n0.me && ($.n1.votedFor === $.n0.me || $.n2.votedFor === $.n0.me))),
      invariant('n1-winner-holds-majority', ($) =>
        implies($.n1.votes === 2, $.n1.votedFor === $.n1.me && ($.n0.votedFor === $.n1.me || $.n2.votedFor === $.n1.me))),
      invariant('n2-winner-holds-majority', ($) =>
        implies($.n2.votes === 2, $.n2.votedFor === $.n2.me && ($.n0.votedFor === $.n2.me || $.n1.votedFor === $.n2.me))),
    ],
  }),
]);
