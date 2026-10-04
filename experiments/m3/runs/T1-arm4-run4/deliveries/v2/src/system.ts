// T1, order lifecycle: one Order machine per order id, created by the host's create(order).
import {
  module, enumType, machine, field, t, action, on, require, set, emit, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count, before, when,
} from '@cognitive-fab/poly/embed';

export default module('shop', [
  enumType('Status', ['fresh', 'draft', 'placed', 'paid', 'shipped', 'cancelling', 'cancelled', 'declined', 'failed']),
  machine('Order', {
    state: {
      status: field(t.named('Status'), ($) => $.fresh),
      items: field(t.range(0, 3), () => 0),
      charges: field(t.range(0, 2), () => 0),
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
      action('RetryPayment', {}),
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
        require(isIn($.status, [$.draft, $.placed, $.paid]), 'not-cancellable'),
        // A placed order waits for the provider's answer before it is cancelled.
        when($.status === $.placed, [set('status', $.cancelling)], [
          set('status', $.cancelled),
          when($.status === $.paid, [set('refunds', $.refunds + 1), emit('refund', { amount: $.items })]),
        ]),
      ]),
      // A charge that went through on a cancelling order is returned.
      on('ChargeOk', ($) => [
        require(isIn($.status, [$.placed, $.cancelling]), 'not-placed'),
        when($.status === $.placed, [set('status', $.paid)], [
          set('status', $.cancelled),
          set('refunds', $.refunds + 1),
          emit('refund', { amount: $.items }),
        ]),
      ]),
      // The first charge declined leaves one retry; the second declined fails the order.
      on('ChargeFailed', ($) => [
        require(isIn($.status, [$.placed, $.cancelling]), 'not-placed'),
        when($.status === $.cancelling, [set('status', $.cancelled)], [
          when($.charges === 1, [set('status', $.declined)], [set('status', $.failed)]),
        ]),
      ]),
      on('RetryPayment', ($) => [
        require($.status === $.declined, 'not-declined'),
        require($.charges === 1, 'already-retried'),
        set('status', $.placed),
        set('charges', $.charges + 1),
        emit('charge', { amount: $.items }),
      ]),
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
      invariant('charged-unless-draft', ($) => implies($.status !== $.draft && $.status !== $.fresh && $.status !== $.cancelled, $.charges >= 1)),
      invariant('declined-after-first-charge', ($) => implies($.status === $.declined, $.charges === 1)),
      invariant('failed-after-last-charge', ($) => implies($.status === $.failed, $.charges === 2)),
      invariant('refunded-only-when-cancelled', ($) => implies($.refunds === 1, $.status === $.cancelled && $.charges >= 1)),
      pathProperty('charge-at-most-twice', () => count('payment.charge') <= 2),
      pathProperty('refund-at-most-once', () => count('payment.refund') <= 1),
      pathProperty('refund-after-charge', () => before('payment.charge', 'payment.refund')),
    ],
  }),
]);
