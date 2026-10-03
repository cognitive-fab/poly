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
        when_paid($),
      ]).flat ? undefined as never : undefined as never,
    ],
  }),
]);
