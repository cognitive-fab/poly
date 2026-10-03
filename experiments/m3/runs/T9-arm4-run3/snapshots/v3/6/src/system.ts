// Electing a leader among three nodes, one election round (term 1).
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, invariant,
  configuration, instance, implies,
} from '@cognitive-fab/poly/embed';

export default module('election', [
  enumType('Role', ['follower', 'candidate', 'leader', 'down']),
  // A node is never done: in term 1 it still answers RequestVote, and a split vote leaves no leader.
  machine('Node', {
    service: true,
    state: {
      role: field(t.named('Role'), ($) => $.follower),
      // The node's term; named apart from the messages' `term` parameter, which would shadow it.
      currentTerm: field(t.range(0, 1), () => 0),
      votedFor: field(t.ref('Node'), ($) => $.none),
      votes: field(t.range(0, 3), () => 0),
      // The leader this node knows in its term; a leader knows itself. Named apart from the role `leader`.
      knownLeader: field(t.ref('Node'), ($) => $.none),
      // This node's own address and its two peers', set when the system is created.
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
        require($.role === $.follower && $.currentTerm === 0, 'not-a-follower-in-term-0'),
        set('role', $.candidate),
        set('currentTerm', 1),
        set('votedFor', $.me),
        set('votes', 1),
        send($.peerA, 'RequestVote', { from: $.self, term: 1 }),
        send($.peerB, 'RequestVote', { from: $.self, term: 1 }),
      ]),

      // A candidate gives up: a follower in the same term, still voted for itself, so later replies are ignored.
      on('GiveUp', ($) => [
        require($.role === $.candidate, 'not-a-candidate'),
        set('role', $.follower),
      ]),

      // Term, vote and known leader survive a crash; the role does not, so a node recovers as a follower.
      on('Crash', ($) => [
        require($.role !== $.down, 'down'),
        set('role', $.down),
      ]),
      on('Recover', ($) => [
        require($.role === $.down, 'not-down'),
        set('role', $.follower),
      ]),

      // A down node ignores every message delivered to it.
      on('RequestVote', ($) => [
        require($.role !== $.down, 'down'),
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
          set('knownLeader', $.me),
          send($.peerA, 'Leader', { from: $.self, term: 1 }),
          send($.peerB, 'Leader', { from: $.self, term: 1 }),
        ]),
      ], ['term', 'granted']),

      // The announcement: a node in term 0 joins term 1 without voting, a candidate steps down keeping its vote.
      on('Leader', ($) => [
        require($.role !== $.down, 'down'),
        require($.role !== $.leader, 'already-leader'),
        set('knownLeader', $.from),
        set('role', $.follower),
        set('currentTerm', 1),
      ], ['from', 'term']),

      invariant('term-0-is-follower', ($) => implies($.currentTerm === 0, ($.role === $.follower || $.role === $.down) && $.votedFor === $.none && $.knownLeader === $.none)),
      invariant('leader-has-majority', ($) => implies($.role === $.leader, $.votes >= 2)),
      invariant('leader-knows-itself', ($) => implies($.role === $.leader, $.knownLeader === $.me)),
    ],
  }),
  configuration('three-nodes', {
    instances: [
      instance('n0', 'Node', { init: ($) => ({ me: $.n0, peerA: $.n1, peerB: $.n2 }) }),
      instance('n1', 'Node', { init: ($) => ({ me: $.n1, peerA: $.n0, peerB: $.n2 }) }),
      instance('n2', 'Node', { init: ($) => ({ me: $.n2, peerA: $.n0, peerB: $.n1 }) }),
    ],
    inputs: ['n0.Timeout', 'n1.Timeout', 'n2.Timeout', 'n0.GiveUp', 'n1.GiveUp', 'n2.GiveUp'],
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
      // A node that knows a leader knows the one elected, which knows itself (and leads, unless it crashed since).
      invariant('known-leader-was-elected', ($) =>
        implies($.n0.knownLeader === $.n0.me || $.n1.knownLeader === $.n0.me || $.n2.knownLeader === $.n0.me, $.n0.knownLeader === $.n0.me) &&
        implies($.n0.knownLeader === $.n1.me || $.n1.knownLeader === $.n1.me || $.n2.knownLeader === $.n1.me, $.n1.knownLeader === $.n1.me) &&
        implies($.n0.knownLeader === $.n2.me || $.n1.knownLeader === $.n2.me || $.n2.knownLeader === $.n2.me, $.n2.knownLeader === $.n2.me)),
      // At most one node is ever elected in the term, crashes or not.
      invariant('at-most-one-elected', ($) =>
        !($.n0.knownLeader === $.n0.me && $.n1.knownLeader === $.n1.me) &&
        !($.n0.knownLeader === $.n0.me && $.n2.knownLeader === $.n2.me) &&
        !($.n1.knownLeader === $.n1.me && $.n2.knownLeader === $.n2.me)),
      // A node that leads is the one elected.
      invariant('leader-is-elected', ($) =>
        implies($.n0.role === $.leader, $.n0.knownLeader === $.n0.me) &&
        implies($.n1.role === $.leader, $.n1.knownLeader === $.n1.me) &&
        implies($.n2.role === $.leader, $.n2.knownLeader === $.n2.me)),
    ],
  }),
]);
