// Electing a leader among three nodes: one election round, term 1.
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, invariant, implies,
  configuration, instance,
} from '@cognitive-fab/poly/embed';

export default module('election', [
  enumType('Role', ['follower', 'candidate', 'leader']),
  machine('Node', {
    service: true,
    state: {
      role: field(t.named('Role'), ($) => $.follower),
      term: field(t.range(0, 1), () => 0),
      votedFor: field(t.ref('Node'), ($) => $.none),
      votes: field(t.range(0, 2), () => 0),
      leader: field(t.ref('Node'), ($) => $.none),
      // The node's own address and its two peers, set when the system is created.
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
        require($.role === $.follower && $.term === 0, 'not-a-follower-in-term-0'),
        set('role', $.candidate),
        set('term', 1),
        set('votedFor', $.me),
        set('votes', 1),
        send($.peerA, 'RequestVote', { from: $.me, term: 1 }),
        send($.peerB, 'RequestVote', { from: $.me, term: 1 }),
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
        require($.role === $.candidate && $.pre.term === 1 && $.granted, 'vote-ignored'),
        set('votes', 2),
        set('role', $.leader),
        set('leader', $.me),
        send($.peerA, 'Leader', { from: $.me, term: 1 }),
        send($.peerB, 'Leader', { from: $.me, term: 1 }),
      ]),

      // A leader never receives Leader: only one node leads in a term.
      on('Leader', ($) => [
        require($.role !== $.leader, 'already-leader'),
        set('leader', $.from),
        when($.pre.term === 0, [set('term', 1)]),
        when($.role === $.candidate, [set('role', $.follower)]),
      ]),

      invariant('leader-knows-itself', ($) => implies($.role === $.leader, $.leader === $.me)),
      invariant('term-0-knows-no-leader', ($) => implies($.term === 0, $.leader === $.none)),

      invariant('leader-has-majority', ($) => implies($.role === $.leader, $.votes === 2 && $.votedFor === $.me)),
      invariant('candidate-voted-for-itself', ($) => implies($.role === $.candidate, $.votedFor === $.me && $.term === 1)),
      invariant('term-0-has-no-vote', ($) => implies($.term === 0, $.votedFor === $.none && $.role === $.follower)),
    ],
  }),
  configuration('three', {
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
      invariant('n0-leader-holds-majority', ($) =>
        implies($.n0.role === $.leader, $.n1.votedFor === $.n0.me || $.n2.votedFor === $.n0.me)),
      invariant('n1-leader-holds-majority', ($) =>
        implies($.n1.role === $.leader, $.n0.votedFor === $.n1.me || $.n2.votedFor === $.n1.me)),
      invariant('n2-leader-holds-majority', ($) =>
        implies($.n2.role === $.leader, $.n0.votedFor === $.n2.me || $.n1.votedFor === $.n2.me)),
    ],
  }),
]);
