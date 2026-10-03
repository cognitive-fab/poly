// A consensus node's role and term (T8).
import { module, enumType, machine, field, t, action, on, require, set, when, terminal, invariant, stepProperty, implies } from '@cognitive-fab/poly/embed';

export default module('consensus', [
  enumType('Role', ['follower', 'candidate', 'leader', 'shutdown']),
  enumType('Vote', ['nobody', 'itself', 'n1', 'n2']),
  machine('Node', {
    state: {
      role: field(t.named('Role'), ($) => $.follower),
      term: field(t.range(0, 3), () => 0),
      votedFor: field(t.named('Vote'), ($) => $.nobody),
    },
    items: [
      terminal(($) => $.role === $.shutdown),
      action('ElectionTimeout', {}),
      action('ElectionWon', {}),
      action('NewerTermSeen', { newTerm: t.int.check(-1, 4) }),
      action('QuorumLost', {}),
      action('VoteRequested', { candidate: t.string.check(['n1', 'n2', 'n3']), voteTerm: t.int.check(-1, 4) }),
      action('Shutdown', {}),
      on('ElectionTimeout', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role !== $.leader, 'is-leader'),
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
      on('ElectionLost', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role === $.candidate, 'not-candidate'),
        set('role', $.follower),
      ]),
      on('NewerTermSeen', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.newTerm >= 1 && $.newTerm <= 3, 'term-out-of-range'),
        require($.newTerm > $.term, 'term-not-newer'),
        set('role', $.follower),
        set('term', $.newTerm),
        set('votedFor', $.nobody),
      ], ['newTerm']),
      on('VoteRequested', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.candidate === 'n1' || $.candidate === 'n2', 'unknown-candidate'),
        require($.voteTerm >= 1 && $.voteTerm <= 3, 'term-out-of-range'),
        require($.voteTerm >= $.term, 'term-stale'),
        when($.voteTerm > $.term, [
          set('role', $.follower),
          set('term', $.voteTerm),
        ], [
          require($.role === $.follower, 'not-follower'),
          require($.votedFor === $.nobody
            || ($.votedFor === $.n1 && $.candidate === 'n1')
            || ($.votedFor === $.n2 && $.candidate === 'n2'), 'already-voted'),
        ]),
        when($.candidate === 'n1', [set('votedFor', $.n1)], [set('votedFor', $.n2)]),
      ], ['candidate', 'voteTerm']),
      on('QuorumLost', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.role === $.leader, 'not-leader'),
        set('role', $.follower),
      ]),
      on('Shutdown', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        set('role', $.shutdown),
      ]),
      invariant('elected-term-positive', ($) => implies($.role === $.leader || $.role === $.candidate, $.term >= 1)),
      stepProperty('term-never-decreases', ($) => $.post.term >= $.pre.term),
      stepProperty('leader-was-candidate', ($) =>
        implies($.post.role === $.leader, $.pre.role === $.leader || ($.pre.role === $.candidate && $.pre.term === $.post.term))),
      invariant('candidate-voted-itself', ($) => implies($.role === $.candidate || $.role === $.leader, $.votedFor === $.itself)),
      stepProperty('one-vote-per-term', ($) =>
        implies($.pre.term === $.post.term && $.pre.votedFor !== $.nobody, $.post.votedFor === $.pre.votedFor)),
      stepProperty('shutdown-stays', ($) => implies($.pre.role === $.shutdown, $.post.role === $.shutdown)),
    ],
  }),
]);
