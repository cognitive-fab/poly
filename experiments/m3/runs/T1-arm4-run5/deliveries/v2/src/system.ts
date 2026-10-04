// The order lifecycle (T1): one Order instance per order id, created by the host's create.
import {
  module, enumType, machine, field, t, action, on, require, set, when, emit, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('orders', [
  enumType('Status', ['draft', 'placed', 'paid', 'shipped', 'cancelling', 'cancelled', 'declined', 'failed']),
  machine('Order', {
    state: {
      status: field(t.named('Status'), ($) => $.draft),
      created: field(t.bool, () => false),
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
      action('RetryPayment', {}),
      action('PaymentOk', {}),
      action('PaymentFailed', {}),
      on('Create', ($) => [require(!$.created, 'exists'), set('created', true)]),
      on('AddItem', ($) => [
        require($.created, 'unknown'),
        require($.status === $.draft, 'not-draft'),
        require($.items < 3, 'full'),
        set('items', $.items + 1),
      ]),
      on('RemoveItem', ($) => [
        require($.created, 'unknown'),
        require($.status === $.draft, 'not-draft'),
        require($.items > 0, 'empty'),
        set('items', $.items - 1),
      ]),
      on('Place', ($) => [
        require($.created, 'unknown'),
        require($.status === $.draft, 'not-draft'),
        require($.items > 0, 'empty'),
        require($.charges === 0, 'charged'),
        set('status', $.placed),
        set('charges', $.charges + 1),
        emit('charge', { amount: $.items }),
      ]),
      on('Ship', ($) => [require($.status === $.paid, 'not-paid'), set('status', $.shipped)]),
      on('Cancel', ($) => [
        require($.created, 'unknown'),
        require(isIn($.status, [$.draft, $.placed, $.paid]), 'not-cancellable'),
        require($.refunds === 0, 'refunded'),
        // A placed order waits for the provider's answer; a paid one is refunded at once.
        when($.status === $.placed, [set('status', $.cancelling)], [
          set('status', $.cancelled),
          when($.status === $.paid, [set('refunds', $.refunds + 1), emit('refund', {})]),
        ]),
      ]),
      // A charge that goes through after a cancel is refunded.
      on('PaymentOk', ($) => [
        require(isIn($.status, [$.placed, $.cancelling]), 'not-placed'),
        when($.status === $.cancelling,
          [set('status', $.cancelled), set('refunds', $.refunds + 1), emit('refund', {})],
          [set('status', $.paid)]),
      ]),
      on('RetryPayment', ($) => [
        require($.status === $.declined, 'not-declined'),
        require($.charges === 1, 'retried'),
        set('status', $.placed),
        set('charges', $.charges + 1),
        emit('charge', { amount: $.items }),
      ]),
      // The first declined charge may be retried once; the second is final.
      on('PaymentFailed', ($) => [
        require(isIn($.status, [$.placed, $.cancelling]), 'not-placed'),
        when($.status === $.cancelling, [set('status', $.cancelled)], [
          when($.charges === 1, [set('status', $.declined)], [set('status', $.failed)]),
        ]),
      ]),
      effect('charge', { amount: t.int }, [
        kind('payment.charge'),
        labels(['egress:external']),
        cls('irreversible'),
        ok('PaymentOk', []),
        failed('PaymentFailed', []),
      ]),
      effect('refund', {}, [
        kind('payment.refund'),
        labels(['egress:external']),
        cls('irreversible'),
      ]),
      invariant('shipped-was-charged', ($) => implies($.status === $.shipped, $.charges >= 1)),
      invariant('declined-once', ($) => implies($.status === $.declined, $.charges === 1)),
      invariant('refund-only-when-cancelled', ($) => implies($.refunds === 1, $.status === $.cancelled && $.charges >= 1)),
      pathProperty('charge-at-most-twice', () => count('payment.charge') <= 2),
      pathProperty('refund-at-most-once', () => count('payment.refund') <= 1),
    ],
  }),
]);
