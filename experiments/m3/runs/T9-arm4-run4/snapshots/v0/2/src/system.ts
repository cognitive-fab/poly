// T9: electing a leader among three nodes, one election round (term 1).
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, invariant,
  configuration, instance, implies,
} from '@cognitive-fab/poly/embed';

export default module('election', [
  enumType('Role', ['follower', 'candidate', 'leader']),
  machine('Node', {
    service: true,
    state: {
      role: field(t.named('Role'), ($) => $.follower),
      term: field(t.range(0, 1), () => 0),
      votedFor: field(t.ref('Node'), ($) => $.none),
      votes: field(t.range(0, 3), () => 0),
      // The node's own address and its two peers', set when the system is created.
      me: field(t.ref('Node'), ($) => $.none),
      peerA: field(t.ref('Node'), ($) => $.none),
      peerB: field(t.ref('Node'), ($) => $.none),
    },
    items: [
      action('Timeout', {}),
      action('RequestVote', { from: t.ref('Node'), term: t.int.check([1]) }),
      action('VoteReply', { term: t.int.check([1]), granted: t.bool }),

      on('Timeout', ($) => [
        require($.role === $.follower && $.term === 0, 'not-a-term-0-follower'),
        set('role', $.candidate),
        set('term', 1),
        set('votedFor', $.me),
        set('votes', 1),
        send($.peerA, 'RequestVote', { from: $.self, term: 1 }),
        send($.peerB, 'RequestVote', { from: $.self, term: 1 }),
      ]),

      on('RequestVote', ($) => [
        require($.term <= 1, 'stale-term'),
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
        // Any reply other than a granted vote to a candidate is ignored: refused, it changes nothing.
        require($.role === $.candidate && $.term === 1, 'not-a-candidate'),
        require($.granted, 'vote-not-granted'),
        set('votes', $.votes + 1),
        when($.votes + 1 >= 2, [set('role', $.leader)]),
      ], ['term', 'granted']),

      invariant('candidate-voted-for-itself', ($) => implies($.role !== $.follower, $.votedFor === $.me && $.term === 1)),
      invariant('leader-has-majority', ($) => implies($.role === $.leader, $.votes >= 2)),
      invariant('vote-in-term', ($) => implies($.votedFor !== $.none, $.term === 1)),
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
      invariant('leader-holds-majority-n0', ($) => implies($.n0.role === $.leader,
        ($.n1.votedFor === $.n0 || $.n2.votedFor === $.n0))),
      invariant('leader-holds-majority-n1', ($) => implies($.n1.role === $.leader,
        ($.n0.votedFor === $.n1 || $.n2.votedFor === $.n1))),
      invariant('leader-holds-majority-n2', ($) => implies($.n2.role === $.leader,
        ($.n0.votedFor === $.n2 || $.n1.votedFor === $.n2))),
    ],
  }),
]);
