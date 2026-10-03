// A consensus node's role, term and vote (T8), in poly's embedded surface.
import {
  module, enumType, machine, field, t, action, on, require, set, when, terminal, stepProperty, implies, isIn,
} from '@cognitive-fab/poly/embed';

export default module('consensus', [
  enumType('Role', ['follower', 'candidate', 'leader', 'shutdown']),
  enumType('Vote', ['nobody', 'itself', 'n1', 'n2']),
  machine('Node', {
    state: {
      role: field(t.named('Role'), ($) => $.follower),
      term: field(t.range(0, 3), () => 0),
      votedFor: field(t.named('Vote'), ($) => $.nobody),
      paused: field(t.bool, () => false),
    },
    items: [
      terminal(($) => $.role === $.shutdown),
      action('Pause', {}),
      action('Resume', {}),
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
      action('ElectionTimeout', {}),
      action('ElectionWon', {}),
      action('ElectionLost', {}),
      action('NewerTermSeen', { newTerm: t.int.check(0, 4) }),
      action('QuorumLost', {}),
      action('Shutdown', {}),
      action('VoteRequested', { candidate: t.named('Vote'), voteTerm: t.int.check(0, 4) }),
      on('ElectionTimeout', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role !== $.leader, 'is-leader'),
        require(!$.paused, 'paused'),
        require($.term < 3, 'last-term'),
        set('role', $.candidate),
        set('term', $.term + 1),
        set('votedFor', $.itself),
      ]),
      on('ElectionWon', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role === $.candidate, 'not-candidate'),
        set('role', $.leader),
      ]),
      // A candidate that lost keeps its vote for itself, so it grants no other vote in this term.
      on('ElectionLost', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role === $.candidate, 'not-candidate'),
        set('role', $.follower),
      ]),
      on('NewerTermSeen', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.newTerm >= 1 && $.newTerm <= 3, 'term-out-of-range'),
        require($.newTerm > $.term, 'not-newer'),
        set('role', $.follower),
        set('term', $.newTerm),
        set('votedFor', $.nobody),
      ], ['newTerm']),
      on('QuorumLost', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role === $.leader, 'not-leader'),
        set('role', $.follower),
      ]),
      on('Shutdown', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        set('role', $.shutdown),
      ]),
      on('VoteRequested', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require(isIn($.candidate, [$.n1, $.n2]), 'unknown-candidate'),
        require($.voteTerm >= 1 && $.voteTerm <= 3, 'term-out-of-range'),
        require($.voteTerm >= $.term, 'stale-term'),
        when($.voteTerm > $.term, [
          set('role', $.follower),
          set('term', $.voteTerm),
          set('votedFor', $.candidate),
        ], [
          require($.role === $.follower, 'not-follower'),
          require($.votedFor === $.nobody || $.votedFor === $.candidate, 'already-voted'),
          set('votedFor', $.candidate),
        ]),
      ], ['candidate', 'voteTerm']),
      stepProperty('term-never-goes-down', ($) => $.post.term >= $.pre.term),
      stepProperty('term-changes-only-by-election-or-newer-term', ($) =>
        implies($.post.term !== $.pre.term,
          $.action === $.ElectionTimeout || $.action === $.NewerTermSeen || $.action === $.VoteRequested)),
      stepProperty('leader-was-candidate-in-its-term', ($) =>
        implies($.post.role === $.leader && $.pre.role !== $.leader,
          $.pre.role === $.candidate && $.pre.term === $.post.term)),
      stepProperty('shutdown-stays-shutdown', ($) => implies($.pre.role === $.shutdown, $.post.role === $.shutdown)),
      stepProperty('one-vote-per-term', ($) =>
        implies($.post.term === $.pre.term && $.pre.votedFor !== $.nobody, $.post.votedFor === $.pre.votedFor)),
    ],
  }),
]);
