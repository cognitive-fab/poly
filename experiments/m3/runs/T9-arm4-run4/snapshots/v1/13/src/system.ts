// T9: electing a leader among three nodes, one election round (term 1).
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, invariant, stepProperty,
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
      // The leader the node knows in its term (`leader` is taken by the Role constructor).
      knownLeader: field(t.ref('Node'), ($) => $.none),
      // The node's own address and its two peers', set when the system is created.
      me: field(t.ref('Node'), ($) => $.none),
      peerA: field(t.ref('Node'), ($) => $.none),
      peerB: field(t.ref('Node'), ($) => $.none),
    },
    items: [
      action('Timeout', {}),
      action('RequestVote', { from: t.ref('Node'), term: t.int.check([1]) }),
      action('VoteReply', { term: t.int.check([1]), granted: t.bool }),
      action('Leader', { from: t.ref('Node'), term: t.int.check([1]) }),

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
        // Here `term` is the message's (always 1). A node is in term 0 exactly when it has not voted, so
        // "a term-0 node, or a term-1 follower that has not voted or voted for this candidate" is this test.
        require($.term === 1, 'not-term-1'),
        when($.role === $.follower && ($.votedFor === $.none || $.votedFor === $.from), [
          set('term', 1),
          set('votedFor', $.from),
          send($.from, 'VoteReply', { term: 1, granted: true }),
        ], [
          send($.from, 'VoteReply', { term: 1, granted: false }),
        ]),
      ], ['from', 'term']),

      on('VoteReply', ($) => [
        // Any reply other than a granted vote to a candidate is ignored: refused, it changes nothing.
        // `term` is the reply's; a candidate is always in term 1.
        require($.role === $.candidate && $.term === 1, 'not-a-candidate'),
        require($.granted, 'vote-not-granted'),
        set('votes', $.votes + 1),
        when($.votes + 1 >= 2, [
          set('role', $.leader),
          set('knownLeader', $.me),
          send($.peerA, 'Leader', { from: $.self, term: 1 }),
          send($.peerB, 'Leader', { from: $.self, term: 1 }),
        ]),
      ], ['term', 'granted']),

      on('Leader', ($) => [
        // `term` is the message's (always 1). A term-0 node moves to term 1 without voting; a candidate
        // steps down and keeps its vote for itself.
        require($.term === 1, 'not-term-1'),
        require($.role !== $.leader, 'already-leader'),
        set('term', 1),
        set('role', $.follower),
        set('knownLeader', $.from),
      ], ['from', 'term']),

      invariant('candidate-voted-for-itself', ($) => implies($.role !== $.follower, $.votedFor === $.me && $.term === 1)),
      invariant('leader-has-majority', ($) => implies($.role === $.leader, $.votes >= 2)),
      stepProperty('votes-once', ($) => implies($.pre.votedFor !== $.none, $.post.votedFor === $.pre.votedFor)),
      invariant('vote-in-term', ($) => implies($.votedFor !== $.none, $.term === 1)),
      invariant('leader-in-term', ($) => implies($.knownLeader !== $.none, $.term === 1)),
      invariant('leader-knows-itself', ($) => implies($.role === $.leader, $.knownLeader === $.me)),
      invariant('candidate-knows-no-leader', ($) => implies($.role === $.candidate, $.knownLeader === $.none)),
    ],
  }),
  configuration('three-nodes', {
    instances: [
      instance('n0', 'Node', { init: ($) => ({ me: $.n0, peerA: $.n1, peerB: $.n2 }) }),
      instance('n1', 'Node', { init: ($) => ({ me: $.n1, peerA: $.n0, peerB: $.n2 }) }),
      instance('n2', 'Node', { init: ($) => ({ me: $.n2, peerA: $.n0, peerB: $.n1 }) }),
    ],
    inputs: ['n0.Timeout', 'n1.Timeout', 'n2.Timeout'],
    bounds: { transit: 10 },
    properties: [
      invariant('at-most-one-leader', ($) =>
        !($.n0.role === $.leader && $.n1.role === $.leader) &&
        !($.n0.role === $.leader && $.n2.role === $.leader) &&
        !($.n1.role === $.leader && $.n2.role === $.leader)),
      invariant('leader-holds-majority-n0', ($) => implies($.n0.role === $.leader,
        ($.n1.votedFor === $.n0.me || $.n2.votedFor === $.n0.me))),
      invariant('leader-holds-majority-n1', ($) => implies($.n1.role === $.leader,
        ($.n0.votedFor === $.n1.me || $.n2.votedFor === $.n1.me))),
      invariant('leader-holds-majority-n2', ($) => implies($.n2.role === $.leader,
        ($.n0.votedFor === $.n2.me || $.n1.votedFor === $.n2.me))),
      // A node knows only the node that really leads.
      invariant('known-leader-n0', ($) => implies($.n1.knownLeader === $.n0.me || $.n2.knownLeader === $.n0.me, $.n0.role === $.leader)),
      invariant('known-leader-n1', ($) => implies($.n0.knownLeader === $.n1.me || $.n2.knownLeader === $.n1.me, $.n1.role === $.leader)),
      invariant('known-leader-n2', ($) => implies($.n0.knownLeader === $.n2.me || $.n1.knownLeader === $.n2.me, $.n2.role === $.leader)),
    ],
  }),
]);
