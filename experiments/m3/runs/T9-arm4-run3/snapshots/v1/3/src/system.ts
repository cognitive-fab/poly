// Electing a leader among three nodes, one election round (term 1).
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, invariant,
  configuration, instance, implies,
} from '@cognitive-fab/poly/embed';

export default module('election', [
  enumType('Role', ['follower', 'candidate', 'leader']),
  // A node is never done: in term 1 it still answers RequestVote, and a split vote leaves no leader.
  machine('Node', {
    service: true,
    state: {
      role: field(t.named('Role'), ($) => $.follower),
      // The node's term; named apart from the messages' `term` parameter, which would shadow it.
      currentTerm: field(t.range(0, 1), () => 0),
      votedFor: field(t.ref('Node'), ($) => $.none),
      votes: field(t.range(0, 3), () => 0),
      // The leader this node knows in its term; a leader knows itself.
      leader: field(t.ref('Node'), ($) => $.none),
      // This node's own address and its two peers', set when the system is created.
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
        require($.role === $.follower && $.currentTerm === 0, 'not-a-follower-in-term-0'),
        set('role', $.candidate),
        set('currentTerm', 1),
        set('votedFor', $.me),
        set('votes', 1),
        send($.peerA, 'RequestVote', { from: $.self, term: 1 }),
        send($.peerB, 'RequestVote', { from: $.self, term: 1 }),
      ]),

      on('RequestVote', ($) => [
        when($.currentTerm === 0, [
          set('currentTerm', 1),
          set('role', $.follower),
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
      ], ['from', 'term']),

      // Only a granted reply to a candidate in term 1 counts; any other reply is ignored.
      on('VoteReply', ($) => [
        require($.role === $.candidate && $.currentTerm === 1 && $.granted && $.votes < 3, 'reply-ignored'),
        set('votes', $.votes + 1),
        when($.votes + 1 >= 2, [
          set('role', $.leader),
          set('leader', $.me),
          send($.peerA, 'Leader', { from: $.self, term: 1 }),
          send($.peerB, 'Leader', { from: $.self, term: 1 }),
        ]),
      ], ['term', 'granted']),

      // The announcement: a node in term 0 joins term 1 without voting, a candidate steps down keeping its vote.
      on('Leader', ($) => [
        require($.role !== $.leader, 'already-leader'),
        set('leader', $.from),
        set('role', $.follower),
        set('currentTerm', 1),
      ], ['from', 'term']),

      invariant('term-0-is-follower', ($) => implies($.currentTerm === 0, $.role === $.follower && $.votedFor === $.none)),
      invariant('leader-has-majority', ($) => implies($.role === $.leader, $.votes >= 2)),
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
      invariant('at-most-one-leader', ($) =>
        !($.n0.role === $.leader && $.n1.role === $.leader) &&
        !($.n0.role === $.leader && $.n2.role === $.leader) &&
        !($.n1.role === $.leader && $.n2.role === $.leader)),
      // A leader holds a majority: its own vote and at least one other node's.
      invariant('leader-holds-majority', ($) =>
        implies($.n0.role === $.leader, $.n0.votedFor === $.n0.me && ($.n1.votedFor === $.n0.me || $.n2.votedFor === $.n0.me)) &&
        implies($.n1.role === $.leader, $.n1.votedFor === $.n1.me && ($.n0.votedFor === $.n1.me || $.n2.votedFor === $.n1.me)) &&
        implies($.n2.role === $.leader, $.n2.votedFor === $.n2.me && ($.n0.votedFor === $.n2.me || $.n1.votedFor === $.n2.me))),
    ],
  }),
]);
