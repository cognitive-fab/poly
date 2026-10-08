// Card payments: one Payment instance per payment id, created by Authorize. Each authorisation request to the
// card provider is the effect card.authorize; its completion is Approved (ok) or Declined (failed).
import {
  module, enumType, machine, field, t, action, on, require, set, when, emit, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('payments', [
  enumType('Status', ['New', 'Authorizing', 'Authorized', 'Declined', 'Failed', 'Captured', 'Voided', 'Refunded', 'Expired']),
  machine('Payment', {
    state: {
      status: field(t.named('Status'), ($) => $.New),
      authorized: field(t.range(0, 3), () => 0),
      captured: field(t.range(0, 3), () => 0),
      refunded: field(t.range(0, 3), () => 0),
      requests: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, [$.Declined, $.Failed, $.Voided, $.Refunded, $.Expired])),
      action('Authorize', { amount: t.int.check([1, 2]) }),
      action('TimedOut', {}),
      action('Approved', {}),
      action('Declined', {}),
      action('Capture', { amount: t.int.check([1, 2, 3]) }),
      action('Void', {}),
      action('Increase', {}),
      action('Expire', {}),
      action('Refund', { amount: t.int.check([1, 2]) }),

      on('Authorize', ($) => [
        require($.status === $.New, 'payment-exists'),
        set('status', $.Authorizing),
        set('authorized', $.amount),
        set('requests', 1),
        emit('authorize', { amount: $.amount }),
      ], ['amount']),
      on('TimedOut', ($) => [
        require($.status === $.Authorizing, 'not-authorizing'),
        when($.requests >= 3, [set('status', $.Failed)], [
          set('requests', $.requests + 1),
          emit('authorize', { amount: $.authorized }),
        ]),
      ]),
      // The first answer decides; a later one finds the payment no longer authorizing and changes nothing.
      on('Approved', ($) => [
        require($.status === $.Authorizing, 'not-authorizing'),
        set('status', $.Authorized),
      ]),
      on('Declined', ($) => [
        require($.status === $.Authorizing, 'not-authorizing'),
        set('status', $.Declined),
      ]),
      // Capture from an authorized payment, or more of a captured one that has refunded nothing.
      on('Capture', ($) => [
        require($.status === $.Authorized || ($.status === $.Captured && $.refunded === 0), 'not-capturable'),
        require($.captured + $.amount <= $.authorized, 'exceeds-authorized'),
        set('status', $.Captured),
        set('captured', $.captured + $.amount),
      ], ['amount']),
      on('Void', ($) => [
        require($.status === $.Authorized, 'not-authorized'),
        set('status', $.Voided),
      ]),
      on('Increase', ($) => [
        require($.status === $.Authorized, 'not-authorized'),
        require($.authorized < 3, 'at-maximum'),
        set('authorized', $.authorized + 1),
      ]),
      on('Expire', ($) => [
        require($.status === $.Authorized, 'not-authorized'),
        set('status', $.Expired),
      ]),
      on('Refund', ($) => [
        require($.status === $.Captured, 'not-captured'),
        require($.refunded + $.amount <= $.captured, 'exceeds-captured'),
        set('refunded', $.refunded + $.amount),
        when($.refunded + $.amount === $.captured, [set('status', $.Refunded)]),
      ], ['amount']),

      effect('authorize', { amount: t.int }, [
        kind('card.authorize'),
        labels(['egress:external']),
        cls('reversible'),
        ok('Approved', []),
        failed('Declined', []),
      ]),

      invariant('captured-within-authorized', ($) => $.captured <= $.authorized),
      invariant('refunded-within-captured', ($) => $.refunded <= $.captured),
      invariant('voided-captured-nothing', ($) => implies($.status === $.Voided, $.captured === 0)),
      invariant('requests-bounded', ($) => $.requests <= 3),
      pathProperty('at-most-three-requests', () => count('card.authorize') <= 3),
    ],
  }),
]);
