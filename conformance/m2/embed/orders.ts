// The orders example, written by hand in poly's embedded surface (PT2.5, S71). Its twin is
// examples/orders/orders.poly: the two give one AST digest and one verdict.
import {
  module, enumType, machine, field, t, action, on, require, set, emit, effect, kind, labels, cls, retry, ok, failed,
  exhausted, terminal, invariant, stepProperty, rejectProperty, pathProperty, implies, isIn, rejected, count,
} from '@cognitive-fab/poly/embed';

export default module('orders', [
  enumType('Status', ['Draft', 'Placed', 'Paid', 'Shipped', 'Cancelled']),
  enumType('Reason', ['Customer', 'Fraud']),
  machine('Order', {
    version: 1,
    state: {
      status: field(t.named('Status'), ($) => $.Draft),
      items: field(t.range(0, 3), () => 0),
      paid: field(t.bool, () => false),
    },
    items: [
      terminal(($) => isIn($.status, [$.Shipped, $.Cancelled])),
      action('AddItem', {}),
      action('Place', {}),
      action('Pay', { amount: t.int.check([10, 20]) }),
      action('PaymentOk', {}),
      action('PaymentFailed', { code: t.string.check(['declined', 'exhausted', 'denied']) }),
      action('Ship', {}),
      action('Cancel', { reason: t.named('Reason') }),
      on('AddItem', ($) => [require($.status === $.Draft, 'not-draft'), set('items', $.items + 1)]),
      on('Place', ($) => [
        require($.status === $.Draft, 'not-draft'),
        require($.items > 0, 'empty-order'),
        set('status', $.Placed),
      ]),
      on('Pay', ($) => [require($.status === $.Placed, 'not-placed'), emit('charge', [$.amount])], ['amount']),
      on('PaymentOk', ($) => [require($.status === $.Placed, 'not-placed'), set('status', $.Paid), set('paid', true)]),
      on('PaymentFailed', ($) => [require($.status === $.Placed, 'not-placed'), set('status', $.Cancelled)], ['code']),
      on('Ship', ($) => [require($.status === $.Paid, 'not-paid'), set('status', $.Shipped)]),
      on('Cancel', ($) => [require(isIn($.status, [$.Draft, $.Placed]), 'too-late'), set('status', $.Cancelled)], ['reason']),
      invariant('shipped-was-paid', ($) => implies($.status === $.Shipped, $.paid)),
      stepProperty('cancel-is-final', ($) => implies($.pre.status === $.Cancelled, $.post.status === $.Cancelled)),
      rejectProperty('place-empty', ($) =>
        implies($.action === $.Place && $.pre.status === $.Draft && $.pre.items === 0, rejected('empty-order'))),
      effect('charge', { amount: t.int }, [
        kind('payment.charge'),
        labels(['egress:external']),
        cls('irreversible'),
        retry(3, '200ms', '5s'),
        ok('PaymentOk', []),
        failed('PaymentFailed', { code: 'declined' }),
        exhausted('PaymentFailed', { code: 'exhausted' }),
      ]),
      pathProperty('charge-at-most-once', () => count('payment.charge') <= 1),
    ],
  }),
]);
