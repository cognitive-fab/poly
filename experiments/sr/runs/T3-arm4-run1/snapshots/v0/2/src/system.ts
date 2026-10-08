// Card payments (T3): one Payment machine per payment id.
import {
  module, enumType, machine, field, t, action, on, require, set, when, emit, effect, kind, labels, cls, retry,
  ok, failed, terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('payments', [
  enumType('Status', ['authorizing', 'authorized', 'declined', 'failed', 'captured', 'voided', 'refunded']),
  machine('Payment', {
    state: {
      status: field(t.named('Status'), ($) => $.authorizing),
      authorized: field(t.range(0, 2), () => 0),
      captured: field(t.range(0, 2), () => 0),
      refunded: field(t.range(0, 2), () => 0),
      requests: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, [$.declined, $.failed, $.voided, $.refunded])),
      action('Authorize', { amount: t.int.check([1, 2]) }),
      action('TimedOut', {}),
      action('Approved', {}),
      action('Declined', {}),
      action('Capture', { amount: t.int.check([1, 2]) }),
      action('Void', {}),
      action('Refund', { amount: t.int.check([1, 2]) }),
      // Creation: the adapter makes a fresh instance and dispatches Authorize to it; a second one is refused.
      on('Authorize', ($) => [
        require($.requests === 0, 'exists'),
        set('authorized', $.amount),
        set('requests', 1),
        emit('cardAuthorize', { amount: $.amount }),
      ], ['amount']),
      on('TimedOut', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        when($.requests >= 3,
          [set('status', $.failed)],
          [set('requests', $.requests + 1), emit('cardAuthorize', { amount: $.authorized })]),
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
        require($.amount <= $.authorized, 'exceeds-authorized'),
        set('captured', $.amount),
        set('status', $.captured),
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
      effect('cardAuthorize', { amount: t.int }, [
        kind('card.authorize'),
        labels(['egress:external']),
        cls('reversible'),
        retry(1, '100ms', '2s'),
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
