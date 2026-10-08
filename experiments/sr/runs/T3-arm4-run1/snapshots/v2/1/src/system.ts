// Card payments (T3): one Payment machine per payment id.
// The amount fields are named apart from the Status members; host.map.json renames them for the query.
import {
  module, enumType, machine, field, t, action, on, require, set, when, emit, effect, kind, labels, cls, retry,
  ok, failed, terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('payments', [
  // `fresh` is the instance before its Authorize; a refused Authorize leaves no instance, so no view shows it.
  enumType('Status', ['fresh', 'authorizing', 'authorized', 'declined', 'failed', 'captured', 'voided', 'refunded', 'expired']),
  machine('Payment', {
    state: {
      status: field(t.named('Status'), ($) => $.fresh),
      authAmount: field(t.range(0, 3), () => 0),
      capturedAmount: field(t.range(0, 3), () => 0),
      refundedAmount: field(t.range(0, 3), () => 0),
      requests: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, [$.declined, $.failed, $.voided, $.refunded])),
      action('Authorize', { amount: t.int.check([1, 2]) }),
      action('TimedOut', {}),
      action('Approved', {}),
      action('Declined', {}),
      action('Capture', { amount: t.int.check([1, 2, 3]) }),
      action('Void', {}),
      action('Increase', {}),
      action('Refund', { amount: t.int.check([1, 2]) }),
      // Creation: the adapter makes a fresh instance and dispatches Authorize to it; a second one is refused.
      on('Authorize', ($) => [
        require($.status === $.fresh, 'exists'),
        set('status', $.authorizing),
        set('authAmount', $.amount),
        set('requests', 1),
        emit('cardAuthorize', { amount: $.amount }),
      ], ['amount']),
      on('TimedOut', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        when($.requests >= 3,
          [set('status', $.failed)],
          [set('requests', $.requests + 1), emit('cardAuthorize', { amount: $.authAmount })]),
      ]),
      on('Approved', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        set('status', $.authorized),
      ]),
      on('Declined', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        set('status', $.declined),
      ]),
      on('Capture', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        require($.amount <= $.authAmount, 'exceeds-authorized'),
        set('capturedAmount', $.amount),
        set('status', $.captured),
      ], ['amount']),
      on('Void', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        set('status', $.voided),
      ]),
      on('Increase', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        require($.authAmount < 3, 'at-maximum'),
        set('authAmount', $.authAmount + 1),
      ]),
      on('Refund', ($) => [
        require($.status === $.captured, 'not-captured'),
        require($.refundedAmount + $.amount <= $.capturedAmount, 'exceeds-captured'),
        set('refundedAmount', $.refundedAmount + $.amount),
        when($.refundedAmount + $.amount === $.capturedAmount, [set('status', $.refunded)]),
      ], ['amount']),
      effect('cardAuthorize', { amount: t.int }, [
        kind('card.authorize'),
        labels(['egress:external']),
        cls('reversible'),
        retry(1, '100ms', '2s'),
        ok('Approved', []),
        failed('Declined', []),
      ]),
      invariant('captured-within-authorized', ($) => $.capturedAmount <= $.authAmount),
      invariant('refunded-within-captured', ($) => $.refundedAmount <= $.capturedAmount),
      invariant('voided-captured-nothing', ($) => implies($.status === $.voided, $.capturedAmount === 0)),
      invariant('requests-bounded', ($) => $.requests <= 3),
      pathProperty('at-most-three-requests', () => count('card.authorize') <= 3),
    ],
  }),
]);
