// The order lifecycle (T1): one Order machine per order id, charged through the payment provider.
import {
  module, enumType, machine, field, t, action, on, require, set, when, emit, effect, kind, labels, cls, ok, failed,
  terminal, invariant, stepProperty, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('shop', [
  enumType('Status', ['unborn', 'draft', 'placed', 'paid', 'shipped', 'cancelled', 'failed']),
  machine('Order', {
    state: {
      status: field(t.named('Status'), ($) => $.unborn),
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
      on('Create', ($) => [require($.status === $.unborn, 'exists'), set('status', $.draft)]),
      on('AddItem', ($) => [
        require($.status === $.draft, 'not-draft'),
        require($.items < 3, 'cart-full'),
        set('items', $.items + 1),
      ]),
      on('RemoveItem', ($) => [
        require($.status === $.draft, 'not-draft'),
        require($.items > 0, 'empty-order'),
        set('items', $.items - 1),
      ]),
      on('Place', ($) => [
        require($.status === $.draft, 'not-draft'),
        require($.items > 0, 'empty-order'),
        require($.charges === 0, 'already-charged'),
        set('status', $.placed),
        set('charges', $.charges + 1),
        emit('charge', { amount: $.items }),
      ]),
      on('ChargeOk', ($) => [require($.status === $.placed, 'not-placed'), set('status', $.paid)]),
      on('ChargeFailed', ($) => [require($.status === $.placed, 'not-placed'), set('status', $.failed)]),
      on('Ship', ($) => [require($.status === $.paid, 'not-paid'), set('status', $.shipped)]),
      on('Cancel', ($) => [
        require(isIn($.status, [$.draft, $.paid]), 'not-cancellable'),
        require($.refunds === 0, 'already-refunded'),
        set('status', $.cancelled),
        // A refund is requested only when the order was paid.
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
      ]),
      invariant('shipped-was-charged', ($) => implies($.status === $.shipped, $.charges === 1)),
      invariant('draft-uncharged', ($) => implies($.status === $.draft, $.charges === 0)),
      stepProperty('ship-only-when-paid', ($) => implies($.post.status === $.shipped, $.pre.status === $.paid || $.pre.status === $.shipped)),
      pathProperty('charge-at-most-once', () => count('payment.charge') <= 1),
    ],
  }),
]);
