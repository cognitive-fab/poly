// T9, electing a leader among three nodes: one election round, term 1.
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, let_, invariant,
  configuration, instance, implies, stepProperty,
} from '@cognitive-fab/poly/embed';

export default module('election', [
  enumType('Role', ['follower', 'candidate', 'leader']),
  // A service: after one round a node may stay in term 1 without a leader (a split vote), and must still answer.
  machine('Node', {
    service: true,
    state: {
      me: field(t.ref('Node'), ($) => $.none),
      p1: field(t.ref('Node'), ($) => $.none),
      p2: field(t.ref('Node'), ($) => $.none),
      role: field(t.named('Role'), ($) => $.follower),
      // Not named `term`: the messages' parameter `term` would shadow it in their handlers.
      currentTerm: field(t.range(0, 1), () => 0),
      votedFor: field(t.ref('Node'), ($) => $.none),
      votes: field(t.range(0, 3), () => 0),
    },
    items: [
      action('Timeout', {}),
      action('RequestVote', { from: t.ref('Node'), term: t.range(1, 1) }),
      action('VoteReply', { term: t.range(1, 1), granted: t.bool }),

      on('Timeout', ($) => [
        require($.role === $.follower && $.currentTerm === 0, 'not-a-follower-in-term-0'),
        set('role', $.candidate),
        set('currentTerm', 1),
        set('votedFor', $.me),
        set('votes', 1),
        send($.p1, 'RequestVote', { from: $.me, term: 1 }),
        send($.p2, 'RequestVote', { from: $.me, term: 1 }),
      ]),

      on('RequestVote', ($) => [
        when($.currentTerm === 0, [
          set('currentTerm', 1),
          set('role', $.follower),
          set('votedFor', $.from),
          send($.from, 'VoteReply', { term: 1, granted: true }),
        ], [
          let_('grant', $.role === $.follower && ($.votedFor === $.none || $.votedFor === $.from)),
          when($.grant, [
            set('votedFor', $.from),
            send($.from, 'VoteReply', { term: 1, granted: true }),
          ], [
            send($.from, 'VoteReply', { term: 1, granted: false }),
          ]),
        ]),
      ]),

      on('VoteReply', ($) => [
        require($.role === $.candidate && $.term === $.currentTerm, 'not-a-candidate'),
        require($.granted, 'not-granted'),
        require($.votes < 3, 'votes-full'),
        set('votes', $.votes + 1),
        when($.votes + 1 >= 2, [
          set('role', $.leader),
          set('leader', $.me),
          send($.p1, 'Leader', { from: $.me, term: 1 }),
          send($.p2, 'Leader', { from: $.me, term: 1 }),
        ]),
      ]),

      on('Leader', ($) => [
        require($.role !== $.leader, 'already-leader'),
        set('leader', $.from),
        set('currentTerm', 1),
        set('role', $.follower),
      ]),

      invariant('leader-has-majority', ($) => implies($.role === $.leader, $.votes >= 2 && $.votedFor === $.me)),
      stepProperty('votes-once', ($) => implies($.pre.votedFor !== $.none, $.post.votedFor === $.pre.votedFor)),
      invariant('candidate-voted-self', ($) => implies($.role === $.candidate, $.votedFor === $.me)),
    ],
  }),
  configuration('three-nodes', {
    instances: [
      instance('n0', 'Node', { init: ($) => ({ me: $.n0, p1: $.n1, p2: $.n2 }) }),
      instance('n1', 'Node', { init: ($) => ({ me: $.n1, p1: $.n0, p2: $.n2 }) }),
      instance('n2', 'Node', { init: ($) => ({ me: $.n2, p1: $.n0, p2: $.n1 }) }),
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
