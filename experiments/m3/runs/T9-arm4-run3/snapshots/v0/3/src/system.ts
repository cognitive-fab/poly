// Electing a leader among three nodes, one election round (term 1).
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, invariant,
  configuration, instance, implies, count,
} from '@cognitive-fab/poly/embed';

export default module('election', [
  enumType('Role', ['follower', 'candidate', 'leader']),
  machine('Node', {
    state: {
      role: field(t.named('Role'), ($) => $.follower),
      term: field(t.range(0, 1), () => 0),
      votedFor: field(t.ref('Node'), ($) => $.none),
      votes: field(t.range(0, 3), () => 0),
      // This node's own address and its two peers', set when the system is created.
      me: field(t.ref('Node'), ($) => $.none),
      peerA: field(t.ref('Node'), ($) => $.none),
      peerB: field(t.ref('Node'), ($) => $.none),
    },
    items: [
      action('Timeout', {}),
      action('RequestVote', { from: t.ref('Node'), term: t.range(1, 1) }),
      action('VoteReply', { term: t.range(1, 1), granted: t.bool }),

      on('Timeout', ($) => [
        require($.role === $.follower && $.term === 0, 'not-a-follower-in-term-0'),
        set('role', $.candidate),
        set('term', 1),
        set('votedFor', $.me),
        set('votes', 1),
        send($.peerA, 'RequestVote', { from: $.self, term: 1 }),
        send($.peerB, 'RequestVote', { from: $.self, term: 1 }),
      ]),

      on('RequestVote', ($) => [
        when($.term === 0, [
          set('term', 1),
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

      on('VoteReply', ($) => [
        when($.role === $.candidate && $.term === 1 && $.granted && $.votes < 3, [
          set('votes', $.votes + 1),
          when($.votes + 1 >= 2, [set('role', $.leader)]),
        ]),
      ], ['term', 'granted']),

      invariant('term-0-is-follower', ($) => implies($.term === 0, $.role === $.follower && $.votedFor === $.none)),
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
    ],
  }),
]);
