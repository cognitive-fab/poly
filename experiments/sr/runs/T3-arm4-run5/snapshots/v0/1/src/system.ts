// Card payments: one Payment machine per payment id, created by authorize.
import {
  module, enumType, machine, field, t, action, on, require, set, emit, when, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('payments', [
  enumType('Status', ['none', 'authorizing', 'authorized', 'declined', 'failed', 'captured', 'voided', 'refunded']),
  machine('Payment', {
    state: {
      status: field(t.named('Status'), ($) => $.none),
      authorized: field(t.range(0, 2), () => 0),
      captured: field(t.range(0, 2), () => 0),
      refunded: field(t.range(0, 2), () => 0),
      requests: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, [$.declined, $.failed, $.voided, $.refunded])),
      action('Authorize', { amount: t.range(1, 2) }),
      action('TimedOut', {}),
      action('Capture', { amount: t.range(1, 2) }),
      action('Void', {}),
      action('Refund', { amount: t.range(1, 2) }),
      action('Approved', {}),
      action('Declined', {}),
      on('Authorize', ($) => [
        require($.status === $.none, 'payment-exists'),
        set('status', $.authorizing),
        set('authorized', $.amount),
        set('requests', 1),
        emit('authorize', { amount: $.amount }),
      ], ['amount']),
      on('TimedOut', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        when($.requests >= 3, [set('status', $.failed)], [
          set('requests', $.requests + 1),
          emit('authorize', { amount: $.authorized }),
        ]),
      ]),
      on('Capture', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        require($.amount <= $.authorized, 'exceeds-authorized'),
        set('status', $.captured),
        set('captured', $.amount),
      ], ['amount']),
      on('Void', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        set('status', $.voided),
      ]),
      on('Refund', ($) => [
        require($.status === $.captured, 'not-captured'),
        require($.refunded + $.amount <= $.captured, 'exceeds-captured'),
        set('refunded', $.refunded + $.amount),
        when($.refunded + $.amount === $.captured, [set('status', $.refunded)]),
      ], ['amount']),
      on('Approved', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        set('status', $.authorized),
      ]),
      on('Declined', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        set('status', $.declined),
      ]),
      effect('authorize', { amount: t.int }, [
        kind('card.authorize'),
        labels(['egress:external']),
        cls('compensable'),
        ok('Approved', []),
        failed('Declined', []),
      ]),
      invariant('captured-within-authorized', ($) => $.captured <= $.authorized),
      invariant('refunded-within-captured', ($) => $.refunded <= $.captured),
      invariant('voided-captured-nothing', ($) => implies($.status === $.voided, $.captured === 0)),
      invariant('requests-bounded', ($) => $.requests <= 3),
      pathProperty('at-most-three-requests', () => count('card.authorize') <= 3),
    ],
  }),
]);
