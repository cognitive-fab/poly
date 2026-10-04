// A consensus node's role and term.
import { module, enumType, machine, field, t, action, on, require, set, terminal, invariant, stepProperty, implies } from '@cognitive-fab/poly/embed';

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
      action('NewerTermSeen', { seen: t.int.check(0, 4) }),
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
        require($.seen >= 1 && $.seen <= 3, 'term-out-of-range'),
        require($.seen > $.term, 'term-not-newer'),
        set('role', $.follower),
        set('term', $.seen),
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
      stepProperty('term-never-decreases', ($) => $.post.term >= $.pre.term),
      stepProperty('leader-was-candidate', ($) =>
        implies($.post.role === $.leader && $.pre.role !== $.leader, $.pre.role === $.candidate && $.pre.term === $.post.term)),
      stepProperty('shutdown-stays', ($) => implies($.pre.role === $.shutdown, $.post.role === $.shutdown)),
      invariant('term-in-range', ($) => $.term >= 0 && $.term <= 3),
    ],
  }),
]);
