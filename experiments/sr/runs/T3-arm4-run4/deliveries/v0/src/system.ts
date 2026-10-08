// Card payments (T3): one Payment machine per payment id, created by authorize. Status members share names
// with the amount fields, so they are always written qualified, $.Status.x (S22).
import {
  module, enumType, machine, field, t, action, on, require, set, when, emit, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('payments', [
  enumType('Status', ['fresh', 'authorizing', 'authorized', 'declined', 'failed', 'captured', 'voided', 'refunded']),
  machine('Payment', {
    state: {
      status: field(t.named('Status'), ($) => $.Status.fresh),
      authorized: field(t.range(0, 2), () => 0),
      captured: field(t.range(0, 2), () => 0),
      refunded: field(t.range(0, 2), () => 0),
      requests: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, [$.Status.declined, $.Status.failed, $.Status.voided, $.Status.refunded])),
      action('Authorize', { amount: t.int.check([1, 2]) }),
      action('TimedOut', {}),
      action('Approved', {}),
      action('Declined', {}),
      action('Capture', { amount: t.int.check([1, 2]) }),
      action('Void', {}),
      action('Refund', { amount: t.int.check([1, 2]) }),
      on('Authorize', ($) => [
        require($.status === $.Status.fresh, 'payment-exists'),
        set('status', $.Status.authorizing),
        set('authorized', $.amount),
        set('requests', 1),
        emit('authorize', { amount: $.amount }),
      ], ['amount']),
      on('TimedOut', ($) => [
        require($.status === $.Status.authorizing, 'not-authorizing'),
        when($.requests < 3,
          [set('requests', $.requests + 1), emit('authorize', { amount: $.authorized })],
          [set('status', $.Status.failed)]),
      ]),
      on('Approved', ($) => [
        require($.status === $.Status.authorizing, 'not-authorizing'),
        set('status', $.Status.authorized),
      ]),
      on('Declined', ($) => [
        require($.status === $.Status.authorizing, 'not-authorizing'),
        set('status', $.Status.declined),
      ]),
      on('Capture', ($) => [
        require($.status === $.Status.authorized, 'not-authorized'),
        require($.amount <= $.authorized, 'exceeds-authorized'),
        set('captured', $.amount),
        set('status', $.Status.captured),
      ], ['amount']),
      on('Void', ($) => [
        require($.status === $.Status.authorized, 'not-authorized'),
        set('status', $.Status.voided),
      ]),
      on('Refund', ($) => [
        require($.status === $.Status.captured, 'not-captured'),
        require($.refunded + $.amount <= $.captured, 'exceeds-captured'),
        set('refunded', $.refunded + $.amount),
        when($.refunded + $.amount === $.captured, [set('status', $.Status.refunded)]),
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
      invariant('voided-captured-nothing', ($) => implies($.status === $.Status.voided, $.captured === 0)),
      invariant('requests-bounded', ($) => $.requests <= 3),
      pathProperty('at-most-three-requests', () => count('card.authorize') <= 3),
    ],
  }),
]);
