// A consensus node's role and term (T8), in poly's embedded surface.
import {
  module, enumType, machine, field, t, action, on, require, set, terminal, stepProperty, implies,
} from '@cognitive-fab/poly/embed';

export default module('consensus', [
  enumType('Role', ['follower', 'candidate', 'leader', 'shutdown']),
  machine('Node', {
    state: {
      role: field(t.named('Role'), ($) => $.follower),
      term: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => $.role === $.shutdown),
      action('ElectionTimeout', {}),
      action('ElectionWon', {}),
      action('NewerTermSeen', { newTerm: t.int.check(0, 4) }),
      action('QuorumLost', {}),
      action('Shutdown', {}),
      on('ElectionTimeout', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role !== $.leader, 'is-leader'),
        require($.term < 3, 'last-term'),
        set('role', $.candidate),
        set('term', $.term + 1),
      ]),
      on('ElectionWon', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role === $.candidate, 'not-candidate'),
        set('role', $.leader),
      ]),
      on('NewerTermSeen', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.newTerm >= 1 && $.newTerm <= 3, 'term-out-of-range'),
        require($.newTerm > $.term, 'not-newer'),
        set('role', $.follower),
        set('term', $.newTerm),
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
      stepProperty('term-never-goes-down', ($) => $.post.term >= $.pre.term),
      stepProperty('term-changes-only-by-election-or-newer-term', ($) =>
        implies($.post.term !== $.pre.term, $.action === $.ElectionTimeout || $.action === $.NewerTermSeen)),
      stepProperty('leader-was-candidate-in-its-term', ($) =>
        implies($.post.role === $.leader && $.pre.role !== $.leader,
          $.pre.role === $.candidate && $.pre.term === $.post.term)),
      stepProperty('shutdown-stays-shutdown', ($) => implies($.pre.role === $.shutdown, $.post.role === $.shutdown)),
    ],
  }),
]);
