// Card payments (T3): one Payment machine per payment id, created by authorize.
// Status members are lower case because the query returns them verbatim; the amount fields carry another
// name so they do not hide the members of the same name (host.map.json renames them back).
import {
  module, enumType, machine, field, t, action, on, require, set, emit, when, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('payments', [
  enumType('Status', ['fresh', 'authorizing', 'authorized', 'declined', 'failed', 'captured', 'voided', 'refunded', 'expired']),
  machine('Payment', {
    state: {
      status: field(t.named('Status'), ($) => $.fresh),
      amountAuthorized: field(t.range(0, 3), () => 0),
      amountCaptured: field(t.range(0, 3), () => 0),
      amountRefunded: field(t.range(0, 3), () => 0),
      requests: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, [$.declined, $.failed, $.voided, $.refunded, $.expired])),
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
        require($.status === $.fresh, 'payment-exists'),
        set('status', $.authorizing),
        set('amountAuthorized', $.amount),
        set('requests', 1),
        emit('authorize', { amount: $.amount }),
      ], ['amount']),
      // The provider did not answer in time: ask again, up to 3 requests in all, then give up.
      on('TimedOut', ($) => [
        require($.status === $.authorizing, 'not-authorizing'),
        when($.requests < 3,
          [set('requests', $.requests + 1), emit('authorize', { amount: $.amountAuthorized })],
          [set('status', $.failed)]),
      ]),
      // The first answer decides; a later one finds the payment no longer authorizing.
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
        require($.amount <= $.amountAuthorized, 'exceeds-authorized'),
        set('status', $.captured),
        set('amountCaptured', $.amount),
      ], ['amount']),
      on('Void', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        set('status', $.voided),
      ]),
      // The provider reports that the hold lapsed; a captured payment does not expire.
      on('Expire', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        set('status', $.expired),
      ]),
      // The customer added to the order before capture: hold one more unit, up to 3.
      on('Increase', ($) => [
        require($.status === $.authorized, 'not-authorized'),
        require($.amountAuthorized < 3, 'at-most-three'),
        set('amountAuthorized', $.amountAuthorized + 1),
      ]),
      on('Refund', ($) => [
        require($.status === $.captured, 'not-captured'),
        require($.amountRefunded + $.amount <= $.amountCaptured, 'exceeds-captured'),
        set('amountRefunded', $.amountRefunded + $.amount),
        when($.amountRefunded + $.amount === $.amountCaptured, [set('status', $.refunded)]),
      ], ['amount']),
      effect('authorize', { amount: t.int }, [
        kind('card.authorize'),
        labels(['egress:external']),
        cls('compensable'),
        ok('Approved', {}),
        failed('Declined', {}),
      ]),
      invariant('captured-within-authorized', ($) => $.amountCaptured <= $.amountAuthorized),
      invariant('refunded-within-captured', ($) => $.amountRefunded <= $.amountCaptured),
      invariant('voided-captured-nothing', ($) => implies($.status === $.voided, $.amountCaptured === 0)),
      invariant('requests-bounded', ($) => $.requests <= 3),
      pathProperty('at-most-three-requests', () => count('card.authorize') <= 3),
    ],
  }),
]);
