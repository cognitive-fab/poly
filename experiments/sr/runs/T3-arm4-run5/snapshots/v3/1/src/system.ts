// Card payments: one Payment machine per payment id, created by authorize.
// The amount fields are named apart from the status names (authorized, captured, refunded); the map renames them.
import {
  module, enumType, machine, field, t, action, on, require, set, emit, when, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('payments', [
  enumType('Status', ['fresh', 'authorizing', 'authorized', 'declined', 'failed', 'captured', 'voided', 'refunded', 'expired']),
  machine('Payment', {
    state: {
      status: field(t.named('Status'), ($) => $.fresh),
      held: field(t.range(0, 3), () => 0),
      taken: field(t.range(0, 3), () => 0),
      returned: field(t.range(0, 3), () => 0),
      requests: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, [$.declined, $.failed, $.voided, $.refunded, $.expired])),
      action('Authorize', { amount: t.range(1, 2) }),
      action('TimedOut', {}),
      action('Capture', { amount: t.range(1, 3) }),
      action('Void', {}),
      action('Increase', {}),
      action('Expire', {}),
      action('Refund', { amount: t.range(1, 2) }),
      action('Approved', {}),
      action('Declined', {}),
      on('Authorize', ($) => [
        require($.status === $.fresh, 'payment-exists'),
        set('status', $.authorizing),
        set('held', $.amount),
        set('requests', 1),
        emit('authorize', { amount: $.amount }),
      ], ['amount']),
      // A timeout re-sends the request, until 3 were sent; the earlier requests stay pending.
      on('TimedOut', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        when($.requests >= 3, [set('status', $.failed)], [
          set('requests', $.requests + 1),
          emit('authorize', { amount: $.held }),
        ]),
      ]),
      on('Capture', ($) => [
        // A first capture, or a further part of a captured payment from which nothing was refunded.
        require($.status === $.authorized || ($.status === $.captured && $.returned === 0), 'not-capturable'),
        require($.taken + $.amount <= $.held, 'exceeds-authorized'),
        set('status', $.captured),
        set('taken', $.taken + $.amount),
      ], ['amount']),
      on('Void', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        set('status', $.voided),
      ]),
      // An authorized, uncaptured payment raises its authorised amount by 1, up to 3.
      on('Increase', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        require($.held < 3, 'at-maximum'),
        set('held', $.held + 1),
      ]),
      // The hold on an authorized, uncaptured payment lapsed: it accepts no further command.
      on('Expire', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        set('status', $.expired),
      ]),
      on('Refund',($) => [
        require($.status === $.captured, 'not-captured'),
        require($.returned + $.amount <= $.taken, 'exceeds-captured'),
        set('returned', $.returned + $.amount),
        when($.returned + $.amount === $.taken, [set('status', $.refunded)]),
      ], ['amount']),
      // The provider's answers: the first decides, a later one finds the payment no longer authorizing.
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
      invariant('captured-within-authorized', ($) => $.taken <= $.held),
      invariant('refunded-within-captured', ($) => $.returned <= $.taken),
      invariant('voided-captured-nothing', ($) => implies($.status === $.voided, $.taken === 0)),
      invariant('expired-captured-nothing', ($) => implies($.status === $.expired, $.taken === 0)),
      invariant('requests-bounded', ($) => $.requests <= 3),
      pathProperty('at-most-three-requests', () => count('card.authorize') <= 3),
    ],
  }),
]);
