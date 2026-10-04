// A consensus node's role and term.
import { module, enumType, machine, field, t, action, on, require, set, terminal, invariant, stepProperty, implies } from '@cognitive-fab/poly/embed';

export default module('consensus', [
  enumType('Role', ['follower', 'candidate', 'leader', 'shutdown']),
  machine('Node', {
    state: {
      role: field(t.named('Role'), ($) => $.Follower),
      term: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => $.role === $.Shutdown),
      action('ElectionTimeout', {}),
      action('ElectionWon', {}),
      action('NewerTermSeen', { seen: t.int.check(0, 4) }),
      action('QuorumLost', {}),
      action('Shutdown', {}),
      on('ElectionTimeout', ($) => [
        require($.role !== $.Shutdown, 'shut-down'),
        require($.role !== $.Leader, 'is-leader'),
        require($.term < 3, 'last-term'),
        set('role', $.Candidate),
        set('term', $.term + 1),
      ]),
      on('ElectionWon', ($) => [
        require($.role !== $.Shutdown, 'shut-down'),
        require($.role === $.Candidate, 'not-candidate'),
        set('role', $.Leader),
      ]),
      on('NewerTermSeen', ($) => [
        require($.role !== $.Shutdown, 'shut-down'),
        require($.seen >= 1 && $.seen <= 3, 'term-out-of-range'),
        require($.seen > $.term, 'term-not-newer'),
        set('role', $.Follower),
        set('term', $.seen),
      ], ['seen']),
      on('QuorumLost', ($) => [
        require($.role !== $.Shutdown, 'shut-down'),
        require($.role === $.Leader, 'not-leader'),
        set('role', $.Follower),
      ]),
      on('Shutdown', ($) => [
        require($.role !== $.Shutdown, 'shut-down'),
        set('role', $.Shutdown),
      ]),
      stepProperty('term-never-decreases', ($) => $.post.term >= $.pre.term),
      stepProperty('leader-was-candidate', ($) =>
        implies($.post.role === $.Leader && $.pre.role !== $.Leader, $.pre.role === $.Candidate && $.pre.term === $.post.term)),
      stepProperty('shutdown-stays', ($) => implies($.pre.role === $.Shutdown, $.post.role === $.Shutdown)),
      invariant('term-in-range', ($) => $.term >= 0 && $.term <= 3),
    ],
  }),
]);
