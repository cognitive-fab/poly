// T1, order lifecycle: one Order machine per order id, created by `create`.
// The status members are spelled as the host interface reports them.
import {
  module, enumType, machine, field, t, action, on, require, reject, set, when, emit, effect, kind, labels, cls, ok, failed,
  terminal, invariant, pathProperty, implies, isIn, count,
} from '@cognitive-fab/poly/embed';

export default module('orders', [
  enumType('Status', ['new', 'draft', 'placed', 'paid', 'shipped', 'cancelling', 'cancelled', 'declined', 'failed']),
  machine('Order', {
    state: {
      status: field(t.named('Status'), ($) => $.new),
      items: field(t.range(0, 3), () => 0),
      charges: field(t.range(0, 2), () => 0),
      refunds: field(t.range(0, 1), () => 0),
      held: field(t.bool, () => false),
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
      action('RefundAnswered', {}),
      action('RetryPayment', {}),
      action('Hold', {}),
      action('Release', {}),
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
      // The provider's answer: it changes the order only while the order is placed or cancelling.
      // A charge that went through for a cancelling order is refunded at once.
      on('ChargeOk', ($) => [
        require(isIn($.status, [$.placed, $.cancelling]), 'not-placed'),
        when($.status === $.placed, [set('status', $.paid)], [
          require($.refunds === 0, 'already-refunded'),
          set('status', $.cancelled),
          set('refunds', $.refunds + 1),
          emit('refund', { amount: $.items }),
        ]),
      ]),
      // The first charge declined can be retried once; the second declined fails the order.
      // A declined charge for a cancelling order took nothing, so it is cancelled without refund.
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
      // A refund needs no answer: whatever the provider says, the order is unchanged.
      on('RefundAnswered', () => [reject('refund-needs-no-answer')]),
      on('Ship', ($) => [
        require($.status === $.paid, 'not-paid'),
        require(!$.held, 'held'),
        set('status', $.shipped),
      ]),
      // The warehouse holds a paid order back from shipping, and releases it.
      on('Hold', ($) => [require($.status === $.paid, 'not-paid'), require(!$.held, 'already-held'), set('held', true)]),
      on('Release', ($) => [require($.held, 'not-held'), set('held', false)]),
      // A draft is cancelled outright; a paid order is cancelled and refunded once; a placed order
      // is cancelling until the provider answers its charge.
      on('Cancel', ($) => [
        require(isIn($.status, [$.draft, $.placed, $.paid]), 'not-cancellable'),
        require($.refunds === 0, 'already-refunded'),
        when($.status === $.placed, [set('status', $.cancelling)], [
          set('status', $.cancelled),
          set('held', false),
          when($.status === $.paid, [set('refunds', $.refunds + 1), emit('refund', { amount: $.items })]),
        ]),
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
      invariant('held-only-when-paid', ($) => implies($.held, $.status === $.paid)),
      invariant('charged-at-most-twice', ($) => $.charges <= 2),
      invariant('refunded-only-when-cancelled-after-charge', ($) => implies($.refunds === 1, $.charges >= 1 && $.status === $.cancelled)),
      invariant('draft-uncharged', ($) => implies(isIn($.status, [$.new, $.draft]), $.charges === 0)),
      invariant('charged-has-items', ($) => implies($.charges >= 1, $.items > 0)),
      invariant('declined-after-first-charge', ($) => implies($.status === $.declined, $.charges === 1)),
      pathProperty('charge-at-most-twice', () => count('payment.charge') <= 2),
      pathProperty('refund-at-most-once', () => count('payment.refund') <= 1),
    ],
  }),
]);
