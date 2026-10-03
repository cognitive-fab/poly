// Card payments (T3): one Payment instance per payment id, created by authorize.
import {
  module, enumType, machine, field, t, action, on, require, set, when, emit, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('payments', [
  enumType('Status', ['idle', 'authorizing', 'authorized', 'declined', 'failed', 'captured', 'voided', 'refunded', 'expired']),
  machine('Payment', {
    state: {
      status: field(t.named('Status'), ($) => $.idle),
      authorizedAmount: field(t.range(0, 3), () => 0),
      capturedAmount: field(t.range(0, 3), () => 0),
      refundedAmount: field(t.range(0, 3), () => 0),
      requests: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, [$.declined, $.failed, $.voided, $.refunded, $.expired])),
      action('Authorize', { amount: t.int.check([1, 2], 'strict') }),
      action('TimedOut', {}),
      action('Approved', {}),
      action('Declined', {}),
      action('Capture', { amount: t.int.check([1, 2, 3], 'strict') }),
      action('Void', {}),
      action('Increase', {}),
      action('Expire', {}),
      action('Refund', { amount: t.int.check([1, 2], 'strict') }),

      on('Authorize', ($) => [
        require($.status === $.idle, 'payment-exists'),
        set('status', $.authorizing),
        set('authorizedAmount', $.amount),
        set('requests', 1),
        emit('authorize', { amount: $.amount }),
      ]),
      // A timeout sends another request, up to 3; after the third, the payment fails.
      on('TimedOut', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        when($.requests < 3,
          [set('requests', $.requests + 1), emit('authorize', { amount: $.authorizedAmount })],
          [set('status', $.failed)]),
      ]),
      // The first answer decides; a later one finds the payment no longer authorizing and is rejected.
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
        require($.amount <= $.authorizedAmount, 'exceeds-authorized'),
        set('status', $.captured),
        set('capturedAmount', $.amount),
      ]),
      on('Void', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        set('status', $.voided),
      ]),
      // The provider reports the hold lapsed: only an uncaptured authorized payment expires.
      on('Expire', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        set('status', $.expired),
      ]),
      on('Increase', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        require($.authorizedAmount < 3, 'at-most-3'),
        set('authorizedAmount', $.authorizedAmount + 1),
      ]),
      on('Refund', ($) => [
        require($.status === $.captured, 'not-captured'),
        require($.refundedAmount + $.amount <= $.capturedAmount, 'exceeds-captured'),
        set('refundedAmount', $.refundedAmount + $.amount),
        when($.refundedAmount + $.amount === $.capturedAmount, [set('status', $.refunded)]),
      ]),

      effect('authorize', { amount: t.int }, [
        kind('card.authorize'),
        labels(['egress:external']),
        cls('compensable'),
        ok('Approved', []),
        failed('Declined', []),
      ]),

      invariant('captured-within-authorized', ($) => $.capturedAmount <= $.authorizedAmount),
      invariant('refunded-within-captured', ($) => $.refundedAmount <= $.capturedAmount),
      invariant('voided-captured-nothing', ($) => implies($.status === $.voided, $.capturedAmount === 0)),
      invariant('requests-bounded', ($) => $.requests <= 3),
      pathProperty('at-most-three-requests', () => count('card.authorize') <= 3),
    ],
  }),
]);
