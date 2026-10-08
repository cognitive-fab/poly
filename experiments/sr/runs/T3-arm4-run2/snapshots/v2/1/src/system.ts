// Card payments: one Payment machine per payment id, created by authorize.
// The status members are the names the host interface shows; `fresh` is the state of an instance
// before its Authorize step, which never outlives a refused authorize.
import {
  module, enumType, machine, field, t, action, on, require, set, when, emit, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('payments', [
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

      on('Authorize', ($) => [
        require($.status === $.fresh, 'payment-exists'),
        set('status', $.authorizing),
        set('authAmount', $.amount),
        set('requests', 1),
        emit('authorize', { amount: $.amount }),
      ], ['amount']),
      // The provider did not answer in time: ask again, up to 3 requests in all, then give up.
      on('TimedOut', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        when($.requests < 3, [
          set('requests', $.requests + 1),
          emit('authorize', { amount: $.authAmount }),
        ], [
          set('status', $.failed),
        ]),
      ]),
      // The first answer decides; a later one finds the payment no longer authorizing and changes nothing.
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
        set('status', $.captured),
        set('capturedAmount', $.amount),
      ], ['amount']),
      on('Void', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        set('status', $.voided),
      ]),
      // A customer adds to the order before capture: the hold grows by 1 unit, up to 3.
      on('Increase', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        require($.authAmount < 3, 'at-most-three'),
        set('authAmount', $.authAmount + 1),
      ]),
      on('Refund', ($) => [
        require($.status === $.captured, 'not-captured'),
        require($.refundedAmount + $.amount <= $.capturedAmount, 'exceeds-captured'),
        set('refundedAmount', $.refundedAmount + $.amount),
        when($.refundedAmount + $.amount === $.capturedAmount, [set('status', $.refunded)]),
      ], ['amount']),

      effect('authorize', { amount: t.int }, [
        kind('card.authorize'),
        labels(['egress:external']),
        cls('compensable'),
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
