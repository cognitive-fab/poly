// Electing a leader among three nodes, in one term (T9). Each node holds its own address and its two peers'.
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, invariant, configuration, instance,
  implies,
} from '@cognitive-fab/poly/embed';

export default module('election', [
  enumType('Role', ['follower', 'candidate', 'leader']),
  // A node is a long-lived server: it is never terminal, and keeps answering RequestVote after the election.
  machine('Node', {
    service: true,
    state: {
      role: field(t.named('Role'), ($) => $.follower),
      term: field(t.range(0, 1), () => 0),
      votedFor: field(t.ref('Node'), ($) => $.none),
      votes: field(t.range(0, 3), () => 0),
      // The leader this node knows in its term (the query's `leader`; `leader` itself is a Role).
      knownLeader: field(t.ref('Node'), ($) => $.none),
      me: field(t.ref('Node'), ($) => $.none),
      peerA: field(t.ref('Node'), ($) => $.none),
      peerB: field(t.ref('Node'), ($) => $.none),
    },
    items: [
      action('Timeout', {}),
      action('RequestVote', { from: t.ref('Node'), term: t.range(1, 1) }),
      action('VoteReply', { term: t.range(1, 1), granted: t.bool }),
      action('Leader', { from: t.ref('Node'), term: t.range(1, 1) }),
      on('Timeout', ($) => [
        require($.role === $.follower, 'not-follower'),
        require($.term === 0, 'already-in-term'),
        set('role', $.candidate),
        set('term', 1),
        set('votedFor', $.me),
        set('votes', 1),
        send($.peerA, 'RequestVote', { from: $.self, term: 1 }),
        send($.peerB, 'RequestVote', { from: $.self, term: 1 }),
      ]),
      on('RequestVote', ($) => [
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
        require($.role === $.candidate, 'not-candidate'),
        require($.term === $.pre.term && $.pre.term === 1, 'other-term'),
        require($.granted, 'not-granted'),
        set('votes', $.votes + 1),
        when($.votes + 1 >= 2, [
          set('role', $.leader),
          set('knownLeader', $.me),
          send($.peerA, 'Leader', { from: $.self, term: 1 }),
          send($.peerB, 'Leader', { from: $.self, term: 1 }),
        ]),
      ]),
      // Only one node leads in a term, so a leader never hears Leader; a candidate steps down, keeping its vote.
      on('Leader', ($) => [
        require($.role !== $.leader, 'is-leader'),
        set('knownLeader', $.from),
        set('term', 1),
        set('role', $.follower),
      ]),
      invariant('leader-has-majority', ($) => implies($.role === $.leader, $.votes >= 2)),
      invariant('leader-knows-itself', ($) => implies($.role === $.leader, $.knownLeader === $.me)),
      invariant('candidate-votes-self', ($) => implies($.role !== $.follower, $.votedFor === $.me && $.term === 1)),
    ],
  }),
  configuration('three-nodes', {
    instances: [
      instance('n0', 'Node', { init: ($) => ({ me: $.n0, peerA: $.n1, peerB: $.n2 }) }),
      instance('n1', 'Node', { init: ($) => ({ me: $.n1, peerA: $.n0, peerB: $.n2 }) }),
      instance('n2', 'Node', { init: ($) => ({ me: $.n2, peerA: $.n0, peerB: $.n1 }) }),
    ],
    inputs: ['n0.Timeout', 'n1.Timeout', 'n2.Timeout'],
    bounds: { transit: 6 },
    properties: [
      invariant('one-leader', ($) =>
        !($.n0.role === $.leader && $.n1.role === $.leader) &&
        !($.n0.role === $.leader && $.n2.role === $.leader) &&
        !($.n1.role === $.leader && $.n2.role === $.leader)),
      invariant('leader-holds-majority', ($) =>
        implies($.n0.role === $.leader, $.n1.votedFor === $.n0.me || $.n2.votedFor === $.n0.me) &&
        implies($.n1.role === $.leader, $.n0.votedFor === $.n1.me || $.n2.votedFor === $.n1.me) &&
        implies($.n2.role === $.leader, $.n0.votedFor === $.n2.me || $.n1.votedFor === $.n2.me)),
    ],
  }),
]);
