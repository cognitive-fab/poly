// Card payments: one Payment instance per payment id, created by Authorize. Each authorisation request to the
// card provider is the effect card.authorize; its completion is Approved (ok) or Declined (failed).
import {
  module, machine, field, t, action, on, require, set, when, emit, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('payments', [
  machine('Payment', {
    state: {
      status: field(t.string, () => 'new', { check: ['new', 'authorizing', 'authorized', 'declined', 'failed', 'captured', 'voided', 'refunded', 'expired'] }),
      authorized: field(t.range(0, 3), () => 0),
      captured: field(t.range(0, 3), () => 0),
      refunded: field(t.range(0, 3), () => 0),
      requests: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, ['declined', 'failed', 'voided', 'refunded', 'expired'])),
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
        require($.status === 'new', 'payment-exists'),
        set('status', 'authorizing'),
        set('authorized', $.amount),
        set('requests', 1),
        emit('authorize', { amount: $.amount }),
      ], ['amount']),
      on('TimedOut', ($) => [
        require($.status === 'authorizing', 'not-authorizing'),
        when($.requests >= 3, [set('status', 'failed')], [
          set('requests', $.requests + 1),
          emit('authorize', { amount: $.authorized }),
        ]),
      ]),
      // The first answer decides; a later one finds the payment no longer authorizing and changes nothing.
      on('Approved', ($) => [
        require($.status === 'authorizing', 'not-authorizing'),
        set('status', 'authorized'),
      ]),
      on('Declined', ($) => [
        require($.status === 'authorizing', 'not-authorizing'),
        set('status', 'declined'),
      ]),
      // Capture from an authorized payment, or more of a captured one that has refunded nothing.
      on('Capture', ($) => [
        require($.status === 'authorized' || ($.status === 'captured' && $.refunded === 0), 'not-capturable'),
        require($.captured + $.amount <= $.authorized, 'exceeds-authorized'),
        set('status', 'captured'),
        set('captured', $.captured + $.amount),
      ], ['amount']),
      on('Void', ($) => [
        require($.status === 'authorized', 'not-authorized'),
        set('status', 'voided'),
      ]),
      on('Increase', ($) => [
        require($.status === 'authorized', 'not-authorized'),
        require($.authorized < 3, 'at-maximum'),
        set('authorized', $.authorized + 1),
      ]),
      on('Expire', ($) => [
        require($.status === 'authorized', 'not-authorized'),
        set('status', 'expired'),
      ]),
      on('Refund', ($) => [
        require($.status === 'captured', 'not-captured'),
        require($.refunded + $.amount <= $.captured, 'exceeds-captured'),
        set('refunded', $.refunded + $.amount),
        when($.refunded + $.amount === $.captured, [set('status', 'refunded')]),
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
      invariant('voided-captured-nothing', ($) => implies($.status === 'voided', $.captured === 0)),
      invariant('requests-bounded', ($) => $.requests <= 3),
      pathProperty('at-most-three-requests', () => count('card.authorize') <= 3),
    ],
  }),
]);
