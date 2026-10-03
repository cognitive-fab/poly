// Electing a leader among three nodes, in one term (T9). Each node holds its own address and its two peers'.
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, invariant, configuration, instance,
  implies,
} from '@cognitive-fab/poly/embed';

export default module('election', [
  enumType('Role', ['Follower', 'Candidate', 'Leader']),
  machine('Node', {
    state: {
      role: field(t.named('Role'), ($) => $.Follower),
      term: field(t.range(0, 1), () => 0),
      votedFor: field(t.ref('Node'), ($) => $.none),
      votes: field(t.range(0, 3), () => 0),
      me: field(t.ref('Node'), ($) => $.none),
      peerA: field(t.ref('Node'), ($) => $.none),
      peerB: field(t.ref('Node'), ($) => $.none),
    },
    items: [
      action('Timeout', {}),
      action('RequestVote', { from: t.ref('Node'), term: t.range(1, 1) }),
      action('VoteReply', { term: t.range(1, 1), granted: t.bool }),
      on('Timeout', ($) => [
        require($.role === $.Follower, 'not-follower'),
        require($.term === 0, 'already-in-term'),
        set('role', $.Candidate),
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
          when($.role === $.Follower && ($.votedFor === $.none || $.votedFor === $.from), [
            set('votedFor', $.from),
            send($.from, 'VoteReply', { term: 1, granted: true }),
          ], [
            send($.from, 'VoteReply', { term: 1, granted: false }),
          ]),
        ]),
      ]),
      on('VoteReply', ($) => [
        require($.role === $.Candidate, 'not-candidate'),
        require($.term === $.pre.term && $.pre.term === 1, 'other-term'),
        require($.granted, 'not-granted'),
        set('votes', $.votes + 1),
        when($.votes + 1 >= 2, [set('role', $.Leader)]),
      ]),
      invariant('leader-has-majority', ($) => implies($.role === $.Leader, $.votes >= 2)),
      invariant('candidate-votes-self', ($) => implies($.role !== $.Follower, $.votedFor === $.me && $.term === 1)),
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
        !($.n0.role === $.Leader && $.n1.role === $.Leader) &&
        !($.n0.role === $.Leader && $.n2.role === $.Leader) &&
        !($.n1.role === $.Leader && $.n2.role === $.Leader)),
      invariant('leader-holds-majority', ($) =>
        implies($.n0.role === $.Leader, $.n1.votedFor === $.n0.me || $.n2.votedFor === $.n0.me) &&
        implies($.n1.role === $.Leader, $.n0.votedFor === $.n1.me || $.n2.votedFor === $.n1.me) &&
        implies($.n2.role === $.Leader, $.n0.votedFor === $.n2.me || $.n1.votedFor === $.n2.me)),
    ],
  }),
]);
