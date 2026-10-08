// Card payments (T3): one Payment machine per payment id, created by authorize.
import {
  module, enumType, machine, field, t, action, on, require, set, when, emit, effect, kind, labels, cls,
  ok, failed, terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('payments', [
  // The statuses are named as the host interface reports them; `idle` is the payment before authorize.
  enumType('Status', ['idle', 'authorizing', 'authorized', 'declined', 'failed', 'captured', 'voided', 'refunded']),
  machine('Payment', {
    state: {
      status: field(t.named('Status'), ($) => $.idle),
      // The amounts: named apart from the statuses of the same name.
      authorizedAmount: field(t.range(0, 3), () => 0),
      capturedAmount: field(t.range(0, 3), () => 0),
      refundedAmount: field(t.range(0, 3), () => 0),
      requests: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, [$.declined, $.failed, $.voided, $.refunded])),
      action('Authorize', { amount: t.int.check([1, 2]) }),
      action('TimedOut', {}),
      action('Capture', { amount: t.int.check([1, 2]) }),
      action('Void', {}),
      action('Refund', { amount: t.int.check([1, 2]) }),
      action('Approved', {}),
      action('Declined', {}),

      on('Authorize', ($) => [
        require($.status === $.idle, 'payment-exists'),
        set('status', $.authorizing),
        set('authorizedAmount', $.amount),
        set('requests', 1),
        emit('authorize', { amount: $.amount }),
      ], ['amount']),
      on('TimedOut', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        when($.requests >= 3,
          [set('status', $.failed)],
          [set('requests', $.requests + 1), emit('authorize', { amount: $.authorizedAmount })]),
      ]),
      on('Capture', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        require($.amount <= $.authorizedAmount, 'exceeds-authorized'),
        set('status', $.captured),
        set('capturedAmount', $.amount),
      ], ['amount']),
      on('Void', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        set('status', $.voided),
      ]),
      on('Refund', ($) => [
        require($.status === $.captured, 'not-captured'),
        require($.refundedAmount + $.amount <= $.capturedAmount, 'exceeds-captured'),
        set('refundedAmount', $.refundedAmount + $.amount),
        when($.refundedAmount + $.amount === $.capturedAmount, [set('status', $.refunded)]),
      ], ['amount']),
      // The provider's answers: the first decides; a late one finds the payment no longer authorizing.
      on('Approved', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        set('status', $.authorized),
      ]),
      on('Declined', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        set('status', $.declined),
      ]),

      effect('authorize', { amount: t.range(1, 2) }, [
        kind('card.authorize'),
        labels(['egress:external']),
        cls('reversible'),
        ok('Approved', []),
        failed('Declined', []),
      ]),

      invariant('captured-within-authorized', ($) => $.capturedAmount <= $.authorizedAmount),
      invariant('refunded-within-captured', ($) => $.refundedAmount <= $.capturedAmount),
      invariant('voided-captured-nothing', ($) => implies($.status === $.voided, $.capturedAmount === 0)),
      invariant('requests-bounded', ($) => $.requests <= 3),
      pathProperty('at-most-3-requests', () => count('card.authorize') <= 3),
    ],
  }),
]);
