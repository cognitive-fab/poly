// A consensus node's role, term and vote.
import { module, enumType, machine, field, t, action, on, set, require, terminal, stepProperty, implies } from '@cognitive-fab/poly/embed';

export default module('consensus', [
  enumType('Role', ['follower', 'candidate', 'leader', 'shutdown']),
  machine('Node', {
    state: {
      role: field(t.named('Role'), ($) => $.follower),
      term: field(t.range(0, 3), () => 0),
      votedFor: field(t.string, () => 'nobody', { check: ['nobody', 'itself', 'n1', 'n2'] }),
      paused: field(t.bool, () => false),
    },
    items: [
      terminal(($) => $.role === $.shutdown),
      action('ElectionTimeout', {}),
      action('ElectionWon', {}),
      action('ElectionLost', {}),
      action('NewerTermSeen', { seen: t.int.check(0, 4, 'disclosed') }),
      action('QuorumLost', {}),
      action('Shutdown', {}),
      action('Pause', {}),
      action('Resume', {}),
      action('VoteRequested', { candidate: t.string.check(['n1', 'n2', 'n3'], 'disclosed'), asked: t.int.check(0, 4, 'disclosed') }),
      on('ElectionTimeout', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role !== $.leader, 'is-leader'),
        require(!$.paused, 'paused'),
        require($.term < 3, 'last-term'),
        set('role', $.candidate),
        set('term', $.term + 1),
        set('votedFor', 'itself'),
      ]),
      on('ElectionWon', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role === $.candidate, 'not-candidate'),
        set('role', $.leader),
      ]),
      // A lost election keeps the vote for itself, so no other vote is granted in this term.
      on('ElectionLost', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role === $.candidate, 'not-candidate'),
        set('role', $.follower),
      ]),
      on('NewerTermSeen', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.seen >= 1 && $.seen <= 3, 'term-out-of-range'),
        require($.seen > $.term, 'not-newer'),
        set('role', $.follower),
        set('term', $.seen),
        set('votedFor', 'nobody'),
      ], ['seen']),
      on('QuorumLost', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role === $.leader, 'not-leader'),
        set('role', $.follower),
      ]),
      on('Shutdown', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        set('role', $.shutdown),
      ]),
      // A paused follower starts no election; it still votes and moves to newer terms, staying paused.
      on('Pause', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role === $.follower, 'not-follower'),
        require(!$.paused, 'already-paused'),
        set('paused', true),
      ]),
      on('Resume', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.paused, 'not-paused'),
        set('paused', false),
      ]),
      // A newer term makes the node a follower in it and grants; the same term grants only to a follower
      // that has not voted or already voted for this candidate.
      on('VoteRequested', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.candidate === 'n1' || $.candidate === 'n2', 'unknown-candidate'),
        require($.asked >= 1 && $.asked <= 3, 'term-out-of-range'),
        require($.asked >= $.term, 'stale-term'),
        require($.asked > $.term || $.role === $.follower, 'not-follower'),
        require($.asked > $.term || $.votedFor === 'nobody' || $.votedFor === $.candidate, 'already-voted'),
        set('role', $.follower),
        set('term', $.asked),
        set('votedFor', $.candidate),
      ], ['candidate', 'asked']),
      stepProperty('term-never-decreases', ($) => $.post.term >= $.pre.term),
      stepProperty('term-changes-by-election-or-newer-term', ($) =>
        implies($.post.term !== $.pre.term, $.action === $.ElectionTimeout || $.action === $.NewerTermSeen || $.action === $.VoteRequested)),
      stepProperty('leader-was-candidate', ($) =>
        implies($.post.role === $.leader && $.pre.role !== $.leader, $.pre.role === $.candidate && $.pre.term === $.post.term)),
      stepProperty('one-vote-per-term', ($) =>
        implies($.post.term === $.pre.term && $.pre.votedFor !== 'nobody', $.post.votedFor === $.pre.votedFor)),
      invariant('paused-is-follower', ($) => implies($.paused, $.role === $.follower || $.role === $.shutdown)),
      stepProperty('shutdown-stays', ($) => implies($.pre.role === $.shutdown, $.post.role === $.shutdown)),
    ],
  }),
]);
