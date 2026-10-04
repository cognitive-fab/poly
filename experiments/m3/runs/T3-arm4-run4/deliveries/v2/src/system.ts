// Card payments (T3): one Payment machine per payment id, created by authorize.
// Status members are named as the host interface shows them, so the amount fields carry other names
// (held, taken, returned) and host.map.json renames them for the query.
import {
  module, enumType, machine, field, t, action, on, require, set, when, emit, effect, kind, labels, cls,
  ok, failed, terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('payments', [
  enumType('Status', ['idle', 'authorizing', 'authorized', 'declined', 'failed', 'captured', 'voided', 'refunded', 'expired']),
  machine('Payment', {
    state: {
      status: field(t.named('Status'), ($) => $.idle),
      held: field(t.range(0, 3), () => 0),
      taken: field(t.range(0, 3), () => 0),
      returned: field(t.range(0, 3), () => 0),
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
        set('held', $.amount),
        set('requests', 1),
        emit('authorize', { amount: $.amount }),
      ], ['amount']),
      // The provider did not answer: ask again, unless 3 requests were already sent.
      on('TimedOut', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        when($.requests >= 3,
          [set('status', $.failed)],
          [set('requests', $.requests + 1), emit('authorize', { amount: $.held })]),
      ]),
      // The first answer decides; a later one finds the payment no longer authorizing and is refused.
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
        require($.amount <= $.held, 'exceeds-authorized'),
        set('status', $.captured),
        set('taken', $.amount),
      ], ['amount']),
      on('Void', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        set('status', $.voided),
      ]),
      // An authorized, uncaptured payment raises its hold by 1 unit, up to 3.
      on('Increase', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        require($.held < 3, 'at-maximum'),
        set('held', $.held + 1),
      ]),
      // The provider reports the hold lapsed: only an authorized, uncaptured payment expires.
      on('Expire', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        set('status', $.expired),
      ]),
      on('Refund', ($) => [
        require($.status === $.captured, 'not-captured'),
        require($.returned + $.amount <= $.taken, 'exceeds-captured'),
        set('returned', $.returned + $.amount),
        when($.returned + $.amount === $.taken, [set('status', $.refunded)]),
      ], ['amount']),
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
