// Card payments: one Payment machine per payment id, created by authorize.
import {
  module, enumType, machine, field, t, action, on, require, set, when, emit, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('payments', [
  enumType('Status', ['fresh', 'authorizing', 'authorized', 'declined', 'failed', 'captured', 'voided', 'refunded']),
  machine('Payment', {
    state: {
      status: field(t.named('Status'), ($) => $.fresh),
      total: field(t.range(0, 3), () => 0),
      taken: field(t.range(0, 3), () => 0),
      returned: field(t.range(0, 3), () => 0),
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
        require($.status === $.fresh, 'exists'),
        set('status', $.authorizing),
        set('total', $.amount),
        set('requests', 1),
        emit('authorizeCard', { amount: $.amount }),
      ], ['amount']),
      on('TimedOut', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        when($.requests < 3,
          [set('requests', $.requests + 1), emit('authorizeCard', { amount: $.total })],
          [set('status', $.failed)]),
      ]),
      on('Approved', ($) => [require($.status === $.authorizing, 'not-authorizing'), set('status', $.authorized)]),
      on('Declined', ($) => [require($.status === $.authorizing, 'not-authorizing'), set('status', $.declined)]),
      on('Capture', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        require($.amount <= $.total, 'exceeds-authorized'),
        set('status', $.captured),
        set('taken', $.amount),
      ], ['amount']),
      on('Void', ($) => [require($.status === $.authorized, 'not-authorized'), set('status', $.voided)]),
      on('Increase', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        require($.total < 3, 'at-most-three'),
        set('total', $.total + 1),
      ]),
      on('Refund',($) => [
        require($.status === $.captured, 'not-captured'),
        require($.returned + $.amount <= $.taken, 'exceeds-captured'),
        set('returned', $.returned + $.amount),
        when($.returned + $.amount === $.taken, [set('status', $.refunded)]),
      ], ['amount']),
      effect('authorizeCard', { amount: t.int }, [
        kind('card.authorize'),
        labels(['egress:external']),
        cls('irreversible'),
        ok('Approved', []),
        failed('Declined', []),
      ]),
      invariant('captured-within-authorized', ($) => $.taken <= $.total),
      invariant('refunded-within-captured', ($) => $.returned <= $.taken),
      invariant('voided-captured-nothing', ($) => implies($.status === $.voided, $.taken === 0)),
      pathProperty('at-most-three-requests', () => count('card.authorize') <= 3),
    ],
  }),
]);
