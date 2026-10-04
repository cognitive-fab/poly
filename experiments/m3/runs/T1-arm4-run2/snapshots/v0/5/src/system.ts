// T1, order lifecycle: one Order machine per order id, created by `create`.
// The status members are spelled as the host interface reports them.
import {
  module, enumType, machine, field, t, action, on, require, set, when, emit, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('orders', [
  enumType('Status', ['new', 'draft', 'placed', 'paid', 'shipped', 'cancelled', 'failed']),
  machine('Order', {
    state: {
      status: field(t.named('Status'), ($) => $.new),
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
      on('Create', ($) => [require($.status === $.new, 'order-exists'), set('status', $.draft)]),
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
      // The provider's answer: it changes the order only while the order is placed.
      on('ChargeOk', ($) => [require($.status === $.placed, 'not-placed'), set('status', $.paid)]),
      on('ChargeFailed', ($) => [require($.status === $.placed, 'not-placed'), set('status', $.failed)]),
      on('Ship', ($) => [require($.status === $.paid, 'not-paid'), set('status', $.shipped)]),
      // A draft is cancelled outright; a paid order is cancelled and refunded once.
      on('Cancel', ($) => [
        require(isIn($.status, [$.draft, $.paid]), 'not-cancellable'),
        require($.refunds === 0, 'already-refunded'),
        set('status', $.cancelled),
        when($.status === $.paid, [set('refunds', $.refunds + 1), emit('refund', { amount: $.items })]),
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
        ok('RefundAnswered', []),
        failed('RefundAnswered', []),
      ]),
      invariant('charged-at-most-once', ($) => $.charges <= 1),
      invariant('refunded-only-when-cancelled-after-charge', ($) => implies($.refunds === 1, $.charges === 1 && $.status === $.cancelled)),
      invariant('draft-uncharged', ($) => implies(isIn($.status, [$.new, $.draft]), $.charges === 0)),
      invariant('charged-has-items', ($) => implies($.charges === 1, $.items > 0)),
      pathProperty('charge-at-most-once', () => count('payment.charge') <= 1),
      pathProperty('refund-at-most-once', () => count('payment.refund') <= 1),
    ],
  }),
]);
