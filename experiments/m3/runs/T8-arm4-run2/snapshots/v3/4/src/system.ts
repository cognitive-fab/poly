// A consensus node's role and term (T8), in poly's embedded surface.
import { module, enumType, machine, field, t, action, on, require, set, when, terminal, invariant, stepProperty, implies } from '@cognitive-fab/poly/embed';

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
      action('ElectionTimeout', {}),
      action('ElectionWon', {}),
      action('NewerTermSeen', { term: t.int.check(0, 4) }),
      action('ElectionLost', {}),
      action('Pause', {}),
      action('Resume', {}),
      action('QuorumLost', {}),
      action('VoteRequested', { from: t.string.check(['n1', 'n2', 'n3']), term: t.int.check(0, 4) }),
      action('Shutdown', {}),
      on('ElectionTimeout', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role !== $.leader, 'is-leader'),
        require(!$.paused, 'paused'),
        require($.pre.term < 3, 'last-term'),
        set('role', $.candidate),
        set('term', $.pre.term + 1),
        set('votedFor', $.itself),
      ]),
      on('ElectionWon', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role === $.candidate, 'not-candidate'),
        set('role', $.leader),
      ]),
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
      on('ElectionLost', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role === $.candidate, 'not-candidate'),
        set('role', $.follower),
      ]),
      on('NewerTermSeen', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.term >= 1 && $.term <= 3, 'term-out-of-range'),
        require($.term > $.pre.term, 'term-not-newer'),
        set('role', $.follower),
        set('term', $.term),
        set('votedFor', $.nobody),
      ]),
      on('QuorumLost', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role === $.leader, 'not-leader'),
        set('role', $.follower),
      ]),
      on('VoteRequested', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.from === 'n1' || $.from === 'n2', 'unknown-candidate'),
        require($.term >= 1 && $.term <= 3, 'term-out-of-range'),
        require($.term >= $.pre.term, 'term-older'),
        when($.term > $.pre.term, [
          set('role', $.follower),
          set('term', $.term),
          when($.from === 'n1', [set('votedFor', $.n1)], [set('votedFor', $.n2)]),
        ], [
          require($.role === $.follower, 'not-follower'),
          require($.votedFor === $.nobody || ($.votedFor === $.n1 && $.from === 'n1') || ($.votedFor === $.n2 && $.from === 'n2'), 'already-voted'),
          when($.from === 'n1', [set('votedFor', $.n1)], [set('votedFor', $.n2)]),
        ]),
      ]),
      on('Shutdown', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        set('role', $.shutdown),
      ]),
      stepProperty('term-never-decreases', ($) => $.post.term >= $.pre.term),
      stepProperty('leader-was-candidate', ($) =>
        implies($.post.role === $.leader && $.pre.role !== $.leader, $.pre.role === $.candidate && $.post.term === $.pre.term)),
      stepProperty('shutdown-stays', ($) => implies($.pre.role === $.shutdown, $.post.role === $.shutdown)),
      stepProperty('one-vote-per-term', ($) =>
        implies($.post.term === $.pre.term && $.pre.votedFor !== $.nobody, $.post.votedFor === $.pre.votedFor)),
      invariant('candidate-voted-itself', ($) => implies($.role === $.candidate, $.votedFor === $.itself)),
      invariant('term-in-range', ($) => $.term >= 0 && $.term <= 3),
    ],
  }),
]);
