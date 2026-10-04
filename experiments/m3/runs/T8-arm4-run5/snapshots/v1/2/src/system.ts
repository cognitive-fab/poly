// A consensus node's role, term and vote.
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
      action('NewerTermSeen', { seen: t.int.check(0, 4) }),
      action('QuorumLost', {}),
      action('Shutdown', {}),
      action('VoteRequested', { candidate: t.string.check(['n1', 'n2', 'n3']), asked: t.int.check(0, 4) }),
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
      on('NewerTermSeen', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.seen >= 1 && $.seen <= 3, 'term-out-of-range'),
        require($.seen > $.term, 'term-not-newer'),
        set('role', $.follower),
        set('term', $.seen),
        set('votedFor', $.nobody),
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
      on('VoteRequested', ($) => [
        require($.role !== $.shutdown, 'shut-down'),
        require($.candidate === 'n1' || $.candidate === 'n2', 'unknown-candidate'),
        require($.asked >= 1 && $.asked <= 3, 'term-out-of-range'),
        require($.asked >= $.term, 'stale-term'),
        when($.asked > $.term, [
          set('role', $.follower),
          set('term', $.asked),
        ], [
          require($.role === $.follower, 'not-follower'),
          require($.votedFor === $.nobody
            || ($.votedFor === $.n1 && $.candidate === 'n1')
            || ($.votedFor === $.n2 && $.candidate === 'n2'), 'already-voted'),
        ]),
        when($.candidate === 'n1', [set('votedFor', $.n1)], [set('votedFor', $.n2)]),
      ], ['candidate', 'asked']),
      stepProperty('term-never-decreases', ($) => $.post.term >= $.pre.term),
      stepProperty('leader-was-candidate', ($) =>
        implies($.post.role === $.leader && $.pre.role !== $.leader, $.pre.role === $.candidate && $.pre.term === $.post.term)),
      stepProperty('shutdown-stays', ($) => implies($.pre.role === $.shutdown, $.post.role === $.shutdown)),
      stepProperty('one-vote-per-term', ($) =>
        implies($.pre.term === $.post.term && $.pre.votedFor !== $.nobody, $.post.votedFor === $.pre.votedFor)),
      invariant('term-in-range', ($) => $.term >= 0 && $.term <= 3),
      invariant('candidate-voted-itself', ($) => implies($.role === $.candidate || $.role === $.leader, $.votedFor === $.itself)),
    ],
  }),
]);
