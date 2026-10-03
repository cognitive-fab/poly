// The order lifecycle (T1): one Order instance per order id, created by Create.
import {
  module, enumType, machine, field, t, action, on, require, set, emit, effect, kind, labels, cls, ok, failed,
  terminal, when, invariant, stepProperty, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('shop', [
  enumType('Status', ['absent', 'draft', 'placed', 'paid', 'shipped', 'cancelled', 'failed']),
  machine('Order', {
    state: {
      status: field(t.named('Status'), ($) => $.absent),
      items: field(t.range(0, 3), () => 0),
      charges: field(t.range(0, 1), () => 0),
      refunds: field(t.range(0, 1), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, [$.shipped, $.cancelled, $.failed])),
      action('Create', {}),
      action('AddItem', {}),
      action('RemoveItem', {}),
      action('Place', {}),
      action('Ship', {}),
      action('Cancel', {}),
      action('ChargeOk', {}),
      action('ChargeFailed', {}),
      on('Create', ($) => [require($.status === $.absent, 'exists'), set('status', $.draft)]),
      on('AddItem', ($) => [
        require($.status === $.draft, 'not-draft'),
        require($.items < 3, 'order-full'),
        set('items', $.items + 1),
      ]),
      on('RemoveItem', ($) => [
        require($.status === $.draft, 'not-draft'),
        require($.items > 0, 'order-empty'),
        set('items', $.items - 1),
      ]),
      on('Place', ($) => [
        require($.status === $.draft, 'not-draft'),
        require($.items > 0, 'order-empty'),
        require($.charges === 0, 'already-charged'),
        set('status', $.placed),
        set('charges', $.charges + 1),
        emit('charge', { amount: $.items }),
      ]),
      on('Ship', ($) => [require($.status === $.paid, 'not-paid'), set('status', $.shipped)]),
      on('Cancel', ($) => [
        require(isIn($.status, [$.draft, $.paid]), 'cannot-cancel'),
        require($.refunds === 0, 'already-refunded'),
        set('status', $.cancelled),
        when($.status === $.paid, [set('refunds', $.refunds + 1), emit('refund', { amount: $.items })]),
      ]),
      on('ChargeOk', ($) => [require($.status === $.placed, 'not-placed'), set('status', $.paid)]),
      // The first declined charge may be retried once; the second is final.
      on('ChargeFailed', ($) => [
        require($.status === $.placed, 'not-placed'),
        when($.charges === 1, [set('status', $.declined)], [set('status', $.failed)]),
      ]),
      on('RetryPayment', ($) => [
        require($.status === $.declined, 'not-declined'),
        require($.charges === 1, 'already-retried'),
        set('status', $.placed),
        set('charges', $.charges + 1),
        emit('charge', { amount: $.items }),
      ]),
      effect('charge', { amount: t.int }, [
        kind('payment.charge'),
        labels(['egress:external']),
        cls('irreversible'),
        ok('ChargeOk', {}),
        failed('ChargeFailed', {}),
      ]),
      effect('refund', { amount: t.int }, [
        kind('payment.refund'),
        labels(['egress:external']),
        cls('irreversible'),
      ]),
      invariant('charged-once', ($) => $.charges <= 1),
      invariant('paid-was-charged', ($) => implies(isIn($.status, [$.placed, $.paid, $.shipped, $.failed]), $.charges === 1)),
      invariant('refund-only-after-pay', ($) => implies($.refunds === 1, $.status === $.cancelled && $.charges === 1)),
      stepProperty('ships-only-when-paid', ($) => implies($.post.status === $.shipped, $.pre.status === $.paid || $.pre.status === $.shipped)),
      pathProperty('charge-at-most-once', () => count('payment.charge') <= 1),
      pathProperty('refund-at-most-once', () => count('payment.refund') <= 1),
    ],
  }),
]);
