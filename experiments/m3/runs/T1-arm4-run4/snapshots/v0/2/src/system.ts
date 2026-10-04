// T1, order lifecycle: one Order machine per order id, created by the host's create(order).
import {
  module, enumType, machine, field, t, action, on, require, set, emit, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('shop', [
  enumType('Status', ['fresh', 'draft', 'placed', 'paid', 'shipped', 'cancelled', 'failed']),
  machine('Order', {
    state: {
      status: field(t.named('Status'), ($) => $.fresh),
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
      on('Create', ($) => [require($.status === $.fresh, 'exists'), set('status', $.draft)]),
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
        require(isIn($.status, [$.draft, $.paid]), 'not-cancellable'),
        set('status', $.cancelled),
        when($.status === $.paid, [set('refunds', $.refunds + 1), emit('refund', { amount: $.items })]),
      ]),
      on('ChargeOk', ($) => [require($.status === $.placed, 'not-placed'), set('status', $.paid)]),
      on('ChargeFailed', ($) => [require($.status === $.placed, 'not-placed'), set('status', $.failed)]),
      effect('charge', { amount: t.range(1, 3) }, [
        kind('payment.charge'),
        labels(['egress:external']),
        cls('irreversible'),
        ok('ChargeOk', []),
        failed('ChargeFailed', []),
      ]),
      effect('refund', { amount: t.range(1, 3) }, [
        kind('payment.refund'),
        labels(['egress:external']),
        cls('irreversible'),
      ]),
      invariant('charged-unless-draft', ($) => implies($.status !== $.draft && $.status !== $.fresh && $.status !== $.cancelled, $.charges === 1)),
      invariant('refunded-only-when-cancelled', ($) => implies($.refunds === 1, $.status === $.cancelled && $.charges === 1)),
      pathProperty('charge-at-most-once', () => count('payment.charge') <= 1),
      pathProperty('refund-at-most-once', () => count('payment.refund') <= 1),
      pathProperty('refund-after-charge', () => before('payment.charge', 'payment.refund')),
    ],
  }),
]);
