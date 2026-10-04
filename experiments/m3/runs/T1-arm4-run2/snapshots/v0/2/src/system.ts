// T1, order lifecycle: one Order machine per order id, created by `create`.
import {
  module, enumType, machine, field, t, action, on, require, set, when, emit, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('orders', [
  enumType('Status', ['New', 'Draft', 'Placed', 'Paid', 'Shipped', 'Cancelled', 'Failed']),
  machine('Order', {
    state: {
      status: field(t.named('Status'), ($) => $.New),
      items: field(t.range(0, 3), () => 0),
      charges: field(t.range(0, 1), () => 0),
      refunds: field(t.range(0, 1), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, [$.Shipped, $.Cancelled, $.Failed])),
      action('Create', {}),
      action('AddItem', {}),
      action('RemoveItem', {}),
      action('Place', {}),
      action('Ship', {}),
      action('Cancel', {}),
      action('ChargeOk', {}),
      action('ChargeFailed', {}),
      on('Create', ($) => [require($.status === $.New, 'order-exists'), set('status', $.Draft)]),
      on('AddItem', ($) => [
        require($.status === $.Draft, 'not-draft'),
        require($.items < 3, 'order-full'),
        set('items', $.items + 1),
      ]),
      on('RemoveItem', ($) => [
        require($.status === $.Draft, 'not-draft'),
        require($.items > 0, 'order-empty'),
        set('items', $.items - 1),
      ]),
      on('Place', ($) => [
        require($.status === $.Draft, 'not-draft'),
        require($.items > 0, 'order-empty'),
        require($.charges === 0, 'already-charged'),
        set('status', $.Placed),
        set('charges', $.charges + 1),
        emit('charge', { amount: $.items }),
      ]),
      // The provider's answer: it changes the order only while the order is placed.
      on('ChargeOk', ($) => [require($.status === $.Placed, 'not-placed'), set('status', $.Paid)]),
      on('ChargeFailed', ($) => [require($.status === $.Placed, 'not-placed'), set('status', $.Failed)]),
      on('Ship', ($) => [require($.status === $.Paid, 'not-paid'), set('status', $.Shipped)]),
      // A draft is cancelled outright; a paid order is cancelled and refunded once.
      on('Cancel', ($) => [
        require(isIn($.status, [$.Draft, $.Paid]), 'not-cancellable'),
        require($.refunds === 0, 'already-refunded'),
        set('status', $.Cancelled),
        when($.status === $.Paid, [set('refunds', $.refunds + 1), emit('refund', { amount: $.items })]),
      ]),
      effect('charge', { amount: t.int }, [
        kind('payment.charge'),
        labels(['egress:external']),
        cls('irreversible'),
        ok('ChargeOk', []),
        failed('ChargeFailed', []),
      ]),
      effect('refund', { amount: t.int }, [
        kind('payment.refund'),
        labels(['egress:external']),
        cls('irreversible'),
      ]),
      invariant('charged-at-most-once', ($) => $.charges <= 1),
      invariant('refunded-only-when-cancelled-after-charge', ($) => implies($.refunds === 1, $.charges === 1 && $.status === $.Cancelled)),
      invariant('draft-uncharged', ($) => implies(isIn($.status, [$.New, $.Draft]), $.charges === 0)),
      invariant('charged-has-items', ($) => implies($.charges === 1, $.items > 0)),
      pathProperty('charge-at-most-once', () => count('payment.charge') <= 1),
      pathProperty('refund-at-most-once', () => count('payment.refund') <= 1),
    ],
  }),
]);
